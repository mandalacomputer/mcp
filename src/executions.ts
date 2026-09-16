/** Finite, lossless presentations for stable reads over volatile guest output. */
import { isExecutionId } from './paths.js';

export const EXECUTION_OUTPUT_DEFAULT = 4096;
export const EXECUTION_OUTPUT_MAX = 16384;
const DIAGNOSTIC_AVAILABLE_MAX = 65536;
const DIAGNOSTIC_DISPLAY_MAX = 4096;
export const EXECUTION_RESULT_MAX = 256 * 1024;

/** Messages contain only field names we own, never an unexpected payload value. */
export class ExecutionValueError extends Error {}

function invalid(field: string): never {
  throw new ExecutionValueError(`Invalid execution response: ${field}. No command was replayed.`);
}

export function executionComputerId(id: string): string {
  if (typeof id !== 'string' || !id.length || id.length > 256) {
    throw new ExecutionValueError(
      'Select a computer with use_computer or supply a computer_id of 1–256 characters.',
    );
  }
  return id;
}

export function executionReadQuery(
  stdout: number,
  stderr: number,
  limit = EXECUTION_OUTPUT_DEFAULT,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EXECUTION_OUTPUT_MAX) {
    throw new ExecutionValueError(`limit must be an integer from 1 to ${EXECUTION_OUTPUT_MAX}.`);
  }
  for (const [field, value] of [
    ['stdout_offset', stdout],
    ['stderr_offset', stderr],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - limit) {
      throw new ExecutionValueError(
        `${field} must be a safe nonnegative integer with room for limit.`,
      );
    }
  }
  return { stdout_offset: stdout, stderr_offset: stderr, limit };
}

function record(value: unknown, executionId: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid('expected an object');
  const d = value as Record<string, unknown>;
  if (!isExecutionId(d.execution_id) || d.execution_id !== executionId)
    invalid('execution_id does not match the requested execution');
  return d;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(field);
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 35) invalid(field);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match || match[0] !== value || !Number.isFinite(Date.parse(value))) invalid(field);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  )
    invalid(field);
  return value;
}

export function executionMetadata(value: unknown, computerId: string, executionId: string) {
  const d = record(value, executionId);
  if (d.computer_id !== computerId) invalid('computer_id does not match the requested computer');
  const pid = integer(d.pid, 'pid');
  if (pid <= 0) invalid('pid');
  const started = timestamp(d.started_at, 'started_at');
  if (d.output_source !== 'volatile_guest_files') invalid('output_source');
  if (d.status !== 'running' && d.status !== 'exited' && d.status !== 'lost') invalid('status');
  const identity = {
    execution_id: executionId,
    computer_id: computerId,
    pid,
    status: d.status,
    started_at: started,
    output_source: 'volatile_guest_files',
  };
  if (d.status === 'exited') {
    return {
      ...identity,
      ended_at: timestamp(d.ended_at, 'ended_at'),
      exit_code: integer(d.exit_code, 'exit_code'),
    };
  }
  if ('ended_at' in d || 'exit_code' in d) invalid('non-exited state carries exit evidence');
  return identity;
}

function bytes(value: unknown, field: string, max: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(max / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4 !== 0
  )
    invalid(field);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > max || decoded.toString('base64') !== value) invalid(field);
  return decoded;
}

/** No replacement characters, dropped BOM, split-character repair, or NUL in text. */
function present(name: string, data: Buffer): Record<string, string> {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    if (
      !data.some((byte) => (byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127) &&
      Buffer.from(decoded, 'utf8').equals(data)
    ) {
      return { [name]: decoded };
    }
  } catch {
    /* Preserve incomplete or non-text bytes exactly as base64. */
  }
  return { [`${name}_b64`]: data.toString('base64') };
}

export function executionOutput(
  value: unknown,
  executionId: string,
  query: ReturnType<typeof executionReadQuery>,
) {
  const d = record(value, executionId);
  const stdout = bytes(d.stdout_b64, 'stdout_b64', query.limit);
  const stderr = bytes(d.stderr_b64, 'stderr_b64', query.limit);
  const diagnostic = bytes(d.diagnostic_b64, 'diagnostic_b64', DIAGNOSTIC_AVAILABLE_MAX);
  const outOffset = integer(d.stdout_offset, 'stdout_offset');
  const errOffset = integer(d.stderr_offset, 'stderr_offset');
  if (outOffset !== query.stdout_offset + stdout.length)
    invalid('stdout_offset does not match decoded bytes');
  if (errOffset !== query.stderr_offset + stderr.length)
    invalid('stderr_offset does not match decoded bytes');
  const outMore = flag(d.stdout_more, 'stdout_more');
  const errMore = flag(d.stderr_more, 'stderr_more');
  if ((outMore && stdout.length !== query.limit) || (errMore && stderr.length !== query.limit))
    invalid('more flag without a full stream chunk');
  const prefix = diagnostic.subarray(0, DIAGNOSTIC_DISPLAY_MAX);
  return {
    execution_id: executionId,
    ...present('stdout', stdout),
    ...present('stderr', stderr),
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    stdout_offset: outOffset,
    stderr_offset: errOffset,
    stdout_more: outMore,
    stderr_more: errMore,
    ...present('diagnostic', prefix),
    diagnostic_available_bytes: diagnostic.length,
    diagnostic_displayed_bytes: prefix.length,
    diagnostic_display_truncated: prefix.length < diagnostic.length,
    diagnostic_truncated: flag(d.diagnostic_truncated, 'diagnostic_truncated'),
  };
}
