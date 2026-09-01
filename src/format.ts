import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { APIError, MandalaError, reasonAdvice } from './errors.js';

/** A plain text result. */
export const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });

/** A JSON result, pretty-printed — models read indented JSON more reliably than one line. */
export const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2));

/** A line of prose followed by the data it describes. */
export const said = (line: string, v?: unknown): CallToolResult =>
  text(v === undefined ? line : `${line}\n\n${JSON.stringify(v, null, 2)}`);

/**
 * A refusal this server decided on its own, rather than one the platform sent.
 *
 * The same thing as `failed`, for the cases that never reach the platform: an
 * argument combination that cannot mean anything, a payload that would write
 * corruption, a purge without the fingerprint that authorises it. Those are
 * failures too, and a caller that reads `isError` to decide whether a step
 * worked would otherwise see a refusal and a success as the same answer.
 */
export const refused = (line: string, v?: unknown): CallToolResult => ({
  ...said(line, v),
  isError: true,
});

/**
 * How many bytes of image this server will put into a model's context.
 *
 * Larger than the text cap because base64 of a screenshot is the one big thing
 * worth carrying, and because a picture is the whole point of this server — but
 * bounded, because an image cannot be truncated and one past this size is not a
 * large answer, it is the end of the conversation.
 *
 * Here rather than in one tool, because every path that produces image content
 * has to observe it: `read_file` did and `screenshot` did not, which left the
 * bound sitting on the smaller of the two.
 */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Raster types that MCP image content can carry safely.
 *
 * `image/*` includes `image/svg+xml`, and a client that inlines that MIME as a
 * picture can execute script from it. SVG is XML; it goes through the text /
 * base64 path like any other non-raster file.
 *
 * Here, beside the size cap, for the reason written above it: every path that
 * produces image content has to observe this, and the two paths did not agree.
 * `read_file` checked the allowlist while `screenshot` checked only
 * `startsWith('image/')` — and the case screenshot's check exists for is a
 * proxy or captive portal answering in place of the capture, which is exactly
 * the situation where the bytes are chosen by somebody else.
 */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export function isInlineImage(contentType: string): boolean {
  return INLINE_IMAGE_TYPES.has(contentType);
}

/**
 * A screenshot, as image content.
 *
 * This is the whole reason this server is more than a CLI wrapper: the bytes go
 * into the model's context as a picture it can point at, rather than as a path
 * it would have to open with something else.
 */
export function image(bytes: Uint8Array, mimeType: string, note?: string): CallToolResult {
  const content: CallToolResult['content'] = [
    { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType },
  ];
  if (note) content.unshift({ type: 'text', text: note });
  return { content };
}

/**
 * A failure the model should read and act on, not an exception the client shows
 * as a protocol error.
 *
 * MCP draws this line deliberately: a transport error is the client's problem,
 * while "the guest agent is not answering yet (the computer may still be
 * booting)" is the model's — it is the sentence that tells it to wait and try
 * again rather than to give up or to report a broken tool. So everything the
 * platform refuses comes back as content with `isError`.
 */
export function failed(err: unknown): CallToolResult {
  const message = err instanceof MandalaError || err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  const withStatus =
    status && message !== `HTTP ${status}` ? `${message} (HTTP ${status})` : message;
  // The platform's classification of the refusal, as the sentence it means
  // (OPL-3898). `reason` is one word beside `error`, put there for a program to
  // switch on — and the program on the other end of this tool is a model that
  // sees nothing but the text below. Without this, the only thing distinguishing
  // "something held the clipboard for an instant" from "the computer is stopped"
  // is prose the platform is free to reword, and the model that reads the two
  // the same way retries the second until its turn budget runs out.
  //
  // Appended rather than substituted: the sentence is what says WHICH computer
  // and which state, and the word says only what kind. An unclassified refusal —
  // most of them, and always will be — reads exactly as it did before.
  const advice = err instanceof APIError ? reasonAdvice(err.reason) : undefined;
  return {
    isError: true,
    content: [{ type: 'text', text: advice ? `${withStatus} — ${advice}` : withStatus }],
  };
}

/** Run a tool body, turning anything it throws into a result the model can read. */
export async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return failed(err);
  }
}

// --- shapes ---------------------------------------------------------------

export type Computer = {
  id?: string;
  name?: string;
  status?: string;
  os?: string;
  template?: string;
  cpu?: number;
  ram_mb?: number;
  disk_gb?: number;
  resolution?: string;
  workspace_id?: string;
  created_at?: string;
  build?: { started?: string; source?: string; failed?: boolean };
  suspended?: { at?: string };
  idle_suspend_min?: number;
  snapshot_schedule?: unknown;
  unreachable?: boolean;
  start_error?: string;
  vnc?: Record<string, unknown>;
};

/**
 * A create or a clone can answer `{computer, start_error}` rather than a bare
 * computer: the guest was made and then would not boot, so the machine exists
 * and is billable and the caller needs its id. Flattened here, as the SDK
 * flattens it, so every reader of a computer sees the same shape and the
 * failure travels beside the fields rather than wrapping them.
 */
export function unwrapComputer(body: unknown): Computer {
  if (!body || typeof body !== 'object') return {};
  const v = body as Record<string, unknown>;
  const inner = v.computer;
  if (inner && typeof inner === 'object') {
    // The outer value wins, but only when there is one. Writing it
    // unconditionally would take a `start_error` the platform had nested with
    // the computer and replace it with nothing — discarding the reason a
    // billable machine did not boot, in the function that exists to surface it.
    const nested = inner as Computer;
    return {
      ...nested,
      start_error: (v.start_error as string | undefined) ?? nested.start_error,
    };
  }
  return v as Computer;
}

/**
 * A computer without its desktop credentials.
 *
 * `vnc` carries a token that is root-equivalent on the machine, and a tool
 * result is a thing that lands in a model's context and from there in whatever
 * captured it. The platform makes the same call one level down — it keeps the
 * credential off list responses so that it is not in every log line that ever
 * held one — and there is no reason for this tier to be looser. `get_desktop_url`
 * hands it over when somebody asks for it, watch-only unless they say otherwise.
 */
export function withoutCredentials(c: Computer): Computer {
  const { vnc: _vnc, ...rest } = c;
  return rest;
}

/**
 * The warning that belongs on a listing the platform said was short.
 *
 * Said in prose and said first, because the reader is a model that will
 * otherwise diff this array against its own idea of the world. A short list is
 * not a smaller truth — it reads exactly like the missing things were deleted,
 * and the obvious next thing to do with something that has disappeared is to
 * tidy up after it.
 */
export function incompleteWarning(noun: string, incomplete: number | null): string {
  if (incomplete === null) return '';
  const missing =
    incomplete > 0
      ? `${incomplete} of your ${noun} are on a hypervisor that cannot be reached`
      : `a hypervisor cannot be reached, so an unknown number of ${noun} are missing`;
  return (
    `INCOMPLETE: ${missing}. This list is short. Do not treat anything absent from it ` +
    `as deleted — retry in a moment for a complete answer.\n\n`
  );
}

/** The one-line version, for lists and for confirmations. */
export function describe(c: Computer): string {
  const bits = [c.name ?? '(unnamed)', c.id ?? '(no id)', c.status ?? 'unknown'];
  if (c.resolution) bits.push(c.resolution);
  if (c.suspended?.at) bits.push(`suspended ${c.suspended.at}`);
  if (c.unreachable) bits.push('UNREACHABLE — its hypervisor could not be reached');
  return bits.join(' · ');
}
