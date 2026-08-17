import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MandalaError } from './errors.js';

/** A plain text result. */
export const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });

/** A JSON result, pretty-printed — models read indented JSON more reliably than one line. */
export const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2));

/** A line of prose followed by the data it describes. */
export const said = (line: string, v?: unknown): CallToolResult =>
  text(v === undefined ? line : `${line}\n\n${JSON.stringify(v, null, 2)}`);

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
  return {
    isError: true,
    content: [{ type: 'text', text: status ? `${message} (HTTP ${status})` : message }],
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
    return { ...(inner as Computer), start_error: v.start_error as string | undefined };
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

/** The one-line version, for lists and for confirmations. */
export function describe(c: Computer): string {
  const bits = [c.name ?? '(unnamed)', c.id ?? '(no id)', c.status ?? 'unknown'];
  if (c.resolution) bits.push(c.resolution);
  if (c.suspended?.at) bits.push(`suspended ${c.suspended.at}`);
  if (c.unreachable) bits.push('UNREACHABLE — its hypervisor could not be reached');
  return bits.join(' · ');
}
