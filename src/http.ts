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
  /** Requests currently being served on this session. */
  active: number;
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
  // Initializes that have passed the cap check but have not yet reached
  // `onsessioninitialized`. Counted, because the check and the map write are
  // two awaits apart: without a reservation every concurrent initialize reads
  // the same `sessions.size`, all of them pass, and the cap bounds nothing —
  // which is the exact memory exhaustion it was put here to stop.
  let pending = 0;

  // Abandoned sessions are closed rather than left holding a transport. A
  // client that goes away without a DELETE is the ordinary case, not the odd
  // one — laptops sleep and tabs close.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - ttl;
    for (const [id, live] of sessions) {
      // Idle means nothing arriving AND nothing in flight. `lastSeen` is
      // stamped when a request begins and again when it ends, so a single call
      // that outlives the TTL — run_agent is minutes of clicking, and
      // wait_for_computer takes a timeout_s of up to 900 — would otherwise be
      // swept while it was still being served, closing the transport under an
      // answer the caller had not received yet.
      if (live.active === 0 && live.lastSeen < cutoff) {
        sessions.delete(id);
        void live.transport.close().catch(() => {});
      }
    }
  }, 60_000);
  sweeper.unref();

  /** Hold a session open for as long as one request is being served on it. */
  const serving = (live: Live, res: Response) => {
    live.active++;
    live.lastSeen = Date.now();
    res.on('close', () => {
      live.active--;
      live.lastSeen = Date.now();
    });
  };

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
      serving(live, res);
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
    if (sessions.size + pending >= maxSessions) {
      return unavailable(
        res,
        `This server is holding its maximum of ${maxSessions} sessions. Retry shortly.`,
      );
    }
    pending++;
    // Released exactly once, whether the initialize lands in the map or throws
    // on the way there. A reservation that leaked on the failure path would
    // ratchet the cap down until the process restarted.
    let reserved = true;
    const release = () => {
      if (reserved) {
        reserved = false;
        pending--;
      }
    };

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: Boolean(cfg.allowedHosts?.length || cfg.allowedOrigins?.length),
      allowedHosts: cfg.allowedHosts,
      allowedOrigins: cfg.allowedOrigins,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, keyDigest: digest(key), lastSeen: Date.now(), active: 0 });
        release();
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
    try {
      await server.connect(transport);
      return await transport.handleRequest(req, res, req.body);
    } finally {
      release();
    }
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
    serving(live, res);
    return live.transport.handleRequest(req, res);
  };
  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);

  return new Promise((resolve, reject) => {
    let listening = false;
    const http = app.listen(cfg.port, cfg.host, () => {
      listening = true;
      // The bound port, not the requested one. `port()` deliberately accepts 0,
      // which means "any free port" — and printing it back gives the operator
      // http://127.0.0.1:0/mcp, a URL that cannot be used to reach the server
      // they were just told was up.
      const addr = http.address();
      const bound = typeof addr === 'object' && addr ? addr.port : cfg.port;
      console.error(
        `mandala-computer-mcp on http://${cfg.host}:${bound}/mcp — callers authenticate with their own Mandala API key`,
      );
      resolve(http);
    });
    // Without a listener, an 'error' event is rethrown as an uncaught
    // exception — a stack trace for EADDRINUSE, the most ordinary operational
    // failure there is, and a promise that never settles. Rejecting instead
    // lets main()'s catch print the one sentence.
    //
    // Only while the bind is still pending, though. A server that is already
    // up emits 'error' for things it goes on serving through, and tearing down
    // the sweeper there would leave the session cap with nothing to reap
    // against — every later caller refused, for a connection error minutes
    // earlier that the reject could no longer report anyway.
    http.on('error', (err) => {
      if (listening) return;
      clearInterval(sweeper);
      reject(err);
    });
    // Closing the server has to take the sessions with it, and has to do it on
    // the way in. `close()` stops new connections and then waits for the ones
    // already in flight, so a session holding an open server-to-client stream
    // keeps it from ever completing — an embedding host that shuts this down
    // would hang rather than exit. Doing this in the 'close' event instead
    // would be too late by definition: that event cannot fire until the
    // streams this needs to end are already gone.
    const teardown = () => {
      clearInterval(sweeper);
      for (const live of sessions.values()) void live.transport.close().catch(() => {});
      sessions.clear();
    };
    const closeServer = http.close.bind(http);
    http.close = ((cb?: (err?: Error) => void) => {
      teardown();
      return closeServer(cb);
    }) as typeof http.close;
    http.on('close', teardown);
  });
}

function bearer(req: Request): string | undefined {
  const auth = req.header('authorization') ?? '';
  // RFC 7235 §2.1 makes the scheme case-insensitive, and a client that sends
  // `bearer com_…` is sending a well-formed credential. Matching only the
  // capitalised spelling answers it with a 401 whose message tells it to do
  // the thing it just did.
  const m = /^bearer[ \t]+/i.exec(auth);
  return m ? auth.slice(m[0].length).trim() || undefined : undefined;
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
