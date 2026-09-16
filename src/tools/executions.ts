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
            ? 'The output is unavailable in the current state; no resume was requested.'
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

export const registerExecutions: Registrar = (server, session) => {
  server.registerTool(
    'get_execution',
    {
      title: 'Read a stable execution observation',
      description:
        'Read one background execution by stable execution_id. Last-observed running, exited or lost; running is not proof the computer is awake, and lost establishes no success or failure. Metadata only: no guest I/O, activity refresh, resume, polling loop, PID fallback or command replay. Handles are volatile and can become unavailable after restart, replacement, expiry or cleanup.',
      inputSchema: identity,
      annotations,
    },
    ({ computer_id, execution_id }, extra) =>
      readResult(async () => {
        const id = executionComputerId(session.resolve(computer_id));
        const data = await session.api
          .with(extra.signal)
          .json('GET', P.execution(id, execution_id));
        return said(
          'Last observed execution state; running does not prove the computer is awake, and lost is not an exit result.',
          executionMetadata(data, id, execution_id),
        );
      }, extra.signal),
  );

  server.registerTool(
    'read_execution_output',
    {
      title: 'Read an independent execution output chunk',
      description:
        'Read volatile, mutable guest output once at explicit independent stdout_offset and stderr_offset byte positions. Performs guest I/O but does not refresh activity, resume, change shared PID cursors, retry, tail, capture or replay a command. Unsuitable for passive Activities/history. Each stream is limited to 4096 bytes by default, at most 16384. Text is lossless UTF-8 (BOM preserved); NUL, binary and split UTF-8 remain exact base64. False more flags mean current EOF, not completion. Diagnostics repeat independently; only the first 4096 diagnostic bytes are displayed, with distinct available/displayed counts and display/daemon truncation flags.',
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
