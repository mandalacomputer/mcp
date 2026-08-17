import { type APIError, errorForStatus, MandalaError } from './errors.js';

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
};

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
  readonly #headers: Record<string, string>;

  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL) {
    if (!apiKey) {
      throw new MandalaError(
        'No API key. Set MANDALA_API_KEY (create one at Settings → API keys), ' +
          'or send it as a bearer token when running over HTTP.',
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.#headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
  }

  #url(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
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

    let resp: Response;
    try {
      resp = await fetch(this.#url(path, opts.query), {
        method,
        headers,
        body,
        signal: opts.signal,
      });
    } catch (cause) {
      // Rewritten, because the raw one names the host and the failure a model
      // can act on is "the platform is not reachable", not a DNS error string.
      throw new MandalaError(
        `could not reach ${this.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!resp.ok) throw await this.#error(resp);
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
  async #error(resp: Response): Promise<APIError> {
    let body: unknown;
    let message = `HTTP ${resp.status}`;
    const text = await resp.text().catch(() => '');
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
  async #decode<T>(resp: Response, method: string, path: string): Promise<T | undefined> {
    if (resp.status === 204) return undefined;
    const text = await resp.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MandalaError(`expected JSON from ${method} ${path}, got: ${text.slice(0, 200)}`);
    }
  }

  async json<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const resp = await this.#fetch(method, path, opts);
    return (await this.#decode<T>(resp, method, path)) as T;
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
      items: await this.#decode<T>(resp, 'GET', path),
      incomplete: short === null ? null : Number(short),
    };
  }

  /** For the two routes whose body is not JSON: the screenshot and the download. */
  async bytes(method: string, path: string, opts: RequestOptions = {}): Promise<Bytes> {
    const resp = await this.#fetch(method, path, opts);
    const buf = new Uint8Array(await resp.arrayBuffer());
    return {
      bytes: buf,
      contentType: resp.headers.get('content-type') ?? 'application/octet-stream',
      filename: filenameFrom(resp.headers.get('content-disposition')),
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
    if (!resp.body) throw new MandalaError(`${method} ${path} answered with no body`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Events are separated by a blank line. Split on the separator and keep
        // the tail, which may be half an event.
        for (;;) {
          const sep = buffer.indexOf('\n\n');
          if (sep === -1) break;
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const parsed = parseEvent(chunk);
          if (parsed) yield parsed;
        }
      }
      const tail = parseEvent(buffer);
      if (tail) yield tail;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

function parseEvent(chunk: string): SSEEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
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
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : undefined;
}
