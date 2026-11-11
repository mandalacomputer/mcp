import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BoundedBytes } from './api.js';
import { APIError, CancelledError, codeAdvice } from './errors.js';
import { refused, withErrorMetadata } from './format.js';
export const RETAINED_OPERATION_MS = 90000;
export const PRESENTATION_DEFAULT = 4096,
  PRESENTATION_MAX = 16384,
  RETAINED_RESULT_MAX = 256 * 1024;
export class RetainedValueError extends Error {
  constructor() {
    super('Invalid or unsupported retained response or request.');
  }
}
export const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
export function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new RetainedValueError();
}
export const resultId = (v: unknown): v is string =>
  typeof v === 'string' && v.length === 36 && /^res_[a-f0-9]{32}$/.test(v);
export const executionId = (v: unknown): v is string =>
  typeof v === 'string' && v.length === 37 && /^exec_[a-f0-9]{32}$/.test(v);
export const scopeId = (v: unknown): v is string =>
  typeof v === 'string' && v.match(/^[A-Za-z0-9_-]{1,100}$/)?.[0] === v;
export const digest = (v: unknown): v is string =>
  typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/.test(v);
export function time(v: unknown): bigint {
  requireValue(
    typeof v === 'string' &&
      v.endsWith('Z') &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v),
  );
  const parsed = Date.parse(v);
  requireValue(
    Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === v.slice(0, 19),
  );
  return (
    BigInt(Math.floor(parsed / 1000)) * 1000000000n +
    BigInt((v.split('.')[1]?.slice(0, -1) ?? '').padEnd(9, '0'))
  );
}
export type RetainOptions = { max_bytes_per_stream?: number; retention_seconds?: number };
export function retainOptions(v: unknown): RetainOptions {
  requireValue(
    record(v) &&
      Object.keys(v).every((k) => k === 'max_bytes_per_stream' || k === 'retention_seconds'),
  );
  const out: RetainOptions = {};
  if ('max_bytes_per_stream' in v) {
    requireValue(integer(v.max_bytes_per_stream, 1, 4 * 1024 * 1024));
    out.max_bytes_per_stream = v.max_bytes_per_stream;
  }
  if ('retention_seconds' in v) {
    requireValue(integer(v.retention_seconds, 1, 604800));
    out.retention_seconds = v.retention_seconds;
  }
  return out;
}
export function retainIntent(v: unknown, background: boolean): true | RetainOptions | undefined {
  if (v === undefined || v === false) return undefined;
  requireValue(!background);
  return v === true ? true : retainOptions(v);
}
export function resultMetadata(
  v: unknown,
  computer: string,
  id?: string,
  execution?: string,
  options?: RetainOptions,
) {
  requireValue(
    record(v) &&
      v.version === 1 &&
      resultId(v.result_id) &&
      (!id || v.result_id === id) &&
      v.computer_id === computer &&
      scopeId(v.computer_id) &&
      scopeId(v.account_id) &&
      (v.workspace_id === null || scopeId(v.workspace_id)) &&
      v.state === 'ready',
  );
  const sync = v.kind === 'synchronous-output';
  requireValue(sync || v.kind === 'background-output');
  requireValue(
    sync
      ? v.execution_id === null && v.source === 'exec_response'
      : executionId(v.execution_id) && v.source === 'volatile_guest_files',
  );
  if (execution) requireValue(!sync && v.execution_id === execution);
  const start = time(v.capture_started_at),
    end = time(v.captured_at),
    expires = time(v.expires_at);
  requireValue(end >= start && expires > end && expires - start <= 604800000000000n);
  const o = v.execution_observation;
  requireValue(record(o));
  const observed = time(o.observed_at);
  requireValue(observed >= start && observed <= end);
  requireValue(
    o.status === 'exited'
      ? integer(o.exit_code, -2147483648, 2147483647)
      : !sync && o.status === 'running' && !('exit_code' in o),
  );
  const observation = {
    status: o.status,
    observed_at: o.observed_at,
    ...(o.status === 'exited' ? { exit_code: o.exit_code } : {}),
  };
  const prefix = (p: unknown) => {
    requireValue(
      record(p) &&
        integer(p.bytes, 0, 4 * 1024 * 1024) &&
        digest(p.sha256) &&
        p.source_offset === 0 &&
        p.next_source_offset === p.bytes,
    );
    if (sync)
      requireValue(
        integer(p.source_response_bytes, p.bytes, 16 * 1024 * 1024) &&
          typeof p.upstream_truncated === 'boolean' &&
          p.end_reason === (p.bytes === p.source_response_bytes ? 'response_end' : 'byte_limit'),
      );
    else requireValue(p.end_reason === 'observed_eof' || p.end_reason === 'byte_limit');
    return {
      bytes: p.bytes,
      sha256: p.sha256,
      source_offset: 0,
      next_source_offset: p.bytes,
      end_reason: p.end_reason,
      ...(sync
        ? {
            source_response_bytes: p.source_response_bytes,
            upstream_truncated: p.upstream_truncated,
          }
        : {}),
    };
  };
  let diagnostic = null;
  if (sync) requireValue(v.diagnostic === null);
  else {
    const d = v.diagnostic;
    requireValue(
      record(d) &&
        integer(d.bytes, 0, 65536) &&
        digest(d.sha256) &&
        d.source === 'wrapper' &&
        typeof d.diagnostic_truncated === 'boolean',
    );
    diagnostic = {
      bytes: d.bytes,
      sha256: d.sha256,
      source: 'wrapper',
      diagnostic_truncated: d.diagnostic_truncated,
    };
  }
  if (options) {
    requireValue(
      record(v.stdout) &&
        record(v.stderr) &&
        integer(v.stdout.bytes, 0, options.max_bytes_per_stream ?? 1048576) &&
        integer(v.stderr.bytes, 0, options.max_bytes_per_stream ?? 1048576) &&
        expires - start <= BigInt(options.retention_seconds ?? 86400) * 1000000000n,
    );
  }
  return {
    version: 1,
    result_id: v.result_id,
    kind: v.kind,
    state: 'ready',
    account_id: v.account_id,
    computer_id: v.computer_id,
    workspace_id: v.workspace_id,
    execution_id: v.execution_id,
    source: v.source,
    capture_started_at: v.capture_started_at,
    captured_at: v.captured_at,
    expires_at: v.expires_at,
    execution_observation: observation,
    stdout: prefix(v.stdout),
    stderr: prefix(v.stderr),
    diagnostic,
  };
}
export type ResultStream = 'stdout' | 'stderr' | 'diagnostic';
export function resultQuery(
  stream: unknown,
  offset: unknown,
  limit: unknown = PRESENTATION_DEFAULT,
) {
  requireValue(
    ['stdout', 'stderr', 'diagnostic'].includes(stream as string) &&
      integer(offset) &&
      integer(limit, 1, PRESENTATION_MAX) &&
      Number.isSafeInteger(offset + limit),
  );
  return { stream: stream as ResultStream, offset, limit };
}
export function binaryContent(bytes: Uint8Array): { text: string } | { base64: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (
      !bytes.some(
        (byte) => byte === 127 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13),
      ) &&
      Buffer.from(text, 'utf8').equals(Buffer.from(bytes))
    )
      return { text };
  } catch {
    /* exact binary follows */
  }
  return { base64: Buffer.from(bytes).toString('base64') };
}
export function resultPage(
  response: BoundedBytes,
  id: string,
  query: ReturnType<typeof resultQuery>,
) {
  const h = response.headers,
    bytes = response.bytes;
  const number = (name: string) => {
    const raw = h[name];
    requireValue(
      typeof raw === 'string' &&
        /^(0|[1-9][0-9]*)$/.test(raw) &&
        String(Number(raw)) === raw &&
        integer(Number(raw)),
    );
    return Number(raw);
  };
  requireValue(
    h['content-type']?.split(';')[0].trim().toLowerCase() === 'application/octet-stream',
  );
  requireValue(
    number('content-length') === bytes.length &&
      number('x-result-offset') === query.offset &&
      number('x-result-next-offset') === query.offset + bytes.length &&
      bytes.length <= query.limit,
  );
  requireValue(h['x-result-eof'] === 'true' || h['x-result-eof'] === 'false');
  const eof = h['x-result-eof'] === 'true';
  requireValue(eof || bytes.length === query.limit);
  return {
    result_id: id,
    stream: query.stream,
    offset: query.offset,
    next_offset: query.offset + bytes.length,
    eof,
    bytes: bytes.length,
    ...binaryContent(bytes),
  };
}
/** One deadline for the whole callback, including metadata, bytes and presentation. */
export async function retainedCall(
  parent: AbortSignal,
  mutation: boolean,
  fn: (signal: AbortSignal) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const controller = new AbortController(),
    abort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(() => controller.abort(), RETAINED_OPERATION_MS),
    signal = controller.signal,
    end = performance.now() + RETAINED_OPERATION_MS;
  try {
    if (signal.aborted) throw new CancelledError('cancelled');
    const result = await fn(signal);
    if (signal.aborted || performance.now() >= end) throw new CancelledError('cancelled');
    requireValue(Buffer.byteLength(JSON.stringify(result)) <= RETAINED_RESULT_MAX);
    if (signal.aborted || performance.now() >= end) throw new CancelledError('cancelled');
    return result;
  } catch (error) {
    const suffix = mutation
      ? ' Publication or deletion may have committed; its response is unconfirmed. Do not repeat a capture or command to recover this answer.'
      : ' No fallback or command replay was attempted.';
    if (signal.aborted || error instanceof CancelledError)
      return refused(`Retained operation cancelled.${suffix}`);
    // A full retained quota is a refusal before anything was reserved, and it
    // clears only by deleting or expiry, so the generic "may have committed"
    // sentence would send a model looking for a capture that never happened.
    const quota =
      error instanceof APIError && error.code === 'result_quota_exhausted'
        ? codeAdvice(error)
        : undefined;
    if (quota && error instanceof APIError)
      return withErrorMetadata(refused(`Retained operation refused (HTTP 409): ${quota}.`), error);
    if (error instanceof APIError)
      return withErrorMetadata(
        refused(
          `Retained operation failed (HTTP ${error.status}). Current authorization, availability or server support could not be confirmed.${suffix}`,
        ),
        error,
      );
    return refused(`Retained operation could not be completed or validated.${suffix}`);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
    controller.abort();
  }
}
/** Optional metadata must never change an already executed command's interpretation. */
export function synchronousResultId(v: unknown, status: number): string | undefined {
  if (
    !record(v) ||
    status !== 200 ||
    !resultId(v.result_id) ||
    v.timed_out !== false ||
    !integer(v.exit_code, -2147483648, 2147483647) ||
    typeof v.out_truncated !== 'boolean' ||
    typeof v.err_truncated !== 'boolean'
  )
    return undefined;
  for (const key of ['stdout_b64', 'stderr_b64']) {
    const data = v[key];
    if (typeof data !== 'string' || data.length > 22369624 || data.length % 4) return undefined;
    // Validate canonical padding without allocating the decoded large stream.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
      pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    for (let i = 0; i < data.length - pad; i++) {
      const c = data.charCodeAt(i);
      if (
        !(
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) ||
          c === 43 ||
          c === 47
        )
      )
        return undefined;
    }
    if (
      pad &&
      (data.length < 4 || alphabet.indexOf(data[data.length - pad - 1]) & (pad === 2 ? 15 : 3))
    )
      return undefined;
    if ((data.length / 4) * 3 - pad > 16 * 1024 * 1024) return undefined;
  }
  return v.result_id;
}

/** Bytes a retained listing may answer with: the account's whole store fits well inside. */
export const RETAINED_LISTING_MAX = 1024 * 1024;
/** Rows a listing shows; the rest are counted, never silently dropped. */
export const RETAINED_LISTING_SHOWN = 300;

export type RetainedQuota = {
  objects: number;
  bytes: number;
  max_objects: number;
  max_bytes: number;
};
export type RetainedUsage = { computer: RetainedQuota; account: RetainedQuota };

function retainedQuota(v: unknown): RetainedQuota {
  requireValue(
    record(v) &&
      integer(v.objects) &&
      integer(v.bytes) &&
      integer(v.max_objects, 1) &&
      integer(v.max_bytes, 1),
  );
  return {
    objects: v.objects as number,
    bytes: v.bytes as number,
    max_objects: v.max_objects as number,
    max_bytes: v.max_bytes as number,
  };
}

/** The quota block of a retained listing, strictly: a quota that cannot be read is never room. */
export function retainedUsage(v: unknown): RetainedUsage {
  requireValue(record(v));
  return { computer: retainedQuota(v.computer), account: retainedQuota(v.account) };
}

const quotaLine = (q: RetainedQuota) =>
  `${q.objects} of ${q.max_objects} objects, ${q.bytes} of ${q.max_bytes} bytes`;

/**
 * The sentence in front of a retained listing: how many, how full each quota
 * is, and what the usage counts that the rows do not.
 */
export function retainedListingLine(
  noun: 'artifact' | 'result',
  computer: string,
  count: number,
  usage: RetainedUsage,
): string {
  const full = (q: RetainedQuota) => q.objects >= q.max_objects || q.bytes >= q.max_bytes;
  const shown =
    count > RETAINED_LISTING_SHOWN
      ? ` Only the oldest ${RETAINED_LISTING_SHOWN} are shown here; ${count - RETAINED_LISTING_SHOWN} newer ones are not.`
      : '';
  const tool = noun === 'artifact' ? 'delete_artifact' : 'delete_result';
  return (
    `${count} retained ${noun}${count === 1 ? '' : 's'} on ${computer}, oldest first.${shown} ` +
    `Computer quota: ${quotaLine(usage.computer)}${full(usage.computer) ? ' (FULL)' : ''}. ` +
    `Account quota: ${quotaLine(usage.account)}${full(usage.account) ? ' (FULL)' : ''}. ` +
    'Artifacts and retained output share these quotas, and usage also counts captures in progress and deleted objects not yet cleaned up, which are not listed. ' +
    `A full quota clears only as objects expire or are deleted (${tool}). ` +
    "A row whose workspace_id differs from the computer's current workspace was recorded before a workspace move: nobody can read it, and only an account owner on an account-wide key can delete it."
  );
}

/** GET computers/:id/results, checked row by row. */
export function resultListing(v: unknown) {
  requireValue(record(v) && Array.isArray(v.results));
  const rows = v.results.map((r: unknown) => {
    requireValue(
      record(r) &&
        resultId(r.result_id) &&
        (r.kind === 'background-output' || r.kind === 'synchronous-output') &&
        integer(r.bytes) &&
        (r.workspace_id === null || scopeId(r.workspace_id)) &&
        (r.execution_id === null || executionId(r.execution_id)),
    );
    requireValue(time(r.expires_at) > time(r.started_at));
    return {
      result_id: r.result_id,
      kind: r.kind,
      bytes: r.bytes,
      workspace_id: r.workspace_id,
      execution_id: r.execution_id,
      started_at: r.started_at,
      expires_at: r.expires_at,
    };
  });
  return { results: rows, usage: retainedUsage(v.usage) };
}
