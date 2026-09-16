import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { APIError, MandalaError, platformSaid, reasonAdvice, statusAdvice } from './errors.js';

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

/** Only bounded diagnostic scalars enter a tool result; full evidence stays on APIError. */
export function errorMetadata(source: APIError | Record<string, unknown>): {
  fields: Record<string, string | number>;
  omitted: boolean;
} {
  const data =
    source instanceof APIError
      ? {
          status: source.status,
          reason: source.reason,
          request_id: source.requestId,
          allow: source.allow,
          www_authenticate: source.wwwAuthenticate,
          retry_after_ms: source.retryAfterMs,
        }
      : source;
  const fields: Record<string, string | number> = {};
  let omitted = false;
  for (const [name, limit] of Object.entries({
    reason: 128,
    request_id: 256,
    allow: 512,
    www_authenticate: 512,
  })) {
    const value = data[name];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (value.length > limit) {
      omitted = true;
      continue;
    }
    fields[name] = value.replace(/\b(?:com_|sk-)[A-Za-z0-9_-]+/g, '[redacted]');
  }
  for (const name of ['status', 'retry_after_ms']) {
    const value = data[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) fields[name] = value;
  }
  return { fields, omitted };
}

export function withErrorMetadata(
  result: CallToolResult,
  source: APIError | Record<string, unknown>,
): CallToolResult {
  const { fields, omitted } = errorMetadata(source);
  if (!Object.keys(fields).some((name) => name !== 'status') && !omitted) return result;
  return {
    ...result,
    content: [
      ...result.content,
      ...said(
        `Response metadata:${omitted ? ' Oversized diagnostic metadata was omitted.' : ''}`,
        fields,
      ).content,
    ],
  };
}

/** Keep scalar error prose, without displaying a serialized response body as its message. */
export function apiErrorMessage(error: APIError): string {
  const named = platformSaid(error.body);
  if (named !== undefined) return named;
  // An unreadable or unclassified JSON envelope can leave a bounded JSON prefix
  // in message. It is diagnostic body content, not a whitelist of display fields.
  // Tailored transport warnings and ordinary text messages remain unchanged.
  if (error.body !== undefined && /^\s*[[{]/.test(error.message)) return `HTTP ${error.status}`;
  return error.message;
}

/** A model-visible refusal. A projected run failure must withhold reason-based replay advice. */
export function failed(err: unknown, includeReasonAdvice = true): CallToolResult {
  const message =
    err instanceof APIError
      ? apiErrorMessage(err)
      : err instanceof MandalaError || err instanceof Error
        ? err.message
        : String(err);
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
  //
  // The status FIRST, where it has something to say, and only then the
  // platform's word. The three statuses `statusAdvice` answers are the three
  // where a retry is not merely useless but dangerous, and `reason` is a word
  // about a computer being busy — nothing constrains the two from arriving
  // together, and a 403 whose body also said `contention` was told "the same
  // call works once it finishes", which is exactly the replay this is here to
  // stop (Codex review). Every other status keeps the platform's word ahead of
  // anything generic, which is where it belongs: it is specific to one refusal.
  const advice =
    err instanceof APIError
      ? (statusAdvice(err.status, err.reason) ??
        (includeReasonAdvice &&
        ![404, 405].includes(err.status) &&
        (!err.body ||
          typeof err.body !== 'object' ||
          !('error' in err.body) ||
          typeof err.body.error !== 'object')
          ? reasonAdvice(err.reason)
          : undefined))
      : undefined;
  const line = advice ? `${withStatus} — ${advice}` : withStatus;
  const kept = err instanceof APIError ? keptWork(err.body) : undefined;
  const result: CallToolResult = {
    isError: true,
    content: [{ type: 'text', text: kept ? `${line}\n\n${kept}` : line }],
  };
  return err instanceof APIError ? withErrorMetadata(result, err) : result;
}

/**
 * How much of a retained-work record goes into a model's context.
 *
 * Choosing three field names bounds nothing: a step's detail is text the guest
 * produced, and an error body is allowed a megabyte of it. One 900,000-character
 * entry became a 900,000-character tool result — which either buries the sentence
 * that says what to do, or is truncated by the client, and a record cut off by
 * somebody else is not one anything can be concluded from (Codex review).
 */
const MAX_KEPT_WORK_CHARS = 4_000;

/** Whether one retained field says anything — zero, empty and blank say nothing. */
function recordsSomething(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * What a refusal reported having already recorded, where it reported anything.
 *
 * A refusal decided partway through a call is not necessarily a call that did
 * nothing: the platform reports whatever it had recorded in the error body, and
 * this read nothing but the message — so a run that drove the desktop for nine
 * steps and was then stopped surfaced as one bare sentence, with the steps and
 * what they billed nowhere a model could see them. A model reading that starts
 * again from the beginning and pays for the nine a second time.
 *
 * What it does NOT say is that the computer changed. These fields are a record
 * of what ran and what it cost; billed model work need not have touched anything,
 * and the one thing worse than hiding the record is a sentence asserting a
 * mutation that a caller then reports to a user as done (Codex review). So the
 * label is neutral and the check is named as the caller's own.
 *
 * Named fields rather than the whole body: most of what is in one is the sentence
 * already shown above it, and everything else stays out of the model's context.
 * Empty is not a record — an empty list of steps and a zero count say a call was
 * stopped before it did anything, which the sentence above already says better.
 */
function keptWork(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const from = body as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const field of ['steps_taken', 'steps', 'usage']) {
    const value = from[field];
    if (!recordsSomething(value)) continue;
    kept[field] = value;
  }
  if (!Object.keys(kept).length) return undefined;
  const record = JSON.stringify(kept, null, 2);
  const shown =
    record.length > MAX_KEPT_WORK_CHARS
      ? `${record.slice(0, MAX_KEPT_WORK_CHARS)}\n… shortened here; this record is incomplete and is not enough to establish what the call did.`
      : record;
  return (
    'This refusal came after the platform had already recorded work on this call. What it ' +
    'reported — a record of what ran and what it cost, NOT proof of what changed on the ' +
    `computer, which is yours to check before repeating anything:\n${shown}`
  );
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
  /**
   * The platform's own record of whether the machine exists (platform
   * OPL-4554): `live | unreachable | deleting | deleted | lost`.
   *
   * A different axis from `status`, which is what the machine's host says the
   * guest is doing. `unreachable` is the only one of the five that is per
   * request — it says this listing could not reach the host — and it is exactly
   * the case where `status` is absent, because there was nobody to ask.
   *
   * On listing rows only. A single computer is served by its host, so anything
   * that answers is live and carries no state at all.
   */
  state?: string;
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
  /** RFC 3339, present once the record has said `deleted` or `lost` respectively. */
  deleted_at?: string;
  lost_at?: string;
  start_error?: string;
  /**
   * Guest RAM the platform is holding for this computer against the account's
   * running pool (platform OPL-4630).
   *
   * The field that says whether a start is on its way, which `status` cannot:
   * `status` is read from the guest process, and a start that has been ADMITTED
   * has no process yet. Through the whole of that window the machine reports
   * what it WAS — `stopped` for a cold boot, `suspended` for a resume, whose
   * session record is spent only on the way out of a start that worked.
   *
   * Charged from admission rather than from boot, so a zero is the platform
   * saying it is holding nothing. Absent is a host that did not say: one too
   * old to report it, one that could not be reached, or a response the platform
   * wrote before reading the computer back. See `nothingAdmitted`.
   */
  running_ram_mb?: number;
  vnc?: Record<string, unknown>;
};

/**
 * Whether the platform has said, in as many words, that nothing is coming up.
 *
 * Two waits in this server used to read `stopped` and `suspended` as "nobody is
 * starting this" and answer accordingly — one refusing the wait, one ending an
 * event subscription for good. Both are right about an idle computer and wrong
 * about one that is mid-start, and the difference was not visible until the
 * platform published `running_ram_mb`.
 *
 * Three states, not two, and the third is why this is a function rather than
 * `!c.running_ram_mb`: ABSENT is a host that did not answer the question.
 * Reading that as a zero would refuse on a sentence nobody uttered, and the
 * cost of waiting instead is a timeout rather than a machine. The two SDKs make
 * the same distinction the same way (OPL-4628, OPL-4629).
 */
export function nothingAdmitted(c: Computer): boolean {
  return (
    typeof c.running_ram_mb === 'number' &&
    Number.isFinite(c.running_ram_mb) &&
    c.running_ram_mb === 0
  );
}

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
  // `status` is the guest's, `state` is the record's, and a row served from the
  // record has only the second — which is why a deleting, deleted or lost
  // computer used to read as `unknown` here, the one word that says nothing.
  //
  // Both when there are both: a computer can be running and being deleted at
  // the same time, and neither half of that is the answer on its own. `live`
  // is dropped, being what every ordinary row says and so worth no column.
  const state = c.state === 'live' ? undefined : c.state;
  const bits = [c.name ?? '(unnamed)', c.id ?? '(no id)', c.status ?? state ?? 'unknown'];
  if (c.status && state) bits.push(state);
  if (c.resolution) bits.push(c.resolution);
  if (c.suspended?.at) bits.push(`suspended ${c.suspended.at}`);
  if (c.unreachable) bits.push('UNREACHABLE — its hypervisor could not be reached');
  return bits.join(' · ');
}
