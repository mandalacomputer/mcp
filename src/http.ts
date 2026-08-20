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
 * The addresses that mean "this machine only".
 *
 * `0.0.0.0` and `::` are deliberately absent: they bind every interface, which
 * is an operator saying they want this reachable from elsewhere. Treating that
 * as loopback would hand them a Host allowlist naming addresses their callers
 * never send, and the deployment would answer 403 to everything.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

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

  const sessions = new Map<string, Live>();
  // The port sessions are actually reachable on, which is not cfg.port when the
  // operator asked for 0. Read when a transport is built rather than captured
  // at construction, because the default Host allowlist below carries it and a
  // list naming port 0 would match nothing a client could ever send.
  let boundPort = cfg.port;
  const ttl = cfg.sessionTtlMs ?? DEFAULT_TTL_MS;
  const maxSessions = cfg.maxSessions ?? DEFAULT_MAX_SESSIONS;
  // Initializes that have passed the cap check but have not yet reached
  // `onsessioninitialized`. Counted, because the check and the map write are
  // two awaits apart: without a reservation every concurrent initialize reads
  // the same `sessions.size`, all of them pass, and the cap bounds nothing —
  // which is the exact memory exhaustion it was put here to stop.
  let pending = 0;

  // Two parsers, chosen by whether this server has already checked who is
  // asking.
  //
  // `express.json` buffers and parses the whole body before any route runs, so
  // mounted globally at 80mb it spent that on a caller who had sent no key —
  // free to send, expensive to serve, and nothing about it needed a
  // credential. The large limit is what `write_file` needs, and `write_file`
  // always arrives on an established session, so it is given to exactly that:
  // a request naming a live session whose key digest matches the bearer it
  // carried, which is the same test the POST route applies before doing
  // anything. Everyone else — including an initialize, which is a few hundred
  // bytes — gets the small one and a 413.
  //
  // Presence of an `Authorization` header is deliberately not the test. This
  // server cannot check a `com_…` key without a round trip to the platform, so
  // a header alone identifies nobody: `Bearer x` would buy the 80mb buffer as
  // cheaply as sending nothing at all, and the limit would bound only the
  // callers who had not thought about it. A session digest is the one thing
  // here that was actually earned.
  //
  // Which status a request ends at is unchanged as long as it stays under the
  // limit, because the body is still parsed: a non-initialize with no session
  // is still a 400, not a 401 about the key it also did not send.
  const fullBody = express.json({ limit: '80mb' });
  const smallBody = express.json({ limit: '256kb' });
  const parseBody = (req: Request, res: Response, next: express.NextFunction) => {
    const id = req.header('mcp-session-id');
    const live = id ? sessions.get(id) : undefined;
    const key = bearer(req);
    const verified = Boolean(live && key && sameKey(live.keyDigest, key));
    return (verified ? fullBody : smallBody)(req, res, next);
  };

  // Abandoned sessions are closed rather than left holding a transport. A
  // client that goes away without a DELETE is the ordinary case, not the odd
  // one — laptops sleep and tabs close.
  //
  // Inspected once a minute, or as often as the TTL if that is shorter — a
  // sessionTtlMs of ten seconds that was only looked at every sixty is not the
  // TTL the operator asked for.
  const sweepMs = Math.min(60_000, Math.max(1_000, ttl));
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
  }, sweepMs);
  sweeper.unref();

  /**
   * Hold a session open for as long as one request is being served on it.
   *
   * Only for request/response traffic. The standing server-to-client stream is
   * deliberately not counted: a conforming client opens `GET /mcp` once and
   * holds it for the whole session, so counting it would make `active` never
   * reach zero and no session would ever be swept — and the case the sweeper
   * exists for, a laptop that slept and left the socket half-open, is exactly
   * the one where `close` never fires to undo the count. The transport and its
   * fully-registered server would sit on a `maxSessions` slot forever.
   */
  const serving = (live: Live, res: Response) => {
    live.active++;
    live.lastSeen = Date.now();
    res.on('close', () => {
      live.active--;
      live.lastSeen = Date.now();
    });
  };

  /** Stamp a session as heard from, without claiming anything is in flight. */
  const touch = (live: Live, res: Response) => {
    live.lastSeen = Date.now();
    res.on('close', () => {
      live.lastSeen = Date.now();
    });
  };

  /**
   * The Host headers a legitimate client sends, when nobody configured a list.
   *
   * A loopback bind is reached as `127.0.0.1:port`, `localhost:port` or
   * `[::1]:port` depending on what was typed, and all three are this server; a
   * name resolved to 127.0.0.1 by a page the user is visiting is not, and is
   * exactly what the check exists to turn away.
   *
   * A non-loopback bind gets no default. The operator deliberately exposed this
   * server and there is no way to guess the names it is legitimately reached
   * by — inventing a list would break the deployment rather than protect it —
   * so protection there stays opt-in, and startup says so.
   */
  function allowedHosts(portNow: number): string[] | undefined {
    // Lowercased to match the folded header — an operator who writes
    // `Example.COM` means the same host the client sends as `example.com`.
    if (cfg.allowedHosts?.length) return cfg.allowedHosts.map((h) => h.toLowerCase());
    if (!LOOPBACK.has(cfg.host)) return undefined;
    return ['127.0.0.1', 'localhost', '[::1]'].flatMap((h) => [`${h}:${portNow}`, h]);
  }

  // Host names are case-insensitive, and the SDK's rebinding check is not: it
  // is a plain `allowedHosts.includes(hostHeader)` against the header as sent,
  // so a conformant client that says `Host: LOCALHOST:3000` is answered 403 by
  // a list that contains `localhost:3000`. Nothing above can fix that from
  // outside the SDK, but the header can be normalised to the one spelling the
  // list is written in before it gets there. Safe to fold: RFC 3986 says the
  // host is case-insensitive, and `new URL()` already lowercases it, which is
  // why browsers and fetch never trip this and a hand-set header does.
  //
  // Folded in `rawHeaders`, not just `req.headers`. The transport is a wrapper
  // over @hono/node-server, which rebuilds the web Request from
  // `incoming.rawHeaders` and never looks at the parsed object Express hands
  // around — so normalising only the latter changes nothing the check can see.
  app.use((req, _res, next) => {
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i].toLowerCase() === 'host') raw[i + 1] = raw[i + 1].toLowerCase();
    }
    if (req.headers.host) req.headers.host = req.headers.host.toLowerCase();
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, sessions: sessions.size });
  });

  app.post('/mcp', parseBody, async (req: Request, res: Response) => {
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
    // ratchet the cap down until the process restarted — every later initialize
    // refused with 503 for the life of the process, which is the denial of
    // service the counter was added to prevent, self-inflicted.
    let reserved = true;
    const release = () => {
      if (reserved) {
        reserved = false;
        pending--;
      }
    };

    // Everything from here to the map write is inside the reservation,
    // constructors included: they are ordinary code that can throw, and Express
    // turning that into a 500 is precisely the path that used to leak.
    //
    // `transport` is declared out here so the catch can reach it: the session
    // is written to the map from inside handleRequest, so a throw after that
    // point has something to clean up.
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const hosts = allowedHosts(boundPort);
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // On whenever there is a list to check against, which for a loopback
        // bind is always — see `allowedHosts`. A browser cannot be stopped from
        // resolving a name it controls to 127.0.0.1, so the Host header is the
        // only thing separating the operator's own client from a page the user
        // happened to open, and the MCP spec asks a locally-bound server to
        // check it.
        enableDnsRebindingProtection: Boolean(hosts?.length || cfg.allowedOrigins?.length),
        allowedHosts: hosts,
        allowedOrigins: cfg.allowedOrigins,
        onsessioninitialized: (id) => {
          sessions.set(id, {
            transport: t,
            keyDigest: digest(key),
            lastSeen: Date.now(),
            active: 0,
          });
          release();
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      transport = t;
      t.onclose = () => {
        if (t.sessionId) sessions.delete(t.sessionId);
      };

      const server = createServer({
        ...cfg,
        apiKey: key,
        // Per-caller, and deliberately with no fallback to cfg.modelKey: an
        // operator who set MANDALA_MODEL_KEY for their own stdio use would
        // otherwise be billed for every stranger's run here. Absent means
        // run_agent is simply not offered to this session.
        modelKey: req.header(MODEL_KEY_HEADER),
        // Dropped for the same reason, one field further on. MANDALA_COMPUTER_ID
        // is the operator's own machine, and spreading it into a stranger's
        // session pre-binds their key to a computer on somebody else's account:
        // every call until they run use_computer 404s, and the id of a machine
        // that is not theirs is named back to them by way of explanation.
        computerId: undefined,
      });
      await server.connect(t);
      return await t.handleRequest(req, res, req.body);
    } catch (err) {
      // `onsessioninitialized` fires from inside handleRequest, so by the time
      // anything past it throws the session is already in the map — holding a
      // maxSessions slot and a key digest, under an id the client never learned
      // and so can never DELETE. Left alone it sits there until the TTL sweep
      // half an hour later, and enough of them ratchet the cap to zero.
      if (transport?.sessionId) sessions.delete(transport.sessionId);
      if (transport) void transport.close().catch(() => {});
      throw err;
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
    // The DELETE is a request and is held for; the GET is the notification
    // stream and is only noted. See `serving`.
    if (req.method === 'GET') touch(live, res);
    else serving(live, res);
    return live.transport.handleRequest(req, res);
  };
  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);

  // The last word on anything that threw, because Express's own last word is
  // an HTML page.
  //
  // `finalhandler` renders the error — message, and outside NODE_ENV=production
  // the whole stack, absolute paths and all — into the response body. Two
  // things reach it here. A body-parser refusal is one: `express.json` throws
  // `entity.too.large` past the limit and `entity.parse.failed` on malformed
  // JSON, and neither is caught by a route, because neither ever reaches one.
  // Anything a handler throws is the other. Both used to leave an MCP client
  // holding markup it has no way to report to its user, and the too-large case
  // in particular is now reachable by anyone who can open a socket, since the
  // small limit is what an unidentified caller gets.
  //
  // Body-parser failures are answered with their own status and message: they
  // describe the request the sender just made, and knowing it was too large or
  // malformed is what lets them fix it. Everything else is a bug in this
  // server, so it is logged here and the sender is told only that it happened
  // — the stack is for the operator's terminal, not for the wire.
  app.use((err: unknown, _req: Request, res: Response, next: express.NextFunction) => {
    // Streaming answers are the ordinary case on /mcp, and once bytes are out
    // the status line is long gone. Express's handler is the only thing that
    // can destroy the socket at that point; ours would append JSON to an SSE
    // stream.
    if (res.headersSent) return next(err);
    const e = err as { type?: unknown; status?: unknown; message?: unknown } | null;
    // `type` is body-parser's marker, and its errors carry a status of their
    // own. Anything else with a status did not come from parsing a body.
    if (typeof e?.type === 'string' && typeof e.status === 'number') {
      const message =
        e.type === 'entity.too.large'
          ? 'Request body is too large. Bodies above 256KB are accepted only on an established session, by a caller whose key matches it — initialize first, then send this there.'
          : typeof e.message === 'string'
            ? e.message
            : 'This request body could not be read.';
      return rpcError(res, e.status, -32000, message);
    }
    console.error('mandala-computer-mcp: unhandled error serving a request', err);
    return rpcError(res, 500, -32603, 'This server failed while serving the request.');
  });

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
      boundPort = bound;
      console.error(
        `mandala-computer-mcp on http://${cfg.host}:${bound}/mcp — callers authenticate with their own Mandala API key`,
      );
      // Said once, at the only moment anybody is reading. A bind that is not
      // loopback cannot have its legitimate Host values guessed, so the check
      // is off and the operator is the only one who can turn it on — and an
      // exposed server with no Host check is reachable by any page that
      // resolves its own name to this address.
      if (!allowedHosts(bound)) {
        console.error(
          `  no Host allowlist for ${cfg.host} — set MANDALA_ALLOWED_HOSTS to the name(s) this is served under to enable DNS-rebinding protection`,
        );
      } else if (!cfg.allowedHosts?.length) {
        // The other half of the same sentence, and the one that costs an
        // operator a working install if it goes unsaid. A loopback bind gets a
        // Host allowlist by default, which is right for the local case and
        // wrong for the very common one where this sits behind nginx, Caddy or
        // cloudflared: the proxy forwards `Host: mcp.example.com`, the check
        // refuses it, and every request 403s with nothing in the log to say
        // which header was the problem. Named here so the fix is one line
        // rather than an afternoon.
        console.error(
          `  answering only to Host: 127.0.0.1, localhost or [::1] (with or without :${bound}) — set MANDALA_ALLOWED_HOSTS if this is served under a name, e.g. behind a proxy`,
        );
      }
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
      if (listening) {
        // Not rejected and not torn down, for the reasons above — but not
        // discarded either. EMFILE on accept leaves a server that refuses every
        // connection with nothing anywhere saying why, and the operator's only
        // other clue is silence. Logged where the unhandled-error path already
        // logs, so there is one place to look.
        console.error('mandala-computer-mcp: server error after bind —', err);
        return;
      }
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
