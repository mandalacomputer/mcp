import { Agent, type Dispatcher } from 'undici';
import {
  type APIError,
  CancelledError,
  ConnectivityError,
  errorForStatus,
  MandalaError,
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
  /** Exact size when the response declared one, or when it fitted in full. */
  totalBytes?: number;
};

/**
 * How much of an event stream will be held while waiting for a boundary.
 *
 * Generous for any real event — a run's steps are small — and finite, which is
 * the point: without it a stream that never sends a blank line is buffered
 * until the process runs out of memory.
 */
const MAX_SSE_BUFFER = 8 * 1024 * 1024;

/**
 * The longest guest exec waits 300 seconds before it answers. Node's bundled
 * fetch also gives response headers 300 seconds by default, so the client can
 * lose that race while the command is still finishing in the guest. Keep the
 * public exec limit and give the platform enough time to report its timeout.
 */
export const PLATFORM_HEADERS_TIMEOUT_MS = 330_000;
const PLATFORM_DISPATCHER = new Agent({ headersTimeout: PLATFORM_HEADERS_TIMEOUT_MS });

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
    url.pathname = `${url.pathname}/${path.replace(/^\/+/, '')}`;
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
      resp = await fetch(this.#url(path, opts.query), init);
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
      throw new ConnectivityError(
        `could not reach ${this.#base.origin}: ${cause instanceof Error ? cause.message : String(cause)}`,
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
    try {
      text = await readBody(method, path, signal, () => resp.text());
    } catch (cause) {
      // A response whose error body itself is broken still has a useful status.
      // Cancellation is different: the caller deliberately ended this read and
      // must not be told the platform answered with an ordinary HTTP failure.
      if (cause instanceof CancelledError) throw cause;
    }
    if (text) {
      try {
        body = JSON.parse(text);
        const err = (body as { error?: unknown })?.error;
        if (typeof err === 'string' && err) message = err;
        else message = text.slice(0, 500);
      } catch {
        message = text.slice(0, 500);
      }
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
    const text = await readBody(method, path, signal, () => resp.text());
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
      totalBytes:
        truncated && declared !== undefined && declared > bytes.length
          ? declared
          : truncated
            ? undefined
            : bytes.length,
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
 * The signal is the reliable half: `AbortSignal.abort(reason)` rejects the
 * fetch with whatever reason was given, which may be any value at all, so the
 * error alone cannot be relied on to say what happened. The name check is for
 * the rest — `AbortSignal.timeout` raises `TimeoutError`, and a stream torn
 * down mid-read raises `AbortError` without the signal this call was watching
 * ever having fired.
 */
function isCancellation(cause: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (cause as { name?: string })?.name;
  return name === 'AbortError' || name === 'TimeoutError';
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
