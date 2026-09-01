import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';
import {
  type APIError,
  CancelledError,
  ConnectivityError,
  ConnectivityInterruptedError,
  errorForStatus,
  MandalaError,
  RangeNotSatisfiableError,
  RateLimitError,
} from './errors.js';

export const DEFAULT_BASE_URL = 'https://app.mandala.computer/api/v1';

/** Anthropic's own key, forwarded for the one route that runs a model. */
export const MODEL_KEY_HEADER = 'X-Model-Key';

export type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Raw bytes as the request body, for the file upload. Mutually exclusive with `body`. */
  raw?: Uint8Array;
  /** Extra headers for this call only — currently just the model key. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type Bytes = {
  bytes: Uint8Array;
  contentType: string;
  /** From Content-Disposition, when the platform named the file. */
  filename?: string;
  /** True when the response was deliberately stopped at the caller's cap. */
  truncated: boolean;
  /**
   * Exact size when the response declared one, or when it fitted in full.
   *
   * On a `206` this is the WHOLE file's length, off `Content-Range`, and not
   * the length of the window that came back — which is the number a caller
   * paging through a file needs and the only place it appears.
   */
  totalBytes?: number;
  /**
   * Which bytes of the file these are, when the platform served a window.
   *
   * Present only on a `206`, because that status is the only promise that the
   * `Range` was honoured. A `200` may perfectly well be a response to a request
   * that carried one — an unmeasurable file has no byte positions to name, so
   * the platform ignores the header and sends the whole thing — and reporting
   * the head of a file as the window somebody asked for is how a paging loop
   * reads the same bytes forever.
   *
   * `total` is absent for a `Content-Range` whose total is `*`: the window is
   * known and the file's length is not.
   */
  window?: { start: number; end: number; total?: number };
  /**
   * True when the response said this file cannot be served in windows at all.
   *
   * `Accept-Ranges: none`, which the platform sets for a file whose length the
   * guest could not measure — a `/proc` entry, say. Worth keeping apart from a
   * merely absent window, because it is the difference between "ask again
   * differently" and "there is no offset that will work on this file".
   */
  unrangeable: boolean;
};

/**
 * How much of an event stream will be held while waiting for a boundary.
 *
 * Generous for any real event — a run's steps are small — and finite, which is
 * the point: without it a stream that never sends a blank line is buffered
 * until the process runs out of memory.
 */
const MAX_SSE_BUFFER = 8 * 1024 * 1024;

/** Finite response-body ceilings for the two paths that decode text. */
const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 1024 * 1024;

/**
 * The longest guest exec waits 300 seconds before it answers. Node's bundled
 * fetch also gives response headers 300 seconds by default, so the client can
 * lose that race while the command is still finishing in the guest. Keep the
 * public exec limit and give the platform enough time to report its timeout.
 *
 * The body is a different clock. undici's default `bodyTimeout` is 300 seconds
 * of silence *between chunks*, and `run_agent` SSE (or a long exec that has
 * already sent headers) can sit quiet after that. Raising only the header
 * allowance left those streams aborting on the default idle limit. Zero
 * disables it: a quiet gap is not a dead connection, and the caller's
 * AbortSignal is what ends a request nobody is waiting for.
 */
export const PLATFORM_HEADERS_TIMEOUT_MS = 330_000;
/** Disabled. A finite idle limit is what used to kill a quiet SSE stream. */
export const PLATFORM_BODY_TIMEOUT_MS = 0;
const PLATFORM_DISPATCHER = new Agent({
  headersTimeout: PLATFORM_HEADERS_TIMEOUT_MS,
  bodyTimeout: PLATFORM_BODY_TIMEOUT_MS,
});

/**
 * `globalThis.fetch` as it was before anything replaced it.
 *
 * Captured so {@link platformFetch} can tell "nobody has touched this" from "a
 * test or an embedder installed their own", which are the two cases that need
 * opposite answers below.
 */
const NATIVE_FETCH = globalThis.fetch;

/**
 * The fetch a platform request actually goes through, and why it is not simply
 * `fetch`.
 *
 * The dispatcher above is an Agent from the `undici` PACKAGE, and Node's
 * built-in fetch is a DIFFERENT COPY of undici — the one bundled with the
 * runtime. Handing one's Agent to the other's fetch works only while the two
 * agree on the internal handler interface, and they have stopped agreeing:
 * Node 26 bundles undici 8.9, whose fetch passes a handler that undici 6's
 * Agent rejects outright with `invalid onError method`. That surfaces here as
 * `fetch failed`, which this class then wraps as "could not reach
 * app.mandala.computer" — so on Node 26 every call this server makes reported
 * the platform as down, before a packet was sent.
 *
 * NOT FIXABLE BY A VERSION BUMP, which is the thing worth writing down: npm's
 * newest undici is 7.x and Node 26 bundles 8.x, so no dependency this package
 * can declare matches what the runtime carries — and even if one did, matching
 * Node 26 would mean mismatching Node 20, which `engines` still admits. Two
 * undicis is the bug; using one of them for both halves is the fix.
 *
 * So the request goes through undici's OWN fetch, which understands its own
 * Agent on every Node. The global is still preferred when something has
 * replaced it: that is how the tests stand a stub in front of the platform, and
 * an embedder that installs an instrumented fetch means it to be used.
 */
export const platformFetch = (): typeof globalThis.fetch =>
  globalThis.fetch === NATIVE_FETCH
    ? (undiciFetch as unknown as typeof globalThis.fetch)
    : globalThis.fetch;

/** One server-sent event off the agent route. */
export type SSEEvent = { event: string; data: unknown };

/**
 * The transport for one API key.
 *
 * One per MCP session rather than one per process, because the HTTP transport
 * authenticates each caller with their own `com_…` key and two sessions must
 * never share a client. See `src/session.ts`.
 *
 * The key lives in this object's closure and is never put on an error, a log
 * line, or a tool result. That is not paranoia about our own code: an MCP tool
 * result goes into a model's context and from there into transcripts, and an
 * API key is every computer on the account, forever.
 */
export class Api {
  readonly baseUrl: string;
  /** The same thing parsed, so a path is joined onto the path and nothing else. */
  readonly #base: URL;
  readonly #apiKey: string;
  readonly #headers: Record<string, string>;
  /** Applied to every request that does not carry one of its own. See `with`. */
  readonly #signal?: AbortSignal;

  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL, signal?: AbortSignal) {
    if (!apiKey) {
      throw new MandalaError(
        'No API key. Set MANDALA_API_KEY (create one at Settings → API keys), ' +
          'or send it as a bearer token when running over HTTP.',
      );
    }
    // Validated here rather than at the first request. An unusable base URL is
    // a configuration mistake, and the place to report one is where it is set —
    // not in the middle of a tool call, and not, as it was, from a startup log
    // line that threw after the transport had already come up and the client
    // was waiting on it.
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new MandalaError(
        `not a valid base URL: ${baseUrl}. Set MANDALA_BASE_URL to an absolute http(s) URL, e.g. ${DEFAULT_BASE_URL}`,
      );
    }
    // The scheme the message already promised. `new URL` alone accepts
    // `file:`, `ftp:` and anything else with a colon in it, so a typo that
    // parsed was carried all the way to a fetch that fails with something about
    // the protocol — a message about the request, in a place that was supposed
    // to be about the setting.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new MandalaError(
        `not an http(s) base URL: ${baseUrl}. Set MANDALA_BASE_URL to an absolute http(s) URL, e.g. ${DEFAULT_BASE_URL}`,
      );
    }
    // Normalised as a URL rather than as a string. `${base}/${path}` looked
    // equivalent and is not, because a base may carry a query — a tenant or an
    // API version — and string concatenation appends the path *into* the search
    // string: `https://h/api/v1?t=x` + `computers` is
    // `https://h/api/v1?t=x/computers`, a request to /api/v1 with a nonsense
    // parameter rather than to the route the tool asked for. The trailing-slash
    // strip had the same blind spot, since the slash is no longer last.
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    this.#base = parsed;
    // Still the string that was given, minus the trailing slashes it was always
    // stripped of — this is what error messages name and what `with` re-parses,
    // and changing its spelling would change what a reader is told they
    // configured.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.#apiKey = apiKey;
    this.#signal = signal;
    this.#headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
  }

  /**
   * This same client, with every request bound to one tool call's cancellation.
   *
   * MCP hands a tool handler an `AbortSignal` that fires when the client gives
   * up on the call, and a request nobody is waiting for is one this server
   * should stop making — most of all in the tools that poll. A cancelled
   * `wait_for_computer` would otherwise go on asking the platform about a
   * computer for the rest of its `timeout_s`, which reaches fifteen minutes.
   *
   * Bound per call rather than per session, because a session serves many calls
   * at once and one of them being abandoned says nothing about the others.
   */
  with(signal: AbortSignal | undefined): Api {
    if (!signal || signal === this.#signal) return this;
    return new Api(this.#apiKey, this.baseUrl, signal);
  }

  #url(path: string, query?: RequestOptions['query']): string {
    const url = new URL(this.#base);
    // Onto the path component, keeping whatever the base carried in its query.
    // A base's own parameters are part of how it was addressed — a tenant, a
    // version — and dropping them would send the request somewhere else just as
    // surely as appending the path to them did.
    //
    // A root pathname contributes NOTHING rather than its slash. The constructor
    // strips trailing slashes, but a base that is only an origin has `/` for a
    // pathname and the WHATWG setter puts it straight back — so the join wrote
    // `https://gateway.example.com//computers`, a double slash that is a
    // different path to any router that normalises and a 404 to one that does
    // not. Invisible on the default base, which carries `/api/v1`; the case it
    // breaks is a self-hosted MANDALA_BASE_URL whose API sits at the root.
    const base = url.pathname === '/' ? '' : url.pathname;
    url.pathname = `${base}/${path.replace(/^\/+/, '')}`;
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async #fetch(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...this.#headers, ...opts.headers };
    // Typed as what we actually build rather than as BodyInit, which @types/node
    // does not put in the global scope.
    let body: string | Uint8Array | undefined;
    if (opts.raw !== undefined) {
      // The file upload's body IS the file. Content-Type is deliberately
      // octet-stream rather than guessed from the path: the platform writes the
      // bytes it is given and never looks, and a wrong guess here would be a
      // claim about a file we did not read.
      headers['Content-Type'] = 'application/octet-stream';
      body = opts.raw;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    const signal = opts.signal ?? this.#signal;
    let resp: Response;
    try {
      // `dispatcher` is Node/undici's extension to RequestInit. It is kept on
      // a typed variable so the standard fetch signature can still be used.
      const init: RequestInit & { dispatcher: Dispatcher } = {
        method,
        headers,
        body,
        signal,
        dispatcher: PLATFORM_DISPATCHER,
      };
      resp = await platformFetch()(this.#url(path, opts.query), init);
    } catch (cause) {
      // Cancellation first, because it is not a connectivity failure and the
      // wrap below cannot tell the difference. An aborted fetch rejects with a
      // bare `This operation was aborted`, so every cancelled tool call — and
      // an MCP client's own 60s request timeout makes those routine — reported
      // the platform as unreachable. Two readers were misled by that: the model,
      // which retries a connectivity failure and does not retry a cancellation,
      // and the wait loops, which had to test the signal themselves precisely
      // because the message arriving here said nothing true about the cause.
      if (isCancellation(cause, signal)) {
        throw cancellationError(method, path, 'before the platform answered');
      }
      // Rewritten, because the raw one names the host and the failure a model
      // can act on is "the platform is not reachable", not a DNS error string.
      //
      // Two classes, because a rejected fetch is two different outcomes wearing
      // one shape. A refused socket means nothing was dispatched and a create
      // may be replayed; a socket that died with the request already on the
      // wire means the platform may have acted and the answer was lost. The
      // second says so, and the wording follows the class rather than the other
      // way round (OPL-3855).
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (neverDispatched(cause)) {
        throw new ConnectivityError(`could not reach ${this.#base.origin}: ${detail}`);
      }
      throw new ConnectivityInterruptedError(
        `${method} /${path.replace(/^\/+/, '')} to ${this.#base.origin} failed after the request ` +
          `was sent: ${detail}. It may have been received, so treat anything it would have ` +
          'changed as unknown rather than undone.',
      );
    }
    if (!resp.ok) throw await this.#error(resp, method, path, signal);
    return resp;
  }

  /**
   * The platform's own message, when it sent one.
   *
   * Worth the trouble: these messages are written to be acted on — "send a new
   * name or a new size, not both", "this computer was built from a golden image
   * that predates window actions" — and replacing them with a status line would
   * throw away the only part of the response a model can do anything with.
   */
  async #error(
    resp: Response,
    method: string,
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<APIError> {
    let body: unknown;
    let message = `HTTP ${resp.status}`;
    let text = '';
    let truncated = false;
    try {
      ({ text, truncated } = await readBody(method, path, signal, () =>
        readTextAtMost(resp, MAX_ERROR_BODY_BYTES),
      ));
    } catch (cause) {
      // A response whose error body itself is broken still has a useful status.
      // Cancellation is different: the caller deliberately ended this read and
      // must not be told the platform answered with an ordinary HTTP failure.
      if (cause instanceof CancelledError) throw cause;
    }
    if (text) {
      try {
        // A prefix is not JSON even when it happens to end at a syntactically
        // valid boundary. Only trust a structured platform message after the
        // entire body arrived.
        if (truncated) throw new SyntaxError('truncated response body');
        body = JSON.parse(text);
        const err = (body as { error?: unknown })?.error;
        if (typeof err === 'string' && err) message = err;
        else message = text.slice(0, 500);
      } catch {
        message = text.slice(0, 500);
        // The bounded page prefix, not the 500-character message. errorForStatus replaces
        // the message on every edge status with wording of its own, and this is
        // the only copy of what the edge actually said — a Cloudflare Ray ID
        // lives in that HTML and nowhere else, and it is the first thing
        // support asks for. It sits in the footer of a page that runs to
        // several KB, so slicing to 500 for the message would throw away the
        // one field this exists to keep. The separate body cap prevents a
        // hostile or broken response from turning that diagnostic into an
        // unbounded allocation. Shown to nobody; available to whoever needs it.
        body = text;
      }
    }
    // The one status whose headers say more than its body does. `Content-Range:
    // bytes *\/<size>` carries the file's real length, and errorForStatus takes
    // no headers — deliberately, since every other status it maps is decided by
    // the number alone. So this one is built here, where the response is still
    // in hand, and the length rides on the error to whoever asked for the range.
    if (resp.status === 416) {
      const total = parseContentRange(resp.headers.get('content-range'))?.total;
      return new RangeNotSatisfiableError(message, resp.status, body, total);
    }
    // The other one, for the same reason: `Retry-After` is a header, and it is
    // the platform saying how long to wait rather than leaving the wait tools
    // to guess. Built here while the response is still in hand; the BY_STATUS
    // entry covers a 429 reaching errorForStatus from anywhere else, without
    // the number.
    if (resp.status === 429) {
      return new RateLimitError(
        message,
        resp.status,
        body,
        retryAfterMs(resp.headers.get('retry-after')),
      );
    }
    return errorForStatus(resp.status, message, body);
  }

  /**
   * A JSON body, or nothing, or a named failure.
   *
   * Shared by `json` and `listing` so the two cannot disagree about what a
   * non-JSON 200 is. That is not hypothetical tidiness: a captive portal or a
   * misconfigured proxy answers 200 with an HTML page, and the difference
   * between `expected JSON from GET /computers, got: <!DOCTYPE html…` and a
   * bare `SyntaxError: Unexpected token '<'` is whether the reader learns which
   * request went wrong.
   */
  async #decode<T>(
    resp: Response,
    method: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    if (resp.status === 204) return undefined;
    const { text, truncated } = await readBody(method, path, signal, () =>
      readTextAtMost(resp, MAX_JSON_BODY_BYTES),
    );
    if (truncated) {
      throw new MandalaError(
        `${method} ${path} sent more than ${MAX_JSON_BODY_BYTES} bytes of JSON; refusing to buffer the rest`,
      );
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MandalaError(`expected JSON from ${method} ${path}, got: ${text.slice(0, 200)}`);
    }
  }

  /**
   * A JSON body, from a route that is supposed to have one.
   *
   * An empty answer here is a failure, not a value, and it has to be said so
   * rather than cast away. `as T` was a lie the compiler could not catch: a 204
   * on a route that should have answered handed every caller `undefined` typed
   * as present, and what a caller does with that is either `text: undefined` —
   * which is not a valid tool result, so the client rejects the whole call with
   * a schema error naming nothing useful — or a TypeError reading a field off
   * it. Both report the platform's silence as this server's own bug.
   *
   * Routes where an empty body IS the answer use `send`.
   */
  async json<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const resp = await this.#fetch(method, path, opts);
    const body = await this.#decode<T>(resp, method, path, opts.signal ?? this.#signal);
    if (body === undefined || body === null) {
      throw new MandalaError(
        `${method} ${path} answered ${resp.status} with ${body === null ? 'JSON null' : 'an empty body'}, where a JSON value was expected`,
      );
    }
    return body;
  }

  /**
   * A request whose answer may legitimately be nothing.
   *
   * The DELETEs and the acknowledgements: /api/v1 answers some of them with a
   * body worth repeating and some with a 204, and both are correct. Typed as
   * possibly-absent so a caller has to decide what to say when it is.
   */
  async send<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T | undefined> {
    const resp = await this.#fetch(method, path, opts);
    return this.#decode<T>(resp, method, path, opts.signal ?? this.#signal);
  }

  /**
   * A collection read that the platform may have had to answer short.
   *
   * `GET /computers` and `GET /snapshots` are fan-outs across the fleet, so a
   * hypervisor nobody can reach makes the answer incomplete. /api/v1 fails
   * closed about that — without `allow_partial` a short listing is a 503, not a
   * short 200 — but a caller that opts in gets the list plus `X-GC-Incomplete`,
   * and a header is only a warning if something reads it.
   *
   * It is the count of what the placement cache could account for, and it is
   * legitimately `0`: a computer created during the outage was never cached
   * against the host now holding it. So presence is the signal and the number is
   * detail, which is why this returns `null` versus a number rather than a
   * count that means nothing at zero.
   */
  async listing<T>(
    path: string,
    opts: RequestOptions = {},
  ): Promise<{ items: T | undefined; incomplete: number | null }> {
    const resp = await this.#fetch('GET', path, opts);
    const short = resp.headers.get('X-GC-Incomplete');
    return {
      // `T | undefined` and not `T`, because an empty body is a real answer
      // here. Typing it as present would let a caller write `items.length`
      // against a value the compiler had been told could not be missing.
      items: await this.#decode<T>(resp, 'GET', path, opts.signal ?? this.#signal),
      incomplete: short === null ? null : Number(short),
    };
  }

  /** For the two routes whose body is not JSON: the screenshot and the download. */
  async bytes(
    method: string,
    path: string,
    opts: RequestOptions = {},
    maxBytes?: number | ((contentType: string) => number),
  ): Promise<Bytes> {
    const resp = await this.#fetch(method, path, opts);
    const contentType = mediaType(resp.headers.get('content-type'));
    const limit = typeof maxBytes === 'function' ? maxBytes(contentType) : maxBytes;
    const declared = contentLength(resp);
    // Only off a 206. See Bytes.window: the status is the promise, and a 200
    // carrying a stray Content-Range would otherwise be read as one.
    const served =
      resp.status === 206 ? parseContentRange(resp.headers.get('content-range')) : undefined;
    const window =
      served?.start !== undefined && served.end !== undefined
        ? { start: served.start, end: served.end, total: served.total }
        : undefined;
    // A 206 is a promise that these bytes are a PART of something, and the
    // Content-Range is the only thing that says which part. Without a readable
    // one the response is indistinguishable from a whole-file 200 — same
    // status-free shape, `truncated` false, no window — so a caller stitching a
    // file writes a middle chunk at offset zero, and a caller paging one calls
    // it complete and stops. Refused rather than assumed to start at zero,
    // because assuming is the exact failure the status exists to prevent, and
    // because nothing downstream can tell the difference afterwards.
    //
    // The platform always sends the header (`bytes %d-%d/%d` in server/api.go).
    // A hop in front of it that drops the header is the case this is for, and
    // the same one mandala-computer-typescript's toFileChunk refuses.
    if (resp.status === 206 && !window) {
      await resp.body?.cancel().catch(() => {});
      throw new MandalaError(
        `${method} ${path} answered 206 without a readable Content-Range ` +
          `(${resp.headers.get('content-range') ?? 'header absent'}), so where these bytes ` +
          'belong in the file is unknown',
      );
    }
    const { bytes, truncated } = await readBody(
      method,
      path,
      opts.signal ?? this.#signal,
      async () =>
        limit === undefined
          ? { bytes: new Uint8Array(await resp.arrayBuffer()), truncated: false }
          : await readAtMost(resp, limit),
    );
    return {
      bytes,
      contentType,
      filename: filenameFrom(resp.headers.get('content-disposition')),
      truncated,
      // The window's total first, because on a partial response every other
      // number here is about the window: Content-Length is how long THIS body
      // is, and `bytes.length` is how much of it was kept. Reading either as
      // the file's size is how a caller decides it has the whole thing.
      totalBytes:
        window?.total !== undefined
          ? window.total
          : truncated
            ? declared !== undefined && declared > bytes.length
              ? declared
              : undefined
            : // A 206 whose Content-Range said `*`: the window arrived in full
              // and the file's length is still unknown, so this must not fall
              // through to `bytes.length`, which would call the window the file.
              window
              ? undefined
              : bytes.length,
      unrangeable: (resp.headers.get('accept-ranges') ?? '').trim().toLowerCase() === 'none',
      window,
    };
  }

  /**
   * The agent route, which answers with a stream of steps rather than a result.
   *
   * Yielded rather than collected so the caller can report progress while the
   * run is going. A run is minutes of clicking; a tool that says nothing until
   * it is over is one the person watching cannot tell from a hang.
   */
  async *sse(method: string, path: string, opts: RequestOptions = {}): AsyncGenerator<SSEEvent> {
    const resp = await this.#fetch(method, path, {
      ...opts,
      headers: { ...opts.headers, Accept: 'text/event-stream' },
    });
    const contentType = mediaType(resp.headers.get('content-type'));
    if (contentType !== 'text/event-stream') {
      throw new MandalaError(
        `${method} ${path} expected text/event-stream, but the platform answered ${contentType}`,
      );
    }
    if (!resp.body) throw new MandalaError(`${method} ${path} answered with no body`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await readBody(method, path, opts.signal ?? this.#signal, () =>
          reader.read(),
        );
        if (done) break;
        // Buffered exactly as it arrived. Rewriting terminators per chunk was
        // the tempting shortcut and is wrong: a CRLF split across two reads
        // becomes CR-then-LF, each rewritten to its own LF, and the pair reads
        // as the blank line that ends an event — so a frame gets cut in half at
        // a boundary that was never in the stream.
        buffer += decoder.decode(value, { stream: true });
        // Events are separated by a blank line, in whichever of the three
        // terminators the sender chose: the spec allows CRLF, LF and lone CR,
        // and a proxy that reframes the stream is entitled to any of them.
        // Matching only "\n\n" found no boundary at all in a CRLF stream, which
        // collapsed a whole run into one unparseable event and lost the result
        // of a run that had in fact succeeded.
        for (;;) {
          const sep = /\r?\n\r?\n|\r\r/.exec(buffer);
          // A tail of "\r\n\r" is deliberately not a boundary yet — the LF that
          // would complete it may be in the next read.
          if (!sep) break;
          const chunk = buffer.slice(0, sep.index);
          buffer = buffer.slice(sep.index + sep[0].length);
          const parsed = parseEvent(chunk);
          if (parsed) yield parsed;
        }
        // Checked on what the drain could not consume, not on what arrived. A
        // stream that never sends a boundary is buffered forever otherwise:
        // this only bounds the unparseable remainder, so a single read that
        // happens to carry more than the limit in well-formed, boundary-
        // separated events is no longer mistaken for one giant event and the
        // message stays true to what it says — no boundary was found in this.
        if (buffer.length > MAX_SSE_BUFFER) {
          throw new MandalaError(
            `${method} ${path} sent ${buffer.length} characters with no event boundary; giving up rather than buffering the rest of the stream.`,
          );
        }
      }
      // Flushed before the tail is parsed. Every chunk decodes with
      // `{stream: true}`, which holds an incomplete multi-byte sequence back
      // for the next read; on a stream that ends mid-character those bytes are
      // simply dropped without this, rather than surfacing as the replacement
      // character that says something was lost.
      buffer += decoder.decode();
      const tail = parseEvent(buffer);
      if (tail) yield tail;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

/**
 * Was this rejection the caller hanging up, rather than the network?
 *
 * The watched signal is the only reliable answer. `AbortSignal.abort(reason)`
 * rejects the fetch with whatever reason was given, which may be any value at
 * all, so the error name cannot be relied on to say what happened. An undici
 * body or idle timeout is also an `AbortError` / `TimeoutError` /
 * `BodyTimeoutError` without that signal ever having fired — those are
 * transport failures. Calling them a cancellation sent wait loops down the
 * "the caller gave up" path while the caller was still waiting.
 */
function isCancellation(_cause: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

/**
 * Every error under one, including the ones a fetch hides two levels down.
 *
 * A rejected fetch is a `TypeError: fetch failed` whose `cause` is what
 * actually went wrong, and on a dual-stack host that cause is an
 * `AggregateError` holding one attempt per address. Neither the top error nor
 * its immediate cause carries the code the classifiers below read, so both
 * links have to be followed. Bounded, because a cause chain is user-reachable
 * data and nothing here needs to be robust to a cycle.
 */
function* causes(err: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (!err || typeof err !== 'object' || depth > 5) return;
  const e = err as Record<string, unknown>;
  yield e;
  yield* causes(e.cause, depth + 1);
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) yield* causes(inner, depth + 1);
  }
}

/**
 * TLS failures that can only happen before the handshake finishes.
 *
 * NAMED IN FULL, with no prefix test, and that is the correction worth
 * recording. This started as `ERR_SSL_` and `ERR_TLS_` prefixes, and NEITHER
 * prefix means "handshake". Node spells every OpenSSL reason `ERR_SSL_`,
 * including the fatal alerts a peer can send on any record — a TLS-terminating
 * proxy that dies mid-response answers `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR`,
 * and a corrupted record answers `ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC`. Both
 * arrive with the request long since on the wire. `ERR_TLS_` is narrower and
 * still not safe: `ERR_TLS_RENEGOTIATION_DISABLED` is by definition
 * mid-connection. A prefix that admits those puts a possibly-dispatched
 * failure into the class that says nothing was sent, which is the one mistake
 * this whole function exists to avoid.
 *
 * So: an explicit set, holding certificate verification results (OpenSSL's,
 * which carry no prefix), the protocol mismatches that can only be diagnosed
 * from the first record, and the two Node codes that are genuinely handshake
 * events. Add to it when a new one turns up. A missing entry costs an embedder
 * one blind retry it could have made; a wrong entry costs a second billable
 * computer, so the set stays short on purpose.
 */
const TLS_CODES = new Set([
  // Certificate verification, from OpenSSL. All of these end the handshake.
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'HOSTNAME_MISMATCH',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  // Node's own TLS layer, for the two events that are the handshake itself.
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  // Protocol mismatches, diagnosable only from the first record on the wire.
  // `ERR_SSL_WRONG_VERSION_NUMBER` is what https onto a plaintext port gives.
  'ERR_SSL_NO_CIPHERS_AVAILABLE',
  'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
  'ERR_SSL_NO_SHARED_CIPHER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'ERR_SSL_UNKNOWN_PROTOCOL',
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_VERSION_TOO_LOW',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/**
 * Can this rejection be shown to have happened BEFORE the request was written?
 *
 * The one question that decides whether {@link ConnectivityError} or
 * {@link ConnectivityInterruptedError} comes out of `#fetch`, and therefore
 * whether `isTransient` tells an embedder a create is safe to replay.
 *
 * FAIL CLOSED, which is the whole design. The two wrong answers do not cost the
 * same: calling a connect failure a possible dispatch costs one retry that a
 * caller could have made blind, and calling a lost response a connect failure
 * costs a second billable computer. So this is an ALLOW-LIST of causes that can
 * only arise from the connector, and everything else — anything unrecognised,
 * anything new undici invents — is treated as possibly dispatched.
 *
 * The discriminator is the syscall, not the errno, and that distinction earns
 * its place. `ECONNRESET` alone is ambiguous: it is what a TLS handshake
 * against a non-TLS port produces (`syscall: 'read'`, connect phase) and also
 * what a peer resetting a live connection produces (post-dispatch). `connect`
 * and `getaddrinfo`, by contrast, happen once and only before the request
 * exists. undici's own post-dispatch failures are unmistakable in the other
 * direction — `SocketError`/`UND_ERR_SOCKET`, `HTTPParserError`, the two
 * timeout classes — and none of them match anything here.
 *
 * The allow-list is matched in full rather than by prefix, for the reason
 * {@link TLS_CODES} sets out: the obvious prefixes admit failures that happen
 * after the handshake, and one of those in this branch is exactly the bug this
 * function was written to prevent.
 *
 * Measured against undici 6 on Node 26, 2026-08-27: refused → `ECONNREFUSED`
 * with `syscall: 'connect'`; DNS → `ENOTFOUND` with `syscall: 'getaddrinfo'`;
 * dual-stack refusal → the same, inside an `AggregateError`; unroutable →
 * `UND_ERR_CONNECT_TIMEOUT`; TLS against a plaintext port →
 * `ERR_SSL_WRONG_VERSION_NUMBER`. Post-dispatch: a socket closed after the
 * request → `UND_ERR_SOCKET`, a garbage response → `HPE_INVALID_CONSTANT`, no
 * response → `UND_ERR_HEADERS_TIMEOUT`.
 */
function neverDispatched(err: unknown): boolean {
  for (const cause of causes(err)) {
    const code = typeof cause.code === 'string' ? cause.code : '';
    const syscall = cause.syscall;
    if (syscall === 'connect' || syscall === 'getaddrinfo' || syscall === 'lookup') return true;
    if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
    if (TLS_CODES.has(code)) return true;
  }
  return false;
}

/** Errnos a live connection dies with, once the request is already on it. */
const SOCKET_ERRNOS = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENOTCONN', 'ETIMEDOUT']);

/**
 * A transport failure while reading a body, as opposed to a bug in this file.
 *
 * Only reached from {@link readBody}, so the phase is not in question — the
 * response headers already arrived. What is in question is whether the throw
 * came from the connection or from us: `#decode` and `sse` raise
 * {@link MandalaError} for a body that arrived and made no sense, and wrapping
 * one of those as a connectivity failure would send a poll loop round again on
 * a defect.
 *
 * The names were here first and are undici's aborts and idle timeouts. The two
 * tests below them close the case that used to fall straight through: a socket
 * that dies mid-body surfaces from `fetch` as `TypeError: terminated` — a name
 * this list does not have and never will — carrying a `SocketError` as its
 * cause. That reached `throw cause` and came out as a bare `TypeError`, which
 * is neither transient nor pollable, so a wait loop died on a blip it existed
 * to ride out.
 */
function isTransportFailure(cause: unknown): boolean {
  const name = (cause as { name?: string })?.name;
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    name === 'BodyTimeoutError' ||
    name === 'HeadersTimeoutError'
  ) {
    return true;
  }
  for (const inner of causes(cause)) {
    const code = typeof inner.code === 'string' ? inner.code : '';
    if (code.startsWith('UND_ERR_')) return true;
    if (SOCKET_ERRNOS.has(code)) return true;
  }
  return false;
}

/** The same cancellation semantics for response bodies as for response headers. */
async function readBody<T>(
  method: string,
  path: string,
  signal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (isCancellation(cause, signal)) {
      throw cancellationError(method, path, 'while reading the platform response');
    }
    // Always the post-dispatch class. Getting here means the response headers
    // arrived, so the platform received the request and acted on it; what was
    // lost is the answer. That is precisely the case `isTransient` must say no
    // to and the poll predicate must ride out (OPL-3855).
    if (isTransportFailure(cause)) {
      throw new ConnectivityInterruptedError(
        `could not finish reading ${method} /${path.replace(/^\/+/, '')}: ${
          cause instanceof Error ? cause.message : String(cause)
        }. The request was received, so treat anything it would have changed as ` +
          'unknown rather than undone.',
      );
    }
    throw cause;
  }
}

function cancellationError(method: string, path: string, when: string): CancelledError {
  return new CancelledError(
    `${method} /${path.replace(/^\/+/, '')} was cancelled ${when}. ` +
      'It may still have been received, so treat anything it would have changed as unknown rather than undone.',
  );
}

/**
 * The bare media type, without the parameters a Content-Type may carry.
 *
 * MCP's image content takes a media type, and `image/png; charset=binary` is a
 * header — a client matching on the former renders nothing for the latter. The
 * parameters say nothing this server uses, so they are dropped at the one place
 * the header is read.
 */
function mediaType(header: string | null): string {
  const bare = (header ?? '').split(';')[0].trim().toLowerCase();
  return bare || 'application/octet-stream';
}

/**
 * `Content-Range`, in both the shapes this surface sends.
 *
 * `bytes A-B/T` on a 206 says which bytes arrived and how long the file is;
 * `bytes *\/T` on a 416 says only the length, which is the one thing a caller
 * who guessed an offset wrong needs. Both are parsed here so the two readers
 * cannot disagree about the grammar, and `*` in either position comes back as
 * `undefined` rather than as a number nothing sent.
 *
 * A malformed header is nothing rather than a throw: it is metadata about a
 * body that already arrived, and failing a download over the label on it would
 * be a worse answer than the one this gives.
 */
function parseContentRange(
  header: string | null,
): { start?: number; end?: number; total?: number } | undefined {
  if (!header) return undefined;
  const m = /^\s*bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)\s*$/i.exec(header);
  if (!m) return undefined;
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v === '*') return undefined;
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : undefined;
  };
  const start = num(m[1]);
  const end = num(m[2]);
  // A window whose end precedes its start describes no bytes. Dropping the pair
  // rather than passing it on keeps `end - start + 1` from being negative in
  // every caller that trusts this.
  if (start !== undefined && end !== undefined && end < start) return undefined;
  return { start, end, total: num(m[3]) };
}

/**
 * The longest delay `setTimeout` takes without wrapping.
 *
 * Node stores it in a 32-bit signed int, and a larger one does NOT clamp — it
 * warns and fires at 1ms instead, which is the opposite of every use of this
 * number. About 24.9 days.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A `Retry-After` header, in milliseconds from now.
 *
 * Both spellings the header has: delta-seconds, and an HTTP date. A date in the
 * past is zero rather than negative, because the only consumer is a sleep.
 *
 * CAPPED at {@link MAX_TIMER_MS}, and that is the whole reason this is not four
 * lines. `Retry-After: 2147484` is a valid header — under a month — and it is
 * 2147484000ms, which does not fit a 32-bit signed int, so Node fires the timer
 * at 1ms. A poll loop then retries a rate limit it was told to leave alone for
 * weeks, immediately and for the rest of its deadline: the exact opposite of
 * what the header asked for, reached by honouring it. The TypeScript SDK's
 * `retryAfterMs` has carried this cap since it was written; this copy was made
 * without it (Codex adversarial review, OPL-3724).
 *
 * A malformed value is nothing rather than a throw, for parseContentRange's
 * reason — it is metadata about a refusal that already arrived, and the poll
 * loops have their own interval to fall back on. Note that a NEGATIVE
 * delta-seconds is not malformed enough to stop there: `Date.parse('-5')` is a
 * date in 2001, so it falls through to the branch below and lands on 0, which
 * is the same answer a date in the past gets and is why nothing worse happens.
 */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_TIMER_MS);
  const at = Date.parse(header);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), MAX_TIMER_MS);
}

/** A trustworthy response length, when fetch has not transparently decoded it. */
function contentLength(resp: Response): number | undefined {
  const encoding = resp.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') return undefined;
  const raw = resp.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Read no more than a tool can return, then cancel the rest of the download.
 *
 * The files route may send 64 MiB while read_file can put only 256 KiB into a
 * conversation. `arrayBuffer()` paid for and retained the other 63.75 MiB just
 * to throw it away. A one-chunk lookahead says whether a response of exactly
 * `limit` bytes was clipped. It also verifies a declared oversize body really
 * had more bytes: Content-Length is useful metadata, not proof that data was
 * discarded.
 */
async function readAtMost(
  resp: Response,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new MandalaError(`byte limit must be a non-negative integer, got ${limit}`);
  }
  if (!resp.body) return { bytes: new Uint8Array(), truncated: false };

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, limit - length);
      if (take) {
        chunks.push(value.subarray(0, take));
        length += take;
      }
      if (take < value.length) {
        truncated = true;
        break;
      }
    }

    if (length === limit && !truncated) {
      const next = await reader.read();
      truncated = !next.done;
    }
  } finally {
    // Release the response on every exit, including a rejected read. On a
    // clean EOF this is a harmless no-op; on an error it prevents the body and
    // its connection from being left open.
    await reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

/** Decode a bounded UTF-8 prefix and cancel anything beyond it. */
async function readTextAtMost(
  resp: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readAtMost(resp, limit);
  return { text: new TextDecoder().decode(bytes), truncated };
}

function parseEvent(chunk: string): SSEEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of chunk.split(/\r\n|\n|\r/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      // Exactly one space, which is what the spec strips. `trimStart()` took
      // every leading space and tab, and whitespace inside a data field is
      // payload — significant the moment an event carries text rather than the
      // JSON every event happens to carry today.
      const v = line.slice(5);
      data.push(v.startsWith(' ') ? v.slice(1) : v);
    }
  }
  if (!data.length) return undefined;
  const joined = data.join('\n');
  try {
    return { event, data: JSON.parse(joined) };
  } catch {
    return { event, data: joined };
  }
}

/** The filename the platform put on a download, if it put one there. */
export function filenameFrom(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  // Any charset and any language, not only `UTF-8''`. RFC 5987 writes this
  // value as charset, language, then the text, with the language ordinarily
  // empty — and matching only the empty spelling meant that both
  // `filename*=ISO-8859-1''…` and `filename*=UTF-8'en'…` were read by neither
  // branch — the plain form below cannot match either, since there is no
  // `filename=` in them — so a download the platform had named came back with
  // no name at all. Three groups, not two: the middle one is the language tag,
  // present or empty.
  const star = /filename\*=([^']*)'([^']*)'([^;]+)/i.exec(disposition);
  if (star) {
    // A stray `%` in a guest filename is legal on disk and makes this throw.
    // Letting it out would turn a download whose bytes already arrived intact
    // into a failure, over the label on it.
    try {
      return decodeURIComponent(star[3]);
    } catch {
      return star[3];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : undefined;
}
