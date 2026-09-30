import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { Api, MODEL_KEY_HEADER } from './api.js';
import { APIError } from './errors.js';
import { MeteredBody } from './http-body.js';
import { WHOAMI } from './paths.js';
import { createServer, SERVER_NAME, SERVER_VERSION, type ServerConfig } from './server.js';
import { toolFilter } from './tool-filters.js';

export type HttpConfig = Omit<ServerConfig, 'apiKey' | 'activity'> & {
  port: number;
  host: string;
  /** Hosts this server will answer to, for DNS-rebinding protection. */
  allowedHosts?: string[];
  allowedOrigins?: string[];
  /** How long an idle session survives before it is swept, in ms. */
  sessionTtlMs?: number;
  /** How many live sessions this server will hold at once. */
  maxSessions?: number;
  /**
   * How many live sessions one bearer may hold at once. Default 16, which is
   * also what anything but a number of at least one (NaN, 0) means; Infinity
   * leaves only `maxSessions`. A suspended account (hosted mode) holds one
   * session in all, across all its bearers, whatever this is (OPL-5452).
   */
  maxSessionsPerBearer?: number;
  /**
   * How many live sessions one account may hold at once, across all of its
   * bearers (OPL-5447). Hosted mode counts by the account id the platform's
   * whoami names for each bearer, and a bearer whose whoami names none is an
   * account of its own; a self-hosted server verifies no account, so there
   * each bearer is its own. Default half of `maxSessions` (128 of 256), which
   * is also what anything but a number of at least one means; above
   * `maxSessions` it is `maxSessions`. At the ceiling an initialize makes room
   * only by closing idle sessions: first the account's whose bearer the
   * platform has refused, then the requester's own, least recently used
   * first. Failing that it is refused (429); a live session of another bearer
   * is never closed for it. A suspended account (hosted mode) is held to one
   * session in all, whatever this is, and there the one exception applies: a
   * new bearer of that account may close the account's idle session of
   * another bearer to take the one slot (OPL-5452).
   */
  maxSessionsPerAccount?: number;
  /** How many requests may retain a parsed body above 256 KiB at once. */
  maxLargeBodyParses?: number;
  /**
   * The OAuth protected-resource metadata URL (RFC 9728) of this server, for
   * the hosted install (OPL-4982). Setting it turns on the OAuth answers: a
   * request with no bearer, or whose bearer the platform refused, is a 401
   * carrying {@link bearerChallenge}, which is how an MCP client discovers
   * where to authorize and knows to refresh. Unset, nothing changes.
   */
  resourceMetadataUrl?: string;
  /**
   * The platform's shared secret for this service, sent as
   * `X-Mandala-MCP-Service` on every platform request a session makes. Needed
   * for the platform to take an OAuth access token at all. Never logged.
   */
  serviceSecret?: string;
  /**
   * Hosted mode: how long a bearer the platform accepted is taken on trust
   * before it is checked again, in ms. Default 60 s.
   */
  bearerCheckTtlMs?: number;
  /**
   * Hosted mode: refused initializes one source may make per minute before it
   * is answered 429 without asking the platform. Default 20.
   */
  maxFailedInitializes?: number;
  /**
   * Hosted mode: once a source has spent that budget, how often it may still
   * have one new bearer checked, in ms. Default 5 s.
   */
  exhaustedProbeIntervalMs?: number;
  /** The SDK's SSE keep-alive interval, in ms. For tests; default 15 s. */
  sseKeepAliveMs?: number;
};

type Live = {
  transport: StreamableHTTPServerTransport;
  /** Not the key. Enough to prove a later request came from the same holder. */
  keyDigest: Buffer;
  /** What this session counts against for the account ceiling. See {@link accountKey}. */
  account: string;
  lastSeen: number;
  /** Requests currently being served on this session. */
  active: number;
  /**
   * The platform has refused this session's bearer (hosted mode only). Every
   * later request carrying it is answered with the challenge before anything is
   * dispatched: the token is expired or revoked and only the client can mend it.
   */
  refused: boolean;
};

/**
 * One POST's answer, while it may still become a 401 (hosted mode only).
 *
 * `refuse` is called when the platform refuses the bearer during this request.
 * It answers 401 if nothing has been sent yet, and is a no-op afterwards.
 */
type HeldAnswer = { refuse: () => void };

/** The OAuth scope the hosted resource asks for. */
export const MCP_SCOPE = 'mcp:tools';

/**
 * The `WWW-Authenticate` value of every OAuth refusal this server makes.
 *
 * The same header whether no bearer was sent or the platform refused one: RFC
 * 9728 §5.1 has a client find the authorization server through
 * `resource_metadata`, and the MCP authorization spec has it refresh or
 * re-authorize on any 401 that carries it.
 */
export function bearerChallenge(resourceMetadataUrl: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl}", scope="${MCP_SCOPE}"`;
}

/**
 * The metadata URL, or a refusal naming the setting.
 *
 * It goes inside a quoted-string in a response header, so a quote, a backslash
 * or a control character would change what the header says — refused rather
 * than escaped, since no real URL needs one.
 */
function checkedMetadataUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      'MANDALA_MCP_RESOURCE_METADATA_URL is not a URL. Set it to the absolute https URL of ' +
        'this resource’s OAuth metadata, e.g. https://app.mandala.computer/.well-known/oauth-protected-resource/mcp',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('MANDALA_MCP_RESOURCE_METADATA_URL must be an http(s) URL.');
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/["\\\u0000-\u001f\u007f\s]/.test(raw)) {
    throw new Error(
      'MANDALA_MCP_RESOURCE_METADATA_URL contains a quote, backslash, space or control character.',
    );
  }
  return raw;
}

/** Visible ASCII only: anything else cannot be a header value, and says so here. */
function checkedServiceSecret(raw: string): string {
  if (!/^[\x21-\x7e]+$/.test(raw)) {
    // The value is deliberately not echoed.
    throw new Error(
      'MANDALA_MCP_SERVICE_SECRET must be printable ASCII with no spaces; it is sent as a header.',
    );
  }
  return raw;
}

type LargeBodyLease = {
  /** Add an owner and return its idempotent release callback. */
  retain: () => () => void;
  /** Release the parser/route's original ownership. */
  release: () => void;
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
export const DEFAULT_MAX_SESSIONS = 256;
/**
 * A ceiling on live sessions per bearer, under the one above.
 *
 * The process-wide cap bounds memory, but on its own it is a pool one caller
 * can drain: a single accepted bearer could open every one of the 256 sessions
 * and every other tenant's initialize was 503'd until the sweep, half an hour
 * later. 16 leaves room for one person running several MCP clients on one key
 * and still leaves the pool to everybody else.
 *
 * A suspended account's bearer is admitted (OPL-5437: it is how its holder
 * reaches `whoami` and learns it is suspended), and one session is all that
 * needs. Every other call it could make is refused by the platform. One
 * session for the ACCOUNT, however many keys or tokens it holds (OPL-5452):
 * see `standing` in {@link runHttp}.
 */
const DEFAULT_MAX_SESSIONS_PER_BEARER = 16;
const MAX_SESSIONS_SUSPENDED = 1;
/** How long a caller whose bearer holds its maximum is asked to wait, in s. */
const BEARER_FULL_RETRY_AFTER_S = 30;
/** How long a caller is asked to wait when the whole pool is full, in s. */
const POOL_FULL_RETRY_AFTER_S = 30;
const DEFAULT_MAX_LARGE_BODY_PARSES = 4;
const SMALL_BODY_BYTES = 256 * 1024;

/**
 * The addresses that mean "this machine only".
 *
 * `0.0.0.0` and `::` are deliberately absent: they bind every interface, which
 * is an operator saying they want this reachable from elsewhere. Treating that
 * as loopback would hand them a Host allowlist naming addresses their callers
 * never send, and the deployment would answer 403 to everything.
 *
 * The whole of 127.0.0.0/8 is loopback, not only 127.0.0.1. Binding
 * `127.0.0.2` used to skip the default Host check because the set named three
 * spellings and nothing else on this machine.
 *
 * IPv4-mapped loopback — `::ffff:127.0.0.1`, and the bracketed spelling — is
 * the same widening one notation further out. It is a v6 socket carrying a v4
 * loopback address, Node will bind it, and it was falling through to "not
 * loopback": no default Host allowlist, so DNS-rebinding protection silently
 * off on a bind that is as local as `127.0.0.1` is.
 *
 * IPv6 loopback is the same hole one spelling further in. Node accepts
 * `0:0:0:0:0:0:0:1` and `::0:1` and reports the bound address as `::1`, but
 * `cfg.host` stays the operator's spelling — a string match on `::1` alone
 * skipped the default Host allowlist and left DNS-rebinding protection off.
 * Parsed as an address, every compression of all-zeros-then-one is loopback.
 *
 * A zone suffix (`%lo`) is dropped first, since it names an interface rather
 * than an address.
 */
const LOOPBACK = new BlockList();
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');

export function isLoopbackHost(host: string): boolean {
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  if (h === 'localhost') return true;
  const version = isIP(h);
  if (version === 4) return LOOPBACK.check(h, 'ipv4');
  if (version === 6) return LOOPBACK.check(h, 'ipv6');
  return false;
}

/**
 * One operator-supplied allowlist entry, as the Host headers it should match.
 *
 * Bracket-aware, because that is the whole difficulty: a literal IPv6 address
 * is full of colons and is only a `host:port` when the colon falls after the
 * `]`. Three cases, and only the last is expanded:
 *
 * - already carries a port — left exactly as written. That operator has said
 *   which port their callers use, and it need not be the one bound here.
 * - a BARE IPv6 address, unbracketed. `::1` is not a legal Host header and
 *   `::1` + `:3000` is `::1:3000`, which nothing can send — so it is BRACKETED
 *   into the spellings a client actually sends, rather than left as a dead
 *   entry that matches nothing. An operator who writes the address has said
 *   which host they mean; the brackets are notation, not a second guess.
 * - anything else — matched with and without the bound port.
 */
export function hostSpellings(host: string, port: number): string[] {
  if (host.startsWith('[')) {
    // Already bracketed: with a port it is exactly what a client sends, and
    // without one it still needs the ported spelling.
    return /\]:\d+$/.test(host) ? [host] : [host, `${host}:${port}`];
  }
  // Unbracketed and full of colons is a v6 literal; one colon and digits is a
  // name that already names its port.
  if (/:\d+$/.test(host) && host.indexOf(':') === host.lastIndexOf(':')) return [host];
  if (host.includes(':')) return [`[${host}]`, `[${host}]:${port}`];
  return [host, `${host}:${port}`];
}

/**
 * The Host/Origin refusal the SDK would have returned from handleRequest.
 *
 * Matched here so a DNS-rebinding initialize never reaches `createServer`.
 * The SDK's check returns a 403 Response without throwing, so a refusal that
 * ran after construction paid for every tool registration and never hit the
 * catch that closes the transport (adversarial review, OPL-4314).
 */
function dnsRebindingRefusal(
  req: Request,
  hosts: string[] | undefined,
  origins: string[] | undefined,
): string | undefined {
  if (!(hosts?.length || origins?.length)) return undefined;
  if (hosts?.length) {
    const hostHeader = req.header('host');
    if (!hostHeader || !hosts.includes(hostHeader)) {
      return `Invalid Host header: ${hostHeader}`;
    }
  }
  if (origins?.length) {
    const originHeader = req.header('origin');
    if (originHeader && !origins.includes(originHeader)) {
      return `Invalid Origin header: ${originHeader}`;
    }
  }
  return undefined;
}

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
  // Embedders bypass the CLI's environment parser. Reject invalid filters
  // before allocating HTTP resources, using the same rules as each session.
  toolFilter(cfg);

  // HTTP does not construct an Api until the first initialize, which made a
  // bad MANDALA_BASE_URL look like a working bind and then fail that caller
  // with a generic 500. Validate it before opening the listening socket, using
  // the same constructor and therefore the same rules as every real session.
  new Api('startup-validation-only', cfg.baseUrl);

  // The hosted install's two settings, checked before the bind for the same
  // reason. `challenge` being set IS hosted mode: every OAuth-specific answer
  // below is gated on it, so a server started without the metadata URL behaves
  // exactly as it did before OPL-4982.
  const metadataUrl =
    cfg.resourceMetadataUrl !== undefined ? checkedMetadataUrl(cfg.resourceMetadataUrl) : undefined;
  const serviceSecret =
    cfg.serviceSecret !== undefined ? checkedServiceSecret(cfg.serviceSecret) : undefined;
  const challenge = metadataUrl ? bearerChallenge(metadataUrl) : undefined;
  /** The POST being answered, so a refused bearer can turn it into a 401. */
  const heldAnswer = new AsyncLocalStorage<HeldAnswer | undefined>();

  // ---- Checking a bearer with the platform (hosted mode) -----------------
  //
  // Initialize makes no platform request, so without this an invented bearer
  // bought a whole session: 256 of them filled the cap and every real client
  // was 503'd until the sweep. And a POST's event stream is committed by the
  // SDK's keep-alive after 15 s, after which a refused token can only end that
  // call as a tool error. So in hosted mode a bearer is checked before a
  // session is created for it, and before a POST carrying a request is
  // dispatched — the latter cached briefly, keyed by the token's digest and
  // never by the token.
  const checkTtl = cfg.bearerCheckTtlMs ?? DEFAULT_BEARER_CHECK_TTL_MS;
  // What the platform said, per digest: until when it is taken on trust, and
  // the account key (see {@link accountKey}) its whoami named, which the
  // account ceiling counts by. Whether that account is suspended is NOT kept
  // here: it is read from `standing`, below, every time it is asked.
  type Acceptance = { until: number; account: string };
  const accepted = new Map<string, Acceptance>();
  let checksInFlight = 0;

  // ---- Account standing: one suspended account, one session (OPL-5452) ---
  //
  // A suspended account is held to one live session IN ALL, across every key
  // and token it holds. Holding each bearer to one instead (OPL-5443/5448)
  // let an account with N keys keep N sessions. The platform's whoami says
  // `status: "suspended"` but carries no time or generation, so which of two
  // answers about one account is the newer is settled here:
  //
  // 1. One source of truth per account: `standing`, keyed by account key. A
  //    whoami probe takes the next `probeSeq` when it STARTS, and its answer
  //    replaces the account's standing only if that number is higher than the
  //    standing's. The newest-started probe wins, so a slow probe that
  //    finishes last can never undo a newer answer, in either direction. A
  //    bearer's cached acceptance keeps only its account and its expiry: a
  //    per-key suspended-or-not would outlive a newer answer another key got.
  // 2. Enforcement per account, one helper (`enforceAccountSuspension`),
  //    applied at an initialize's admission and on every request,
  //    notification and event stream on a session: while the standing says
  //    suspended, the account's idle sessions are closed until it holds one.
  //    A notification or a stream asks the platform nothing, so it acts on
  //    the standing only while its own bearer's acceptance is still cached,
  //    and the standing is then no older than that acceptance.
  // 3. Which session keeps the slot: only idle sessions are ever closed,
  //    never one with a request in flight. Those whose bearer the platform
  //    has refused go first, then the least recently used. An initialize by
  //    another bearer of a suspended account (a refreshed OAuth token, say)
  //    may close the account's idle session to take the one slot; when every
  //    session it holds is busy, it is answered 429.
  // 4. A self-hosted server asks no platform, so it has no standing: nothing
  //    is suspended there, and every limit stays per bearer.
  // 5. A newer probe that finds the account active lifts the hold at once,
  //    for every bearer of the account, since none of them caches its own.
  //
  // Bounded like the acceptance cache. An entry dropped for room is only a
  // missing answer: a cached acceptance whose account has none is probed
  // again before it is believed, and a notification or stream enforces
  // nothing on it.
  type Standing = { suspended: boolean; seq: number };
  const standing = new Map<string, Standing>();
  let probeSeq = 0;

  /** Whether the latest answer about this account says it is suspended. */
  const accountSuspended = (account: string): boolean => standing.get(account)?.suspended === true;

  /** Take a probe's answer for its account, unless a newer-started one answered already. */
  const noteStanding = (account: string, suspended: boolean, seq: number) => {
    const known = standing.get(account);
    if (known && known.seq >= seq) return;
    // Re-inserted, so Map order is the order answers were taken in.
    standing.delete(account);
    if (standing.size >= MAX_ACCEPTED_BEARERS) {
      // An account holding no session needs no answer kept: a later request
      // or initialize for it finds none and asks again.
      const holding = new Set<string>();
      for (const live of sessions.values()) holding.add(live.account);
      for (const k of standing.keys()) if (!holding.has(k)) standing.delete(k);
      if (standing.size >= MAX_ACCEPTED_BEARERS) {
        standing.delete(standing.keys().next().value as string);
      }
    }
    standing.set(account, { suspended, seq });
  };

  /** The platform's acceptance of this bearer, while the cache window lasts. */
  const acceptance = (key: string): Acceptance | undefined => {
    const entry = accepted.get(digest(key).toString('hex'));
    return entry !== undefined && entry.until > Date.now() ? entry : undefined;
  };

  /** Whether the platform accepted this bearer within the cache window. */
  const isAccepted = (key: string): boolean => acceptance(key) !== undefined;

  /**
   * `ok`: the probe answered 2xx, and only that — the one answer that says the
   * platform authenticated this credential AND let it act. `suspended`: the
   * same 2xx, for an account whose standing says `status: "suspended"` —
   * admitted as `ok` is, and held to one session in all. `refused`: a 401.
   * `unknown`: anything else — a 403 (a lost membership, say; a suspended
   * account is answered 2xx on whoami and admitted), a 404 (the route moved), a 429, a 5xx, a timeout, or this
   * server already asking about as many bearers as it will at once. Only `ok`
   * and `suspended` are cached: the account key with the acceptance, the
   * standing per account. `account` is the account key the bearer counts against (see
   * {@link accountKey}); it is set whenever the verdict is `ok` or
   * `suspended`, and returned rather than read back from the cache, which a
   * zero TTL or a full cache may already have let go of.
   */
  // `onStart` runs only when a probe really starts — never for a cached answer
  // or a full cap — and synchronously, before the first await, so a caller's
  // bookkeeping and its check against it cannot interleave with another's.
  //
  // `ok` and `suspended` are the account's STANDING when this returns, which
  // a newer-started probe of another of its bearers may have set, not what
  // this bearer's own probe (or cached acceptance) said (OPL-5452).
  const checkBearer = async (
    key: string,
    onStart?: () => void,
  ): Promise<{ verdict: 'ok' | 'suspended' | 'refused' | 'unknown'; account?: string }> => {
    const id = digest(key).toString('hex');
    const cached = acceptance(key);
    // Believed only while its account has a standing to read (see above).
    if (cached && standing.has(cached.account)) {
      return {
        verdict: accountSuspended(cached.account) ? 'suspended' : 'ok',
        account: cached.account,
      };
    }
    if (checksInFlight >= MAX_BEARER_CHECKS_IN_FLIGHT) return { verdict: 'unknown' };
    checksInFlight++;
    // Numbered as it starts, before the first await: see `standing`.
    const seq = ++probeSeq;
    onStart?.();
    let suspended: boolean;
    let confirmed: string | undefined;
    try {
      const api = new Api(key, cfg.baseUrl, AbortSignal.timeout(BEARER_CHECK_TIMEOUT_MS), {
        serviceSecret,
      });
      // `GET whoami`, chosen because every valid credential is answered 2xx
      // on it, a suspended account's included. The platform's route table
      // gives it the lowest role there is (viewer) and marks it readable by a
      // suspended account, and the handler answers from the control plane's
      // own tables without asking any host — so no role a grant can carry, no
      // workspace scope, no account standing and no host being down turns it
      // into a refusal. It was `GET ssh-keys`, which a suspended account is
      // refused (403): its holder was answered 503 on every initialize and so
      // could never reach whoami, the one tool that would say it is suspended
      // (OPL-5437). It takes no parameters, so none are sent.
      const who = await api.json<unknown>('GET', WHOAMI);
      suspended = isSuspended(who);
      confirmed = accountIdOf(who);
    } catch (err) {
      return { verdict: err instanceof APIError && err.status === 401 ? 'refused' : 'unknown' };
    } finally {
      checksInFlight--;
    }
    const now = Date.now();
    if (accepted.size >= MAX_ACCEPTED_BEARERS) {
      for (const [k, e] of accepted) if (e.until <= now) accepted.delete(k);
      // Still full: drop the oldest, which Map iteration yields first.
      if (accepted.size >= MAX_ACCEPTED_BEARERS) {
        accepted.delete(accepted.keys().next().value as string);
      }
    }
    const account = accountKey(id, confirmed);
    accepted.set(id, { until: now + checkTtl, account });
    noteStanding(account, suspended, seq);
    return { verdict: accountSuspended(account) ? 'suspended' : 'ok', account };
  };

  // Refused initializes per source, in fixed one-minute windows. Kept apart
  // from the session cap so a flood of invented tokens is turned away before
  // it asks the platform anything, rather than by starving the pool.
  const maxFailed = cfg.maxFailedInitializes ?? DEFAULT_MAX_FAILED_INITIALIZES;
  // `lastProbeAt` lives on the window's entry, so the window's reset restores
  // the normal budget and forgets the spent-address clock in one step.
  const failures = new Map<string, { count: number; resetAt: number; lastProbeAt?: number }>();
  const exhaustedInterval = cfg.exhaustedProbeIntervalMs ?? DEFAULT_EXHAUSTED_PROBE_INTERVAL_MS;
  const sourceOf = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const overFailureBudget = (req: Request): number | undefined => {
    const entry = failures.get(sourceOf(req));
    if (!entry) return undefined;
    const now = Date.now();
    if (entry.resetAt <= now) {
      failures.delete(sourceOf(req));
      return undefined;
    }
    return entry.count >= maxFailed ? Math.ceil((entry.resetAt - now) / 1000) : undefined;
  };
  const noteFailure = (req: Request) => {
    const source = sourceOf(req);
    const now = Date.now();
    const entry = failures.get(source);
    if (entry && entry.resetAt > now) {
      entry.count++;
      return;
    }
    if (failures.size >= MAX_FAILURE_SOURCES) {
      for (const [k, e] of failures) if (e.resetAt <= now) failures.delete(k);
      if (failures.size >= MAX_FAILURE_SOURCES) {
        failures.delete(failures.keys().next().value as string);
      }
    }
    failures.set(source, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  };

  /** A 401 an OAuth client acts on: authorize, or refresh and try again. */
  const challenged = (res: Response, message: string, id: RpcId = null) => {
    if (challenge) res.set('WWW-Authenticate', challenge);
    unauthorized(res, message, id);
  };

  const app = express();
  // Hosted mode sits behind a proxy on this machine, and the refused-
  // initialize budget is per source: without this every caller would be the
  // proxy's one loopback address, sharing one budget. Only a loopback peer's
  // X-Forwarded-For is believed, so a direct caller cannot choose its source.
  if (challenge) app.set('trust proxy', 'loopback');

  // parseBody consumes every POST /mcp body. Every other route deliberately
  // ignores request bodies, so put those requests in flowing mode immediately:
  // leaving bytes unread can strand a keep-alive connection behind one wrong
  // path or a GET/DELETE client that sent a body anyway.
  app.use((req, _res, next) => {
    if (req.method !== 'POST' || req.path !== '/mcp') req.resume();
    next();
  });

  const sessions = new Map<string, Live>();
  // The port sessions are actually reachable on, which is not cfg.port when the
  // operator asked for 0. Read when a transport is built rather than captured
  // at construction, because the default Host allowlist below carries it and a
  // list naming port 0 would match nothing a client could ever send.
  let boundPort = cfg.port;
  const ttl = cfg.sessionTtlMs ?? DEFAULT_TTL_MS;
  const maxSessions = cfg.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxLargeBodyParses = cfg.maxLargeBodyParses ?? DEFAULT_MAX_LARGE_BODY_PARSES;
  let largeBodyParses = 0;
  // Tool callbacks inherit the request's lease even when a disconnected
  // response lets transport.handleRequest() settle before the callback does.
  const requestBodyLease = new AsyncLocalStorage<LargeBodyLease | undefined>();
  // Initializes that have passed the cap check but have not yet reached
  // `onsessioninitialized`. Counted, because the check and the map write are
  // two awaits apart: without a reservation every concurrent initialize reads
  // the same `sessions.size`, all of them pass, and the cap bounds nothing —
  // which is the exact memory exhaustion it was put here to stop.
  let pending = 0;
  // The same reservations again, per bearer digest (hex), for the per-bearer
  // cap and for the same reason: a burst of initializes from one bearer would
  // otherwise all count the same sessions and all pass. An entry is deleted
  // when it reaches zero, so the map holds only bearers mid-initialize.
  const pendingByDigest = new Map<string, number>();
  // Normalised, because the cap is also arithmetic against the process-wide
  // one: a NaN here (`Number(process.env.X)` with X unset) made every
  // comparison below false and switched off BOTH caps, the 256 backstop
  // included. Anything that is not a number of at least one is the default;
  // Infinity is let through, and leaves only the process-wide cap.
  const perBearer = cfg.maxSessionsPerBearer;
  const maxPerBearer =
    typeof perBearer === 'number' && perBearer >= 1
      ? Math.floor(perBearer)
      : DEFAULT_MAX_SESSIONS_PER_BEARER;
  // The same reservations per account (OPL-5447): an account may hold any
  // number of bearers, so a burst spread across its keys would otherwise all
  // count the same sessions and all pass the account ceiling.
  const pendingByAccount = new Map<string, number>();
  // The ceiling no account may pass, live plus pending: half the pool by
  // default, so no one tenant can take the whole of it however many keys it
  // holds. Normalised as the per-bearer cap is, and clamped to the pool.
  const perAccount = cfg.maxSessionsPerAccount;
  const maxPerAccount =
    typeof perAccount === 'number' && perAccount >= 1
      ? Math.min(Math.floor(perAccount), maxSessions)
      : Math.max(1, Math.floor(maxSessions / 2));

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
  // bytes — gets the small one and a 413. Large parses are capped separately:
  // initialize does not contact the platform, so an arbitrary bearer can still
  // earn a matching digest and must not be able to start hundreds of concurrent
  // 96 MiB allocations.
  //
  // Presence of an `Authorization` header is deliberately not the test. This
  // server cannot check a `com_…` key without a round trip to the platform, so
  // a header alone identifies nobody: `Bearer x` would buy the 80mb buffer as
  // cheaply as sending nothing at all, and the limit would bound only the
  // callers who had not thought about it. The digest proves continuity with a
  // session holder, not that the platform accepted the key; the concurrency
  // cap above is therefore still required.
  //
  // Which status a request ends at is unchanged as long as it stays under the
  // limit, because the body is still parsed: a non-initialize with no session
  // is still a 400, not a 401 about the key it also did not send.
  //
  // A body with NO usable Content-Length — a chunked upload, or a malformed
  // header — is a third case, and the one the accounting used to get wrong. It
  // was classed "may be large" and charged a slot on arrival, so a chunked call
  // carrying a few hundred bytes held one for its whole tool lifetime and four
  // of them 503'd every real write_file, on the strength of a missing header.
  // It is metered instead: no slot while the body is small, one taken the
  // moment the bytes prove otherwise. The cost is that its refusal arrives
  // mid-upload rather than before the read; see `parseBody`.
  // 96mb rather than 80: the limit exists for write_file, and it could not
  // carry one. The platform caps a transfer at 64 MiB, base64 is four bytes for
  // every three, and the JSON-RPC envelope is on top of that — 89,478,488
  // characters of content against a limit of 83,886,080, so the largest file
  // this server is documented to write was refused with a 413 by the very
  // allowance that was raised for it. The real ceiling was about 59 MiB, which
  // is not a number anybody would have found except by hitting it.
  const fullBody = express.json({ limit: '96mb' });
  const smallBody = express.json({ limit: '256kb' });
  const noSlotMessage = `This server is already parsing its maximum of ${maxLargeBodyParses} large request bodies. Retry shortly.`;

  /** Refuse a request that has not started arriving yet, draining it first. */
  const refuseBeforeRead = (req: Request, res: Response) => {
    // Drain before answering so unread request bytes cannot be mistaken for
    // the next request on a keep-alive connection. A peer that aborts the
    // upload gets a closed response rather than a misleading reusable one.
    const cleanup = () => {
      req.off('end', drained);
      req.off('aborted', failed);
      req.off('error', failed);
    };
    const drained = () => {
      cleanup();
      if (!res.destroyed && !res.headersSent) unavailable(res, noSlotMessage);
    };
    const failed = () => {
      cleanup();
      res.destroy();
    };
    if (req.readableEnded) drained();
    else {
      req.once('end', drained);
      req.once('aborted', failed);
      req.once('error', failed);
      req.resume();
    }
  };

  /** Take a slot. Callers must have checked there is one. */
  const takeSlot = (): LargeBodyLease => {
    largeBodyParses++;
    let references = 1;
    const drop = () => {
      if (references <= 0) return;
      references--;
      if (references === 0) largeBodyParses--;
    };
    return {
      retain: () => {
        if (references <= 0) return () => {};
        references++;
        let held = true;
        return () => {
          if (!held) return;
          held = false;
          drop();
        };
      },
      release: drop,
    };
  };

  /** Run the 96mb parser under a lease, handing the lease to the route. */
  const parseUnderLease = (
    req: Request,
    res: Response,
    next: express.NextFunction,
    lease: LargeBodyLease,
  ) =>
    fullBody(req, res, (err) => {
      // A failed parse never reaches the route that normally releases this
      // lease. A successful one keeps it for the route and tool lifetimes:
      // req.body is the large allocation being bounded, and express.json
      // finishing does not free it while asynchronous MCP work still uses it.
      if (err) lease.release();
      else res.locals.largeBodyLease = lease;
      next(err);
    });

  const parseBody = (req: Request, res: Response, next: express.NextFunction) => {
    if (!wouldUseLargeParser(req, sessions)) return smallBody(req, res, next);

    // A DECLARED large body is known to be large before a byte arrives, so its
    // slot is taken up front and a refusal costs nothing.
    if (declaredLength(req) !== undefined) {
      if (largeBodyParses >= maxLargeBodyParses) return refuseBeforeRead(req, res);
      return parseUnderLease(req, res, next, takeSlot());
    }

    // An UNDECLARED length is not evidence of anything, and treating it as
    // "may be large" is what made a chunked call the size of a mouse click hold
    // one of four process-wide slots for a whole tool lifetime. Four of those
    // and every genuine write_file 503s, on the strength of a missing header.
    //
    // So this path is metered instead: it holds no slot at all while the body
    // is small, and takes one at the moment the bytes prove it is not. The
    // guard exists to bound concurrent memory, and BYTES are what occupy
    // memory — a header is only ever a claim about them.
    //
    // ONLY an unencoded body can be metered this way. What arrives on the wire
    // is what body-parser parses only while nothing is compressed: it inflates
    // before applying its own limit, so a few thousand gzipped bytes become
    // megabytes of parsed JSON that this counter never saw — a slot the guard
    // would have charged before, which would make metering a way around it
    // rather than a sharpening of it. An encoded body has no cheap honest
    // measure, so it keeps the old rule and pays up front.
    //
    // An EMPTY header is not an encoding, and reading it as one put the very
    // bug this branch exists to fix back within reach of anybody who sends
    // `Content-Encoding:` with nothing after it: body-parser reads that header
    // as `|| 'identity'`, so it inflates nothing, and a mouse-click-sized
    // chunked call would have taken a process-wide slot for its whole tool
    // lifetime again. Blank and absent are the same answer here, as they are
    // there.
    const encoding = (req.header('content-encoding') ?? '').trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      if (largeBodyParses >= maxLargeBodyParses) return refuseBeforeRead(req, res);
      return parseUnderLease(req, res, next, takeSlot());
    }

    let seen = 0;
    let lease: LargeBodyLease | undefined;
    let refused = false;
    const input = new MeteredBody(
      req,
      (bytes) => {
        if (lease) return true;
        seen += bytes;
        if (seen <= SMALL_BODY_BYTES) return true;
        if (largeBodyParses >= maxLargeBodyParses) return false;
        lease = takeSlot();
        return true;
      },
      () => {
        refused = true;
        if (!res.destroyed && !res.headersSent) unavailable(res, noSlotMessage);
      },
    );

    // A disconnected response can outlive its tool, so only the parser's
    // original ownership is released here; handed-off leases follow the tool.
    let handedOff = false;
    res.once('close', () => {
      if (!handedOff) lease?.release();
    });

    // Express still owns JSON/charset validation. Only its input stream is
    // replaced so a refused upload cannot continue filling raw-body's buffer.
    const parsed = input as unknown as Request;
    return fullBody(parsed, res, (err) => {
      input.destroy();
      if (refused) return;
      if (err) lease?.release();
      else {
        req.body = parsed.body;
        if (lease) {
          res.locals.largeBodyLease = lease;
          handedOff = true;
        }
      }
      next(err);
    });
  };

  const releaseLargeBody = (res: Response) => {
    const lease = res.locals.largeBodyLease as LargeBodyLease | undefined;
    delete res.locals.largeBodyLease;
    lease?.release();
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
   *
   * `heard` says whether this traffic may stamp the session as heard from; it
   * is asked at the start and again at the end. Only `active` is unconditional,
   * so a session with work in flight is never swept whatever `heard` says.
   */
  const beginActivity = (live: Live, heard: () => boolean = always): (() => void) => {
    live.active++;
    if (heard()) live.lastSeen = Date.now();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      live.active--;
      if (heard()) live.lastSeen = Date.now();
    };
  };

  /**
   * Whether traffic on this bearer that carries no request may keep its
   * session from idling out (OPL-5455). Hosted, only while the platform's
   * acceptance of the bearer is still cached: a notification, a response or
   * the standing stream never asks the platform, so without this a revoked
   * token's holder could keep its sessions (and its account's ceiling) held
   * for ever by sending nothing but those. Once the acceptance lapses and no
   * request renews it, they idle out after the session TTL. A cache peek, never
   * a probe. Self-hosted: always.
   */
  const heardWhileAccepted = (key: string): (() => boolean) =>
    challenge ? () => isAccepted(key) : always;

  /** The live sessions opened with this bearer, by its digest. */
  const sessionsOf = (keyDigest: Buffer): Array<[string, Live]> => {
    const own: Array<[string, Live]> = [];
    for (const entry of sessions) {
      const theirs = entry[1].keyDigest;
      if (theirs.length === keyDigest.length && timingSafeEqual(theirs, keyDigest)) own.push(entry);
    }
    return own;
  };

  /**
   * The live sessions counted against this account, whichever bearer opened
   * them. One whose bearer the platform has refused is included: it holds its
   * transport and its slot in the pool until it is closed, so leaving it out
   * would let an account that revokes its own keys hold more than its
   * ceiling, up to the whole pool.
   */
  const sessionsOfAccount = (account: string): Array<[string, Live]> => {
    const counted: Array<[string, Live]> = [];
    for (const entry of sessions) if (entry[1].account === account) counted.push(entry);
    return counted;
  };

  /**
   * The sessions to close so that one more fits under both this bearer's cap
   * and its account's ceiling (OPL-5447), or which of the two it cannot fit
   * under.
   *
   * Only idle sessions (`active === 0`, what the sweeper closes) are
   * candidates, and of two kinds. The bearer's own, which make room under
   * whichever limit binds: its own cap, as before, or its account's ceiling.
   * And the account's sessions of its other bearers that the platform has
   * refused: nothing more is served on those, yet they count against the
   * ceiling until closed, so without this a revoked key would hold its
   * account's other keys out until the sweep. Refused ones go first, then the
   * least recently seen. A live session of another bearer is never a
   * candidate, and neither is anything of another account; an own session
   * counts toward the ceiling's need only if it counts against this account.
   *
   * `suspended` (hosted mode, the account's standing, OPL-5452) lowers both
   * limits to one, and makes every idle session of the account a candidate,
   * whichever bearer opened it: a suspended account holds one session in all,
   * and the bearer asking now (a refreshed token, say) may take it over while
   * it is idle. One with a request in flight is still never a candidate.
   *
   * `pendingBearer`/`pendingAccount` are initializes admitted and not yet
   * landed; at landing both are 0 (see `onsessioninitialized`). The result
   * names sessions, so nothing that outlives the call may keep it.
   */
  const planRoom = (
    keyDigest: Buffer,
    account: string,
    suspended: boolean,
    pendingBearer: number,
    pendingAccount: number,
  ):
    | { victims: Array<[string, Live]> }
    | { full: 'bearer'; holds: number }
    | { full: 'account' } => {
    const bearerCap = suspended ? MAX_SESSIONS_SUSPENDED : maxPerBearer;
    const accountCap = suspended ? MAX_SESSIONS_SUSPENDED : maxPerAccount;
    const own = sessionsOf(keyDigest);
    const counted = sessionsOfAccount(account);
    let bearerNeed = own.length + pendingBearer - bearerCap + 1;
    let accountNeed = counted.length + pendingAccount - accountCap + 1;
    const victims: Array<[string, Live]> = [];
    if (bearerNeed <= 0 && accountNeed <= 0) return { victims };
    const mine = new Set(own.map(([id]) => id));
    const candidates = [
      ...own,
      ...counted.filter(([id, live]) => !mine.has(id) && (live.refused || suspended)),
    ]
      .filter(([, live]) => live.active === 0)
      .sort(closingOrder);
    for (const entry of candidates) {
      if (bearerNeed <= 0 && accountNeed <= 0) break;
      const ofBearer = mine.has(entry[0]);
      const ofAccount = entry[1].account === account;
      if (!(ofBearer && bearerNeed > 0) && !(ofAccount && accountNeed > 0)) continue;
      victims.push(entry);
      if (ofBearer) bearerNeed--;
      if (ofAccount) accountNeed--;
    }
    if (bearerNeed > 0) return { full: 'bearer', holds: own.length };
    if (accountNeed > 0) return { full: 'account' };
    return { victims };
  };

  /**
   * Hold a suspended account to one session in all (OPL-5452): close its idle
   * sessions, whichever of its bearers opened them, in {@link closingOrder},
   * until it holds one or none idle is left. Never `keep` (the session being
   * served), and never one with a request in flight, which goes once it is
   * idle, at the next of these. Does nothing unless the account's standing
   * says suspended, so a self-hosted server, which has none, is untouched.
   *
   * A request whose body is still arriving has not reached its session yet,
   * so its session can look idle here; for a suspended account that costs
   * nothing, since the platform refuses every call it could make but whoami.
   */
  const enforceAccountSuspension = (account: string, keep?: string): void => {
    if (!accountSuspended(account)) return;
    const counted = sessionsOfAccount(account);
    const excess = counted.length - MAX_SESSIONS_SUSPENDED;
    if (excess <= 0) return;
    const idle = counted.filter(([id, live]) => id !== keep && live.active === 0);
    idle.sort(closingOrder);
    for (const [id, gone] of idle.slice(0, excess)) {
      sessions.delete(id);
      void gone.transport.close().catch(() => {});
    }
  };

  /**
   * {@link enforceAccountSuspension} for a session served under its own
   * bearer, whose account the platform may have named only since the session
   * was admitted: `bearerAccount` is what the bearer counts against NOW (its
   * probe's or cached acceptance's account). A session is counted against the
   * account key it was admitted under and is never re-keyed, so one admitted
   * while whoami named no account sits in a `bearer:` bucket that holds no
   * standing. When the bearer's account now differs from that and is
   * suspended, the bearer's own idle sessions go down to one as well, on the
   * account's standing as it is now: a newer-started probe that found the
   * account active leaves them be.
   */
  const enforceSuspensionFor = (
    live: Live,
    bearerAccount: string | undefined,
    keep: string | undefined,
  ): void => {
    if (
      bearerAccount !== undefined &&
      bearerAccount !== live.account &&
      accountSuspended(bearerAccount)
    ) {
      trimIdle(live.keyDigest, MAX_SESSIONS_SUSPENDED, keep);
    }
    enforceAccountSuspension(live.account, keep);
  };

  /**
   * Close this bearer's idle sessions, least recently seen first, until it
   * holds no more than `cap` or none idle is left. Never `keep`, and never one
   * with a request in flight: the same test the sweeper and an initialize's
   * room-making apply. Only a cap that has fallen needs this — an account
   * suspended after its bearer opened sessions (OPL-5448) — since an
   * initialize never admits a session over the cap it is checked against.
   */
  const trimIdle = (keyDigest: Buffer, cap: number, keep?: string): void => {
    const own = sessionsOf(keyDigest);
    const excess = own.length - cap;
    if (excess <= 0) return;
    const idle = own.filter(([id, live]) => id !== keep && live.active === 0);
    idle.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [id, gone] of idle.slice(0, excess)) {
      sessions.delete(id);
      void gone.transport.close().catch(() => {});
    }
  };

  const serving = async <T>(
    live: Live,
    handle: () => Promise<T>,
    heard: () => boolean = always,
  ): Promise<T> => {
    const release = beginActivity(live, heard);
    try {
      return await handle();
    } finally {
      // The socket may close while the tool keeps running. Releasing on
      // Response.close made the session look idle at that point, so a short
      // TTL could sweep and close its transport underneath handleRequest.
      // The work itself is the lifetime that matters.
      release();
    }
  };

  /**
   * Stamp a session as heard from, without claiming anything is in flight, on
   * open and on close, each only when `heard` allows it (see `beginActivity`).
   */
  const touch = (live: Live, res: Response, heard: () => boolean) => {
    if (heard()) live.lastSeen = Date.now();
    res.on('close', () => {
      if (heard()) live.lastSeen = Date.now();
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
    //
    // Expanded with and without the bound port, exactly as the loopback default
    // below is, and for the same reason: the SDK's check is a whole-header
    // `allowedHosts.includes(hostHeader)`, and a browser sends the port whenever
    // it is not the scheme's default. An operator writing the obvious
    // `MANDALA_ALLOWED_HOSTS=mcp.example.com` for a server bound on :3000 got a
    // list that matched no header any direct client sends, so every request was
    // answered 403 by the protection they had just turned on. See
    // {@link hostSpellings} for which entries are expanded and which are not.
    if (cfg.allowedHosts?.length) {
      return [
        ...new Set(
          cfg.allowedHosts.map((h) => h.toLowerCase()).flatMap((h) => hostSpellings(h, portNow)),
        ),
      ];
    }
    if (!isLoopbackHost(cfg.host)) return undefined;
    // `cfg.host` goes in as the spellings a client SENDS, which for a v6
    // literal means bracketed. Widening isLoopbackHost to accept
    // `::ffff:127.0.0.1` would otherwise have handed that bind a default
    // allowlist naming only the bare form — so a client using the address it
    // was given, `http://[::ffff:127.0.0.1]:port`, would be 403'd by
    // protection that had not existed there before.
    const bare = cfg.host.toLowerCase();
    const own = bare.startsWith('[') || !bare.includes(':') ? [bare] : [`[${bare}]`];
    const names = new Set(['127.0.0.1', 'localhost', '[::1]', ...own]);
    return [...names].flatMap((h) => [`${h}:${portNow}`, h]);
  }

  const allowedOrigins = cfg.allowedOrigins?.map((origin) => origin.toLowerCase());

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
      const name = raw[i].toLowerCase();
      if (name === 'host' || name === 'origin') raw[i + 1] = raw[i + 1].toLowerCase();
    }
    if (req.headers.host) req.headers.host = req.headers.host.toLowerCase();
    if (req.headers.origin) req.headers.origin = req.headers.origin.toLowerCase();
    next();
  });

  // Liveness is public; OCCUPANCY is not.
  //
  // `sessions` and `largeBodyParses` are the two caps this process enforces,
  // and their current values are the two numbers somebody would want in order
  // to time an exhaustion of either — how close the table is to 256, and
  // whether all four parse slots are taken right now. Unauthenticated, on an
  // exposed bind, that is a capacity oracle handed over on request.
  //
  // Kept where they are useful and the reader is one the operator meant: a
  // loopback bind, or a configured Host allowlist, which is the deliberate act
  // that says who may reach this server at all. Everywhere else the endpoint
  // still answers, still says the server is alive, and simply does not count
  // out loud.
  //
  // Neither of those is "the only readers are on this machine", and reasoning
  // that a loopback bind means that is what left this route counting for
  // anybody. A page on evil.example that has rebound its own name to 127.0.0.1
  // reaches a loopback bind through the browser, which treats the request as
  // same-origin — so the page reads the body of whatever comes back. That is
  // the exact reader the Host/Origin check on POST /mcp exists to turn away,
  // arriving one route to the left of it, which is why this route runs the same
  // check and counts only for a caller that passes it. Liveness stays public: a
  // rebinding page learns nothing from `{ok, name, version}` that the
  // connection succeeding has not already told it.
  const countsArePrivate = isLoopbackHost(cfg.host) || Boolean(cfg.allowedHosts?.length);
  app.get('/healthz', (req, res) => {
    const counts =
      countsArePrivate && !dnsRebindingRefusal(req, allowedHosts(boundPort), allowedOrigins);
    res.json({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      ...(counts ? { sessions: sessions.size, largeBodyParses } : {}),
    });
  });

  app.post('/mcp', parseBody, async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const key = bearer(req);

    // Hosted: EVERY request needs a bearer, initialize and tools/list included.
    // Orgo answers those two anonymously; refusing them is simpler, costs a
    // client nothing (it authorizes on the first 401 whichever request that
    // is), and means no McpServer is ever built for a caller with no credential.
    if (challenge && !key) {
      releaseLargeBody(res);
      return challenged(res, NO_TOKEN, rpcId(req));
    }

    if (sessionId) {
      let unpin = () => {};
      try {
        const live = sessions.get(sessionId);
        if (!live) return notFound(res, 'Unknown session. Initialize a new one.', rpcId(req));
        // The key is re-checked on every request, not only at initialize. A
        // session id travels in a plain header and is the sort of thing that ends
        // up in a proxy log; on its own it must not be a credential.
        if (!key || !sameKey(live.keyDigest, key)) {
          // Hosted: a different bearer is most often the SAME client after a
          // token refresh, and nothing this server can see proves that — an
          // access token is opaque, and the refresh token never comes here. So
          // the session is not rebound, which would hand its bound computer,
          // buffered events and retained results to whoever holds any valid
          // credential and the session id. It is answered as unknown instead,
          // which is the MCP spec's signal to initialize a new session; the new
          // bearer gets a new session, and this one is left to the idle sweep
          // (closing it here would let anyone with the id end it).
          if (challenge) {
            return notFound(res, 'Unknown session. Initialize a new one.', rpcId(req));
          }
          return unauthorized(res, 'This session belongs to a different API key.', rpcId(req));
        }
        // In flight from here, not only once it is dispatched: the bearer
        // check below awaits the platform, for up to BEARER_CHECK_TIMEOUT_MS on
        // a cache miss, and an initialize on the same bearer at its cap closes
        // an idle session to make room. Counted as busy through that wait, this
        // one is never the session closed under a request already routed to it
        // (OPL-5443). Only `active` is raised: a request refused below has not
        // been served, and does not stamp the session as heard from.
        live.active++;
        let pinned = true;
        unpin = () => {
          if (!pinned) return;
          pinned = false;
          live.active--;
        };
        if (challenge && live.refused) return challenged(res, refusedMessage(key), rpcId(req));
        // Checked before a request is dispatched, while the answer can still
        // be a 401 whatever the call goes on to do. A platform that cannot say
        // is not a refusal: the call goes ahead, and a real refusal during it
        // still reaches the client through the held answer or the mark.
        const request = carriesRequest(req.body);
        const checked = challenge && request ? await checkBearer(key) : undefined;
        const verdict = checked?.verdict;
        if (verdict === 'refused') {
          live.refused = true;
          return challenged(res, refusedMessage(key), rpcId(req));
        }
        // An account suspended after its bearers opened sessions kept every
        // one of them, while an initialize on it was held to one (OPL-5448).
        // Its other idle sessions go now, whichever of its bearers opened
        // them (OPL-5452), down to this one: it is pinned above, and one busy
        // elsewhere is skipped and closed at a later one of these once idle.
        // What decides is the account's standing as it is now, not the
        // verdict above: a newer-started probe of another bearer may have
        // found the account reinstated while this one awaited its own.
        // A request has just had its bearer's standing confirmed (or found it
        // cached). Anything else — a notification, a response — asks the
        // platform nothing, so it acts on the account's standing only while
        // its bearer's acceptance is cached: the standing is then no older
        // than that, and never an answer from long before a reinstatement.
        const confirmed = request ? verdict === 'ok' || verdict === 'suspended' : isAccepted(key);
        if (challenge && confirmed) {
          enforceSuspensionFor(
            live,
            request ? checked?.account : acceptance(key)?.account,
            sessionId,
          );
        }
        const lease = res.locals.largeBodyLease as LargeBodyLease | undefined;
        const id = rpcId(req);
        const held = challenge
          ? holdAnswer(res, () => challenged(res, refusedMessage(key), id))
          : undefined;
        return await heldAnswer.run(held, () =>
          requestBodyLease.run(lease, () =>
            serving(
              live,
              () => live.transport.handleRequest(req, res, req.body),
              // A request keeps the session as before: it was just put to
              // the platform, or found its acceptance cached. Anything else
              // keeps it only while that acceptance lasts.
              request ? always : heardWhileAccepted(key),
            ),
          ),
        );
      } finally {
        // serving() held its own lease across handleRequest, and a tool
        // callback that outlives it holds another through activity(), so the
        // pin can go once the route is done with the request.
        unpin();
        // A verified session is the only request allowed through the large
        // parser. Release the route's ownership here; a tool callback that
        // outlives handleRequest retains its own reference through activity().
        releaseLargeBody(res);
      }
    }
    // Sessionless requests always use the small parser. This no-op keeps the
    // ownership explicit if the parser policy changes later.
    releaseLargeBody(res);

    // Who is asking is settled before what they asked for. A sessionless
    // request that is not an initialize is a protocol mistake (400), but a
    // client with no credential, or one the platform refuses, has an auth
    // problem first — and a 400 "No session id" sent it looking at its session
    // handling when the fix was its key. So the key, the Host check and, hosted,
    // the bearer probe all run before the initialize test; only the session cap
    // and the build below are an initialize's alone.
    const initialize = isInitializeRequest(req.body);
    if (!key) {
      return unauthorized(
        res,
        'Send your Mandala API key as a bearer token: Authorization: Bearer com_…',
        rpcId(req),
      );
    }
    // Host/Origin are already decided, and constructing the McpServer is the
    // expensive part of an initialize. Checked here so a DNS-rebinding POST
    // never pays that cost, never takes a pending slot, and is 403 even when
    // the session cap is full — occupancy is not the answer to a Host the
    // operator never served (adversarial review, OPL-4314).
    const hosts = allowedHosts(boundPort);
    const refused = dnsRebindingRefusal(req, hosts, allowedOrigins);
    if (refused) return rpcError(res, 403, -32000, refused, rpcId(req));
    // Hosted: no session for a bearer the platform does not accept. Before the
    // cap and the reservation, so a refused bearer never holds a slot.
    let checkedAccount: string | undefined;
    if (challenge) {
      // A spent budget does not close the address. Many clients can share one
      // (a NAT, an office), and one bad neighbour must not lock out the rest:
      // a bearer the platform already accepted passes outright, and a new one
      // still gets a probe — but at most one per interval per spent address,
      // taken when the probe starts, so the address costs the platform one probe per
      // interval however hard it pushes, and a valid client there waits at
      // most one interval. The process-wide cap on probes bounds the total.
      const spent = !isAccepted(key) && overFailureBudget(req) !== undefined;
      if (spent) {
        const entry = failures.get(sourceOf(req));
        const wait =
          entry?.lastProbeAt !== undefined ? entry.lastProbeAt + exhaustedInterval - Date.now() : 0;
        if (wait > 0) {
          res.set('Retry-After', String(Math.max(1, Math.ceil(wait / 1000))));
          return rpcError(
            res,
            429,
            -32002,
            'Too many refused tokens from this address. Retry later with a valid token.',
            rpcId(req),
          );
        }
      }
      // The interval is spent only by a probe that starts: a request turned
      // away because the process-wide cap is full reached nobody, and must not
      // make the next client at this address wait out an interval for it.
      const { verdict, account } = await checkBearer(
        key,
        spent
          ? () => {
              const entry = failures.get(sourceOf(req));
              if (entry) entry.lastProbeAt = Date.now();
            }
          : undefined,
      );
      if (verdict === 'refused') {
        noteFailure(req);
        return challenged(res, refusedMessage(key), rpcId(req));
      }
      // Not an initialize, it is a 400 whatever the platform could say about
      // the key short of refusing it.
      if (verdict === 'unknown' && initialize) {
        return unavailable(
          res,
          'The platform could not confirm this token just now. Retry shortly.',
          rpcId(req),
        );
      }
      checkedAccount = account;
    }
    if (!initialize) {
      return badRequest(res, 'No session id, and this is not an initialize request.', rpcId(req));
    }
    // One bearer may not hold the whole pool (OPL-5443), nor one account more
    // than its ceiling however many bearers it holds (OPL-5447). Both counted
    // before the process-wide cap, so a bearer that can make room by closing
    // one of its idle sessions frees a process-wide slot as well. From the
    // count to the reservation below is synchronous, so a burst cannot all
    // read the same count.
    const keyDigest = digest(key);
    const keyId = keyDigest.toString('hex');
    // Hosted, the account the platform confirmed for this bearer (or the
    // bearer itself, when whoami named none); self-hosted, the bearer.
    const account = checkedAccount ?? accountKey(keyId, undefined);
    // The account's standing, read after the check above (OPL-5452): what the
    // newest-started probe of ANY of its bearers said, not only this one's.
    // Self-hosted there is none, and nothing is suspended.
    const suspended = accountSuspended(account);
    const bearerCap = suspended ? MAX_SESSIONS_SUSPENDED : maxPerBearer;
    // A bearer, or a suspended account, can hold more than its limit only when
    // the limit fell under it: an account suspended after it opened sessions
    // (OPL-5448, OPL-5452). Those over it are closed first if idle, whatever
    // becomes of this initialize, so what is left to count, and to name in a
    // 429, is what it really holds.
    enforceAccountSuspension(account);
    trimIdle(keyDigest, bearerCap);
    const tooMany = (message: string) => {
      res.set('Retry-After', String(BEARER_FULL_RETRY_AFTER_S));
      return rpcError(res, 429, -32002, message, rpcId(req));
    };
    // Room is made from this bearer's own IDLE sessions, least recently seen
    // first, exactly as the sweeper would close them, under whichever limit
    // binds: its own cap or its account's ceiling. Never another bearer's live
    // session, and never one with a request in flight: past the ceiling an
    // initialize is refused, since the account's holder is the one who knows
    // which of its clients can spare a session. Two exceptions (see
    // `planRoom`): an idle session of the account's whose bearer the platform
    // refused, and, while the account is suspended, any idle session of the
    // account's, since it holds one in all (OPL-5452). A client whose old
    // session is gone gets 404 for it and
    // initializes again, as MCP clients do. Decided here, so a caller with
    // nothing idle to give back is refused at once; carried out only once the
    // new session exists (in `onsessioninitialized`), so an initialize the SDK
    // then refuses (406, 415, 400) or that throws on the way does not also
    // cost the caller a working session. Only the number is kept past here.
    let planned = 0;
    {
      const room = planRoom(
        keyDigest,
        account,
        suspended,
        pendingByDigest.get(keyId) ?? 0,
        pendingByAccount.get(account) ?? 0,
      );
      if ('full' in room) {
        if (room.full === 'account') {
          return tooMany(
            suspended ? SUSPENDED_ACCOUNT_FULL : accountFullMessage(account, maxPerAccount),
          );
        }
        // Over the cap after the trim means every session over it is busy,
        // and closing one would not be enough: the client can only wait.
        return tooMany(
          room.holds > bearerCap
            ? `This token holds ${room.holds} sessions on this server, over its maximum of ${bearerCap}, and the ones over it are all serving a request. Retry once they finish; idle ones are closed to make room.`
            : `This token already holds its maximum of ${bearerCap} ${bearerCap === 1 ? 'session' : 'sessions'} on this server. Close one (DELETE /mcp) or retry shortly.`,
        );
      }
      planned = room.victims.length;
    }
    // Swept sessions free their slot on the timer; this is the backstop for the
    // case the timer cannot help with, which is arrivals faster than the TTL.
    // The sessions this initialize will close are still in the map, and are not
    // counted against it: a bearer making room in its own share is not newly
    // refused for the room it is about to give back. Nothing is closed to make
    // room here, whoever holds the pool.
    if (sessions.size - planned + pending >= maxSessions) {
      res.set('Retry-After', String(POOL_FULL_RETRY_AFTER_S));
      return unavailable(
        res,
        `This server is holding its maximum of ${maxSessions} sessions. Retry shortly.`,
        rpcId(req),
      );
    }
    pending++;
    pendingByDigest.set(keyId, (pendingByDigest.get(keyId) ?? 0) + 1);
    pendingByAccount.set(account, (pendingByAccount.get(account) ?? 0) + 1);
    // Released exactly once, whether the initialize lands in the map or throws
    // on the way there. A reservation that leaked on the failure path would
    // ratchet the cap down until the process restarted — every later initialize
    // refused with 503 for the life of the process, which is the denial of
    // service the counter was added to prevent, self-inflicted. The per-bearer
    // and per-account counts leaking would do the same to that bearer and that
    // account.
    let reserved = true;
    const release = () => {
      if (reserved) {
        reserved = false;
        pending--;
        const left = (pendingByDigest.get(keyId) ?? 1) - 1;
        if (left > 0) pendingByDigest.set(keyId, left);
        else pendingByDigest.delete(keyId);
        const accountLeft = (pendingByAccount.get(account) ?? 1) - 1;
        if (accountLeft > 0) pendingByAccount.set(account, accountLeft);
        else pendingByAccount.delete(account);
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
    let mcp: ReturnType<typeof createServer> | undefined;
    let finishInitialize = () => {};
    // Set when the session was dropped at birth for want of room (see
    // `onsessioninitialized`): it has an id but no map slot.
    let dropped = false;
    try {
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        ...(cfg.sseKeepAliveMs !== undefined ? { keepAliveMs: cfg.sseKeepAliveMs } : {}),
        // On whenever there is a list to check against, which for a loopback
        // bind is always — see `allowedHosts`. A browser cannot be stopped from
        // resolving a name it controls to 127.0.0.1, so the Host header is the
        // only thing separating the operator's own client from a page the user
        // happened to open, and the MCP spec asks a locally-bound server to
        // check it.
        enableDnsRebindingProtection: Boolean(hosts?.length || allowedOrigins?.length),
        allowedHosts: hosts,
        allowedOrigins,
        onsessioninitialized: (id) => {
          // The room the check above planned, made now that there is a session
          // to make it for. Chosen again from what is here NOW: a session
          // closed or put to work since then is not a candidate. Should too
          // few still be idle, nothing is closed and this session is dropped
          // instead of admitted over the cap. The transport closes before the
          // SDK answers, so the SDK answers this initialize itself, with its
          // 404 -32001 'Session not found' and no Retry-After — not the 429
          // the refusal above gives, which cannot be written from here. An
          // SDK client surfaces that as a failed connect; it does not retry
          // on its own. Only a race reaches this: a request landing on a
          // planned session between the check above and this callback.
          //
          // The account's ceiling is re-checked here too (OPL-5447), against
          // the map alone. Initializes still pending were each admitted
          // counting this one's reservation, and the room they will make is
          // still in the map, so counting them again here would drop a session
          // that fits; what keeps a burst under the ceiling is the pending
          // count at admission. Every landing leaves the map within both.
          // The account's standing is read again: a probe that answered in
          // between is the newer word on whether it is suspended.
          const room = planRoom(keyDigest, account, accountSuspended(account), 0, 0);
          if ('full' in room) {
            dropped = true;
            release();
            void t.close().catch(() => {});
            return;
          }
          for (const [other, gone] of room.victims) {
            sessions.delete(other);
            void gone.transport.close().catch(() => {});
          }
          const live: Live = {
            transport: t,
            keyDigest,
            account,
            lastSeen: Date.now(),
            // Initialize is already in flight when the session first becomes
            // visible to the sweeper. Count it until handleRequest settles.
            active: 1,
            refused: false,
          };
          sessions.set(id, live);
          let held = true;
          finishInitialize = () => {
            if (!held) return;
            held = false;
            live.active--;
            live.lastSeen = Date.now();
          };
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
        activity: () => {
          const id = t.sessionId;
          const live = id ? sessions.get(id) : undefined;
          const finishActivity = live ? beginActivity(live) : () => {};
          const finishBody = requestBodyLease.getStore()?.retain();
          return () => {
            finishBody?.();
            finishActivity();
          };
        },
        // Per-caller, and deliberately with no fallback to cfg.modelKey: an
        // operator who set MANDALA_MODEL_KEY for their own stdio use would
        // otherwise be billed for every stranger's run here. Absent means
        // run_agent is simply not offered to this session.
        modelKey: req.header(MODEL_KEY_HEADER)?.trim() || undefined,
        // Dropped for the same reason, one field further on. MANDALA_COMPUTER_ID
        // is the operator's own machine, and spreading it into a stranger's
        // session pre-binds their key to a computer on somebody else's account:
        // every call until they run use_computer 404s, and the id of a machine
        // that is not theirs is named back to them by way of explanation.
        computerId: undefined,
        platform: {
          serviceSecret,
          // Hosted only. Marks the session, so the NEXT request on this bearer
          // is refused before dispatch, and turns the request in flight into a
          // 401 if nothing of its answer has been sent yet.
          onBearerRefused: challenge
            ? () => {
                const id = t.sessionId;
                const live = id ? sessions.get(id) : undefined;
                if (live) live.refused = true;
                heldAnswer.getStore()?.refuse();
              }
            : undefined,
        },
      });
      mcp = server;
      await server.connect(t);
      const handled = await t.handleRequest(req, res, req.body);
      // Any initialize that never reached `onsessioninitialized`, or was
      // dropped there, has no map slot and nothing the sweeper will reap. The
      // SDK's 403 used to take this path without throwing; other early returns
      // still can.
      if (!t.sessionId || dropped) {
        void server.close().catch(() => {});
        void t.close().catch(() => {});
      }
      return handled;
    } catch (err) {
      // `onsessioninitialized` fires from inside handleRequest, so by the time
      // anything past it throws the session is already in the map — holding a
      // maxSessions slot and a key digest, under an id the client never learned
      // and so can never DELETE. Left alone it sits there until the TTL sweep
      // half an hour later, and enough of them ratchet the cap to zero.
      if (transport?.sessionId) sessions.delete(transport.sessionId);
      if (mcp) void mcp.close().catch(() => {});
      else if (transport) void transport.close().catch(() => {});
      throw err;
    } finally {
      finishInitialize();
      release();
    }
  });

  // The server-to-client stream, and session teardown. Both are addressed by
  // session id alone in the protocol, so both re-check the key for the reason
  // the POST does.
  const bySession = async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const key = bearer(req);
    if (challenge && !key) return challenged(res, NO_TOKEN);
    const live = sessionId ? sessions.get(sessionId) : undefined;
    if (!live) return notFound(res, 'Unknown session.');
    if (!key || !sameKey(live.keyDigest, key)) {
      // As on POST: hosted answers a different bearer as an unknown session.
      if (challenge) return notFound(res, 'Unknown session.');
      return unauthorized(res, 'This session belongs to a different API key.');
    }
    // The stream is refused on a token the platform has already refused; a
    // DELETE is still honoured, since the digest shows it is the holder.
    if (challenge && live.refused && req.method === 'GET')
      return challenged(res, refusedMessage(key));
    // A suspended account is held to one session on its stream too, as on a
    // notification: the stream asks the platform nothing, so only while this
    // bearer's acceptance is cached (OPL-5452). This session is the one kept.
    if (challenge && req.method !== 'DELETE' && isAccepted(key)) {
      enforceSuspensionFor(live, acceptance(key)?.account, sessionId);
    }
    // The GET is the notification stream and is only noted; anything else
    // here (a DELETE, or a HEAD, which Express routes to the GET handler with
    // the method unchanged) is held for while the SDK handles it. See
    // `serving`. None of it is put to the platform, so none of it may keep the
    // session from idling out once the token's acceptance lapses: a HEAD is
    // answered 405 and a DELETE the SDK refuses (an unsupported protocol
    // version, say) 400, both leaving the session open, and a revoked token's
    // holder could otherwise send either for ever to keep its sessions, and
    // its account's ceiling, held (OPL-5455). A DELETE that succeeds closes
    // the session anyway, and `active` is counted whatever `heard` says.
    if (req.method === 'GET') {
      touch(live, res, heardWhileAccepted(key));
      return live.transport.handleRequest(req, res);
    }
    return serving(live, () => live.transport.handleRequest(req, res), heardWhileAccepted(key));
  };
  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);

  // Express's default 404 is HTML. Keep every answer from this MCP-facing
  // server in the JSON-RPC shape its clients can surface, even when the path
  // itself was wrong.
  app.use((req, res) =>
    notFound(res, `Unknown path: ${req.method} ${req.path}. Use /mcp or /healthz.`, rpcId(req)),
  );

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
          ? tooLargeMessage(_req, sessions)
          : typeof e.message === 'string'
            ? e.message
            : 'This request body could not be read.';
      return rpcError(res, e.status, -32000, message, rpcId(_req));
    }
    console.error('mandala-computer-mcp: unhandled error serving a request', err);
    return rpcError(res, 500, -32603, 'This server failed while serving the request.', rpcId(_req));
  });

  return new Promise((resolve, reject) => {
    let listening = false;
    const http = app.listen(cfg.port, cfg.host, (err?: Error) => {
      // Express 5 also calls this listener on a bind error.
      if (err) {
        clearInterval(sweeper);
        reject(err);
        return;
      }
      listening = true;
      // The bound port, not the requested one. `port()` deliberately accepts 0,
      // which means "any free port" — and printing it back gives the operator
      // http://127.0.0.1:0/mcp, a URL that cannot be used to reach the server
      // they were just told was up.
      const addr = http.address();
      const bound = typeof addr === 'object' && addr ? addr.port : cfg.port;
      boundPort = bound;
      console.error(
        metadataUrl
          ? `mandala-computer-mcp on http://${cfg.host}:${bound}/mcp — OAuth: callers without a bearer are sent to ${metadataUrl}`
          : `mandala-computer-mcp on http://${cfg.host}:${bound}/mcp — callers authenticate with their own Mandala API key`,
      );
      // Said, never shown: whether the secret is set is the useful fact.
      if (metadataUrl && !serviceSecret) {
        console.error(
          '  MANDALA_MCP_SERVICE_SECRET is not set — the platform accepts OAuth access tokens only with it, so every tool call will be refused',
        );
      }
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

const DEFAULT_BEARER_CHECK_TTL_MS = 60_000;
const DEFAULT_MAX_FAILED_INITIALIZES = 20;
const DEFAULT_EXHAUSTED_PROBE_INTERVAL_MS = 5_000;
const FAILURE_WINDOW_MS = 60_000;
const BEARER_CHECK_TIMEOUT_MS = 10_000;
/** How many bearers this server will be asking the platform about at once. */
const MAX_BEARER_CHECKS_IN_FLIGHT = 32;
const MAX_ACCEPTED_BEARERS = 4096;
const MAX_FAILURE_SOURCES = 10_000;

/**
 * Whether a whoami record says its account is suspended.
 *
 * Only an explicit `account.status` of `"suspended"` counts. A record this
 * cannot read is not evidence of suspension, and treating it as such would hold
 * a working account to one session on the strength of a shape change.
 */
function isSuspended(who: unknown): boolean {
  if (typeof who !== 'object' || who === null) return false;
  const account = (who as { account?: unknown }).account;
  if (typeof account !== 'object' || account === null) return false;
  return (account as { status?: unknown }).status === 'suspended';
}

/**
 * The account id a whoami record names: a non-empty string of at most 256
 * characters. Anything else is no account, and the bearer then counts as an
 * account of its own rather than as one this server could not confirm.
 */
function accountIdOf(who: unknown): string | undefined {
  if (typeof who !== 'object' || who === null) return undefined;
  const account = (who as { account?: unknown }).account;
  if (typeof account !== 'object' || account === null) return undefined;
  const id = (account as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : undefined;
}

/**
 * What a session counts against for the account ceiling (OPL-5447).
 *
 * The account id the platform confirmed for the bearer when there is one
 * (hosted mode), and otherwise the bearer's own digest: a hosted whoami that
 * names no account, and every bearer on a self-hosted server, which verifies
 * none and so puts no trust in a string it cannot check. Prefixed so the two
 * can never name the same thing.
 */
function accountKey(keyId: string, confirmed: string | undefined): string {
  return confirmed !== undefined ? `account:${confirmed}` : `bearer:${keyId}`;
}

/**
 * The 429 for a suspended account with nothing idle to give up (OPL-5452):
 * its session is serving a request, or another initialize of its is in
 * flight. An idle one would have been closed to make room.
 */
const SUSPENDED_ACCOUNT_FULL =
  'This account is suspended, so it may hold only 1 session on this server across all its tokens, and none it holds is idle. Retry once its session finishes its request, or close it (DELETE /mcp).';

/** The 429 for an account at its ceiling. It names the limit and nothing else. */
function accountFullMessage(account: string, cap: number): string {
  const noun = cap === 1 ? 'session' : 'sessions';
  return account.startsWith('account:')
    ? `This account has reached its maximum of ${cap} ${noun} on this server, across all its tokens. Close one (DELETE /mcp) or retry shortly.`
    : `This token has reached the per-account maximum of ${cap} ${noun} on this server, as an account of its own. Close one (DELETE /mcp) or retry shortly.`;
}

const always = () => true;

/**
 * The order idle sessions are closed in to make room: those whose bearer the
 * platform has refused first, since nothing more is served on them, then the
 * least recently seen.
 */
function closingOrder(a: [string, Live], b: [string, Live]): number {
  return Number(b[1].refused) - Number(a[1].refused) || a[1].lastSeen - b[1].lastSeen;
}

/** Whether a POST body holds a JSON-RPC request, which is what opens a stream. */
function carriesRequest(body: unknown): boolean {
  const isRequest = (m: unknown) =>
    typeof m === 'object' && m !== null && 'method' in m && 'id' in m;
  return Array.isArray(body) ? body.some(isRequest) : isRequest(body);
}

const NO_TOKEN =
  'Authorization required. Authorize this client with Mandala (OAuth), or send a Mandala API key: Authorization: Bearer …';
const TOKEN_REFUSED =
  'The platform no longer accepts this access token. Refresh it, or authorize again.';
const API_KEY_REFUSED =
  'The platform does not accept this API key. Check it, or create a new one in Settings → Credentials.';

/**
 * What a refused bearer is told. A `com_…` API key was never an OAuth access
 * token and cannot be refreshed, so it is not told to refresh (OPL-5464); any
 * other bearer is an access token and keeps the OAuth wording. Only the message
 * text differs — the 401 and its challenge are the same — and the bearer itself
 * is never part of it.
 */
function refusedMessage(key: string | undefined): string {
  return key?.startsWith('com_') ? API_KEY_REFUSED : TOKEN_REFUSED;
}

/**
 * Hold a response's status line until its first byte of body (hosted mode).
 *
 * A Streamable HTTP POST answers 200 and opens its event stream the moment the
 * request is dispatched, long before a tool reaches the platform — so a token
 * the platform refuses could only ever come back as a tool error inside a 200,
 * which no MCP client treats as "refresh your token". Deferring `writeHead`
 * and `flushHeaders` until the first write lets that refusal become the 401
 * the client acts on instead: the platform's 401 is reported before the tool
 * has produced anything, so the first write finds the answer already refused.
 *
 * The first byte of anything — a result, a progress notification, the SDK's
 * keep-alive comment — commits the stream, and a refusal after that stays a
 * tool error. The session is marked either way, so the next request carrying
 * the refused bearer gets the 401 before it is dispatched.
 */
function holdAnswer(res: Response, answer401: () => void): HeldAnswer {
  type Writer = (...args: unknown[]) => unknown;
  const target = res as unknown as Record<string, Writer>;
  const names = ['writeHead', 'flushHeaders', 'write', 'end'] as const;
  const own = Object.fromEntries(names.map((n) => [n, target[n]])) as Record<
    (typeof names)[number],
    Writer
  >;
  const deferred: Array<() => void> = [];
  let state: 'holding' | 'released' | 'refused' = 'holding';

  const restore = () => {
    for (const n of names) target[n] = own[n];
  };
  const release = () => {
    if (state !== 'holding') return;
    state = 'released';
    restore();
    for (const replay of deferred.splice(0)) replay();
  };
  const refuse = () => {
    if (state !== 'holding') return;
    state = 'refused';
    restore();
    if (!res.headersSent && !res.writableEnded && !res.destroyed) answer401();
    // Whatever the transport still writes belongs to the answer that was
    // replaced, and writing after end would raise an unhandled 'error'.
    target.writeHead = () => res;
    target.flushHeaders = () => undefined;
    target.write = (...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
      cb?.();
      return true;
    };
    target.end = (...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
      cb?.();
      return res;
    };
  };

  target.writeHead = (...args: unknown[]) => {
    if (state !== 'holding') return target.writeHead.apply(res, args);
    deferred.push(() => own.writeHead.apply(res, args));
    return res;
  };
  target.flushHeaders = (...args: unknown[]) => {
    if (state !== 'holding') return target.flushHeaders.apply(res, args);
    deferred.push(() => own.flushHeaders.apply(res, args));
    return undefined;
  };
  target.write = (...args: unknown[]) => {
    release();
    return target.write.apply(res, args);
  };
  target.end = (...args: unknown[]) => {
    release();
    return target.end.apply(res, args);
  };
  return { refuse };
}

/**
 * Whether this request is allowed through the 96mb parser.
 *
 * Shared with the 413 handler so a verified session that actually hit that
 * ceiling is not told to initialize for 256KB.
 */
function wouldUseLargeParser(req: Request, sessions: Map<string, Live>): boolean {
  const id = req.header('mcp-session-id');
  const live = id ? sessions.get(id) : undefined;
  const key = bearer(req);
  const verified = Boolean(live && key && sameKey(live.keyDigest, key));
  const declared = declaredLength(req);
  const mayBeLarge = declared === undefined || declared > SMALL_BODY_BYTES;
  return verified && mayBeLarge;
}

/**
 * The body's length as the request DECLARED it, or `undefined` for a request
 * that did not declare one this server can use.
 *
 * A chunked upload sends no `Content-Length` at all, and a malformed one is
 * worth no more than an absent one — so both answer `undefined`, and the
 * distinction that matters downstream is "the size is known" against "it is
 * not", never the raw header text.
 */
function declaredLength(req: Request): number | undefined {
  const raw = req.header('content-length');
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

function tooLargeMessage(req: Request, sessions: Map<string, Live>): string {
  return wouldUseLargeParser(req, sessions)
    ? 'Request body is too large. This established session accepts at most 96MB.'
    : 'Request body is too large. Bodies above 256KB are accepted only on an established session, by a caller whose key matches it — initialize first, then send this there.';
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
type RpcId = string | number | null;

function rpcId(req: Request): RpcId {
  const id = (req.body as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : null;
}

const rpcError = (
  res: Response,
  status: number,
  code: number,
  message: string,
  id: RpcId = null,
) => {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id });
};
const badRequest = (res: Response, m: string, id: RpcId = null) =>
  rpcError(res, 400, -32000, m, id);
const unauthorized = (res: Response, m: string, id: RpcId = null) =>
  rpcError(res, 401, -32001, m, id);
const notFound = (res: Response, m: string, id: RpcId = null) => rpcError(res, 404, -32001, m, id);
const unavailable = (res: Response, m: string, id: RpcId = null) =>
  rpcError(res, 503, -32002, m, id);
