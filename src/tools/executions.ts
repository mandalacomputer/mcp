import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { APIError, CancelledError } from '../errors.js';
import {
  EXECUTION_OUTPUT_DEFAULT,
  EXECUTION_OUTPUT_MAX,
  EXECUTION_RESULT_MAX,
  ExecutionValueError,
  executionComputerId,
  executionMetadata,
  executionOutput,
  executionReadQuery,
} from '../executions.js';
import { refused, said, withErrorMetadata } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

const identity = {
  computer_id: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Computer to read; defaults to use_computer selection.'),
  execution_id: z
    .string()
    .length(37)
    .regex(/^exec_[0-9a-f]{32}$/)
    .describe('Stable execution_id returned by an accepted background exec; never a PID.'),
};
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

async function readResult(
  fn: () => Promise<CallToolResult>,
  signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    if (signal.aborted) return refused('Execution read cancelled. No command was replayed.');
    const result = await fn();
    if (signal.aborted) return refused('Execution read cancelled. No command was replayed.');
    if (Buffer.byteLength(JSON.stringify(result)) > EXECUTION_RESULT_MAX) {
      return refused(
        'Execution response cannot fit the bounded tool result. No output was presented and no command was replayed.',
      );
    }
    return result;
  } catch (err) {
    if (signal.aborted || err instanceof CancelledError)
      return refused('Execution read cancelled. No command was replayed.');
    if (err instanceof ExecutionValueError) return refused(err.message);
    if (err instanceof APIError) {
      const status = err.status;
      const advice =
        status === 404
          ? 'This execution is unavailable; do not substitute a PID or start the command again.'
          : status === 409
            ? conflictAdvice(err)
            : status === 401
              ? 'A credential was refused; inspect the supplied classification before another read.'
              : status === 403
                ? 'The current credential does not have permission for this read.'
                : 'The platform refused this read; no fallback was attempted.';
      return withErrorMetadata(
        refused(`Execution read failed (HTTP ${status}). ${advice} No command was replayed.`),
        err,
      );
    }
    // Network/JSON errors and redirect locations can contain untrusted text or private URLs.
    return refused(
      'Execution read could not be completed. Check the selected computer and connection; no fallback or command replay was attempted.',
    );
  }
}

/**
 * What a 409 on these two reads means, in the platform's own classification.
 *
 * The reason first, as everywhere else: `contention` is a command whose state
 * the platform has not checked yet, which clears in seconds. A code of
 * `output_unavailable` is two different answers, told apart by the marker
 * beside it. With one, the output was lost and no retry changes that. Without
 * one, a guest log could not be opened, which is also what a read sent in the
 * moment before a just-started command has created its logs is answered, so a
 * later read at the same offsets can still return it. A 409 with no reason is
 * the platform's final answer. Saying none of this left a model to its
 * instinct on a 409, which is to send it again.
 */
function conflictAdvice(err: APIError): string {
  if (err.reason === 'contention')
    return 'Something was in flight (for a command that was running when the service on the computer\u2019s host restarted, a check of its state that has not been made yet), so this read is worth sending again in a moment; no resume was requested.';
  if (err.code === 'output_unavailable' && outputLost(err.body))
    return 'This execution\u2019s output cannot be read, and sending the read again will not change that; get_execution still reports its state and exit code. Do not run the command again to recover the output: that repeats whatever it did. Inspect what it changed inside the computer instead.';
  if (err.code === 'output_unavailable')
    return 'A guest log for this execution could not be opened. Just after a command starts, its logs may not exist yet, so a later read at the same offsets can return the output; if it keeps answering this, the logs have been removed. Do not run the command again to recover the output: that repeats whatever it did.';
  if (err.reason === 'unavailable')
    return 'The computer is stopped or suspended, and no resume was requested.';
  if (err.reason === undefined)
    return 'This answer is final: sending the same read again will not help, and no resume was requested.';
  return 'The output is unavailable in the current state; no resume was requested.';
}

/** Whether a refusal says the output itself was lost, rather than a log not opened yet. */
function outputLost(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const why = (body as Record<string, unknown>).output_unavailable;
  return why != null && why !== '';
}

/** The sentence that keeps a model from reading the output route's refusal as a passing fault. */
const unavailableNote = (why: string) =>
  ` This command\u2019s output cannot be read (output_unavailable: ${JSON.stringify(why)}): read_execution_output answers 409 output_unavailable for it, and no retry changes that. Its status and exit code are still the guest agent\u2019s answer. Losing the output did not undo the command, so do not run it again to recover the output: that repeats whatever it did, and while it is still running starts a second copy beside it. Inspect what it changed inside the computer instead.`;

export const registerExecutions: Registrar = (server, session) => {
  server.registerTool(
    'get_execution',
    {
      title: 'Read a stable execution observation',
      description:
        'Read one background execution by stable execution_id. Last-observed running, exited or lost; running is not proof the computer is awake, and lost establishes no success or failure. Metadata only: no guest I/O, activity refresh, resume, polling loop, PID fallback or command replay. Handles are volatile and can become unavailable after restart, replacement, expiry or cleanup. A command that was already running when the service on the computer\u2019s host restarted keeps its execution_id and answers with `output_unavailable` (today `"daemon_restarted"`): its status and exit code are still reported, but its output cannot be read. For a few seconds after such a restart this read is refused with a 409 whose reason is `contention`, which is worth sending again; a 409 with no reason is final, and sending it again will not help.',
      inputSchema: identity,
      annotations,
    },
    ({ computer_id, execution_id }, extra) =>
      readResult(async () => {
        const id = executionComputerId(session.resolve(computer_id));
        const data = await session.api
          .with(extra.signal)
          .json('GET', P.execution(id, execution_id));
        const observed = executionMetadata(data, id, execution_id);
        return said(
          `Last observed execution state; running does not prove the computer is awake, and lost is not an exit result.${
            observed.output_unavailable === undefined
              ? ''
              : unavailableNote(observed.output_unavailable)
          }`,
          observed,
        );
      }, extra.signal),
  );

  server.registerTool(
    'read_execution_output',
    {
      title: 'Read an independent execution output chunk',
      description:
        'Read volatile, mutable guest output once at explicit independent stdout_offset and stderr_offset byte positions. Performs guest I/O but does not refresh activity, resume, change shared PID cursors, retry, tail, capture or replay a command. Unsuitable for passive Activities/history. Each stream is limited to 4096 bytes by default, at most 16384. Text is lossless UTF-8 (BOM preserved); NUL, binary and split UTF-8 remain exact base64. False more flags mean current EOF, not completion. Diagnostics repeat independently; only the first 4096 diagnostic bytes are displayed, with distinct available/displayed counts and display/daemon truncation flags. A 409 with code `output_unavailable` that also carries `output_unavailable` (today `"daemon_restarted"`, for a command that was already running when the service on the computer\u2019s host restarted, and on get_execution too) is final: the output cannot be read, and sending the read again will not help; its status is still on get_execution. Without that marker it means a guest log could not be opened, which just after a command starts can be a log not created yet, so a later read at the same offsets can succeed. Either way, running the command again repeats what it did rather than recovering its output.',
      inputSchema: {
        ...identity,
        stdout_offset: offset,
        stderr_offset: offset,
        limit: z.number().int().min(1).max(EXECUTION_OUTPUT_MAX).default(EXECUTION_OUTPUT_DEFAULT),
      },
      annotations,
    },
    ({ computer_id, execution_id, stdout_offset, stderr_offset, limit }, extra) =>
      readResult(async () => {
        const query = executionReadQuery(stdout_offset, stderr_offset, limit);
        const id = executionComputerId(session.resolve(computer_id));
        const data = await session.api
          .with(extra.signal)
          .json('GET', P.executionOutput(id, execution_id), { query });
        return said(
          'Volatile guest output, not retained artifacts. False more flags mean current EOF only. Diagnostics repeat; a truncated display is only a prefix of the available diagnostic. No shared cursor was consumed.',
          executionOutput(data, execution_id, query),
        );
      }, extra.signal),
  );
};
