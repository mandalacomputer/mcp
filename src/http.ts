import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { MODEL_KEY_HEADER } from './api.js';
import { createServer, SERVER_NAME, SERVER_VERSION, type ServerConfig } from './server.js';

export type HttpConfig = Omit<ServerConfig, 'apiKey'> & {
  port: number;
  host: string;
  /** Hosts this server will answer to, for DNS-rebinding protection. */
  allowedHosts?: string[];
  allowedOrigins?: string[];
  /** How long an idle session survives before it is swept, in ms. */
  sessionTtlMs?: number;
  /** How many live sessions this server will hold at once. */
  maxSessions?: number;
};

type Live = {
  transport: StreamableHTTPServerTransport;
  /** Not the key. Enough to prove a later request came from the same holder. */
  keyDigest: Buffer;
  lastSeen: number;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * A ceiling on live sessions.
 *
 * An initialize is cheap to send and expensive to serve — it builds a whole
 * McpServer with every tool registered, plus a transport that then survives the
 * TTL. The bearer cannot be checked without a round trip to the platform, so
 * any string gets that far; without a cap, a loop of initializes is a memory
 * exhaustion that costs the sender nothing.
 */
const DEFAULT_MAX_SESSIONS = 256;

/**
 * The hosted install: one URL, and every caller brings their own key.
 *
 * The important property of this server is what it does NOT hold. There is no
 * credential of its own, no store, and no state that outlives a session: a
 * caller's `com_…` key arrives as their own bearer token, is used for their
 * requests, and is never written down. What is kept is a digest of it, so that
 * a later request on the same session can be shown to come from the same
 * holder — a session id on its own is then not enough to drive somebody else's
 * desktop, which it otherwise would be.
 */
export async function runHttp(cfg: HttpConfig): Promise<Server> {
  const app = express();
  app.use(express.json({ limit: '80mb' }));

  const sessions = new Map<string, Live>();
  const ttl = cfg.sessionTtlMs ?? DEFAULT_TTL_MS;
  const maxSessions = cfg.maxSessions ?? DEFAULT_MAX_SESSIONS;

  // Abandoned sessions are closed rather than left holding a transport. A
  // client that goes away without a DELETE is the ordinary case, not the odd
  // one — laptops sleep and tabs close.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - ttl;
    for (const [id, live] of sessions) {
      if (live.lastSeen < cutoff) {
        sessions.delete(id);
        void live.transport.close().catch(() => {});
      }
    }
  }, 60_000);
  sweeper.unref();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, sessions: sessions.size });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const key = bearer(req);

    if (sessionId) {
      const live = sessions.get(sessionId);
      if (!live) return notFound(res, 'Unknown session. Initialize a new one.');
      // The key is re-checked on every request, not only at initialize. A
      // session id travels in a plain header and is the sort of thing that ends
      // up in a proxy log; on its own it must not be a credential.
      if (!key || !sameKey(live.keyDigest, key)) {
        return unauthorized(res, 'This session belongs to a different API key.');
      }
      live.lastSeen = Date.now();
      return live.transport.handleRequest(req, res, req.body);
    }

    if (!isInitializeRequest(req.body)) {
      return badRequest(res, 'No session id, and this is not an initialize request.');
    }
    if (!key) {
      return unauthorized(
        res,
        'Send your Mandala API key as a bearer token: Authorization: Bearer com_…',
      );
    }
    // Swept sessions free their slot on the timer; this is the backstop for the
    // case the timer cannot help with, which is arrivals faster than the TTL.
    if (sessions.size >= maxSessions) {
      return unavailable(
        res,
        `This server is holding its maximum of ${maxSessions} sessions. Retry shortly.`,
      );
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: Boolean(cfg.allowedHosts?.length || cfg.allowedOrigins?.length),
      allowedHosts: cfg.allowedHosts,
      allowedOrigins: cfg.allowedOrigins,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, keyDigest: digest(key), lastSeen: Date.now() });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = createServer({
      ...cfg,
      apiKey: key,
      // Per-caller, and deliberately with no fallback to cfg.modelKey: an
      // operator who set MANDALA_MODEL_KEY for their own stdio use would
      // otherwise be billed for every stranger's run here. Absent means
      // run_agent is simply not offered to this session.
      modelKey: req.header(MODEL_KEY_HEADER),
    });
    await server.connect(transport);
    return transport.handleRequest(req, res, req.body);
  });

  // The server-to-client stream, and session teardown. Both are addressed by
  // session id alone in the protocol, so both re-check the key for the reason
  // the POST does.
  const bySession = async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const live = sessionId ? sessions.get(sessionId) : undefined;
    if (!live) return notFound(res, 'Unknown session.');
    const key = bearer(req);
    if (!key || !sameKey(live.keyDigest, key)) {
      return unauthorized(res, 'This session belongs to a different API key.');
    }
    live.lastSeen = Date.now();
    return live.transport.handleRequest(req, res);
  };
  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);

  return new Promise((resolve, reject) => {
    const http = app.listen(cfg.port, cfg.host, () => {
      console.error(
        `mandala-computer-mcp on http://${cfg.host}:${cfg.port}/mcp — callers authenticate with their own Mandala API key`,
      );
      resolve(http);
    });
    // Without this, an 'error' event on a server nobody is listening to is
    // rethrown as an uncaught exception — a stack trace for EADDRINUSE, the
    // most ordinary operational failure there is, and a promise that never
    // settles. Rejecting instead lets main()'s catch print the one sentence.
    http.on('error', (err) => {
      clearInterval(sweeper);
      reject(err);
    });
    http.on('close', () => clearInterval(sweeper));
  });
}

function bearer(req: Request): string | undefined {
  const auth = req.header('authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() || undefined : undefined;
}

const digest = (key: string) => createHash('sha256').update(key).digest();

/** Constant-time, because this comparison decides whether a session is yours. */
function sameKey(expected: Buffer, candidate: string): boolean {
  const actual = digest(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// JSON-RPC-shaped refusals: the client is an MCP client, and an HTML error page
// or a bare status is something it has no way to report to its user.
const rpcError = (res: Response, status: number, code: number, message: string) => {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
};
const badRequest = (res: Response, m: string) => rpcError(res, 400, -32000, m);
const unauthorized = (res: Response, m: string) => rpcError(res, 401, -32001, m);
const notFound = (res: Response, m: string) => rpcError(res, 404, -32001, m);
const unavailable = (res: Response, m: string) => rpcError(res, 503, -32002, m);
