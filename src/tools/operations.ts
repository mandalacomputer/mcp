import { z } from 'zod';
import { CancelledError, isTransientForPoll } from '../errors.js';
import { guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import { heartbeat, POLL_MS, pollDelay, sleep } from '../poll.js';
import { label, metadata, metadataCall } from './directory.js';
import { readAnnotations } from './results.js';
import type { Registrar } from './types.js';

/**
 * One lifecycle operation (platform OPL-5055), projected to its public fields.
 *
 * `kind` and `state` are open strings: the platform adds kinds, and one this
 * server does not know is a kind, not a malformed answer. Strict on the error's
 * shape, because a `failed` operation relayed without its reason is a failure
 * with nothing to say about why.
 */
const operation = z.object({
  id: label,
  kind: label,
  computer_id: z.string().nullable(),
  state: label,
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
});
type Operation = z.infer<typeof operation>;

const page = z.object({
  operations: z.array(operation),
  next_cursor: z.string().min(1).nullable(),
});

const operationIdArg = z
  .string()
  .min(1)
  .describe(
    'The operation_id a lifecycle tool answered: a create, a clone, a start, stop, suspend or restart, a resize, a snapshot restore, or a move.',
  );

/** The sentence every answer about an operation starts with. */
const line = (op: Operation): string =>
  `${op.id}: ${op.kind}${op.computer_id ? ` of ${op.computer_id}` : ''} — ${op.state}` +
  (op.error ? ` (${op.error.code}: ${op.error.message})` : '');

/**
 * Said beside every `succeeded`, because it is the misreading that costs the
 * most: a model that reads a succeeded start as a desktop that answers drives
 * a guest that is still booting.
 */
const NOT_BOOTED =
  'succeeded means the platform finished its step, not that the desktop has booted: wait_for_computer is still the wait for a desktop that answers.';

export const registerOperations: Registrar = (server, session) => {
  server.registerTool(
    'get_operation',
    {
      title: 'Read a lifecycle operation',
      description: `One lifecycle operation: what an accepted create, clone, start, stop, suspend, restart, snapshot restore, resize or move started, and where it got to. state is pending or running while live, and succeeded or failed once final; a failed one carries error.code (start_failed, build_failed, computer_gone, move_failed, resize_not_applied, lost, and more may be added) and a sentence. Most are already succeeded when the call that started them answered; a clone is running until its disk is copied, and a move until it lands. ${NOT_BOOTED} An id this key cannot see, or one that has expired, is not found.`,
      inputSchema: { operation_id: operationIdArg },
      annotations: readAnnotations,
    },
    ({ operation_id }, extra) =>
      metadataCall(async () => {
        const op = metadata(
          operation,
          await session.api.json('GET', P.operation(operation_id), { signal: extra.signal }),
        );
        return said(line(op), op);
      }),
  );

  server.registerTool(
    'list_operations',
    {
      title: 'List lifecycle operations',
      description:
        "The lifecycle operations this account's API calls started, newest first, a page at a time: kind, computer_id, state, error and timestamps. computer_id keeps one computer's (for a clone, the new computer's) — omitted, it is the whole account's, not the selected computer's. Pass next_cursor back as cursor for the next page; it is null on the last. Calls made from the dashboard record none.",
      inputSchema: {
        computer_id: z
          .string()
          .min(1)
          .optional()
          .describe("Only this computer's operations. Not defaulted to the selected computer."),
        limit: z.number().int().min(1).max(100).optional().describe('Page size; default 20.'),
        cursor: z.string().min(1).optional().describe('The next_cursor of the page before.'),
      },
      annotations: readAnnotations,
    },
    ({ computer_id, limit, cursor }, extra) =>
      metadataCall(async () => {
        const data = metadata(
          page,
          await session.api.json('GET', P.OPERATIONS, {
            query: { computer_id, limit, cursor },
            signal: extra.signal,
          }),
        );
        if (!data.operations.length) return said('No operations.', data);
        return said(
          data.operations.map(line).join('\n') +
            (data.next_cursor
              ? `\n\nMore: pass cursor=${data.next_cursor} for the next page.`
              : ''),
          data,
        );
      }),
  );

  server.registerTool(
    'wait_for_operation',
    {
      title: 'Wait for a lifecycle operation to finish',
      description: `Poll a lifecycle operation until it is final. Answers once it has succeeded; a failed one is an error carrying error.code and the platform's sentence (resize_not_applied is a move that landed at the old size: the computer has moved, and update_computer finishes the resize). ${NOT_BOOTED} Most operations are already final when their call answers, so this is for a clone (running until its disk is copied) or a move. Reports progress while it waits, so a client that sends a progressToken and sets resetTimeoutOnProgress can hold the request open; get_operation reads it if the wait runs out.`,
      inputSchema: {
        operation_id: operationIdArg,
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(900)
          .default(300)
          .describe('How long to wait before handing back and letting you poll.'),
      },
      annotations: readAnnotations,
    },
    ({ operation_id, timeout_s }, extra) =>
      guarded(async () => {
        const path = P.operation(operation_id);
        const untilDeadline = AbortSignal.timeout(timeout_s * 1000);
        const signal = extra.signal
          ? AbortSignal.any([extra.signal, untilDeadline])
          : untilDeadline;
        const api = session.api.with(signal);
        const beat = heartbeat(extra, server.server);
        let last: Operation | undefined;
        let blocked: string | undefined;
        try {
          while (!untilDeadline.aborted) {
            if (extra.signal?.aborted) {
              return refused(
                `Cancelled while waiting for ${operation_id}. The operation is not stopped by that; get_operation says where it got to.`,
                last,
              );
            }
            let raw: unknown;
            try {
              raw = await api.json('GET', path);
            } catch (err) {
              if (extra.signal?.aborted) continue;
              if (err instanceof CancelledError) {
                if (untilDeadline.aborted) break;
                blocked = err.message;
                await sleep(POLL_MS, signal);
                continue;
              }
              if (!isTransientForPoll(err)) throw err;
              blocked = err instanceof Error ? err.message : String(err);
              await beat(`${operation_id} — the platform could not be asked: ${blocked}`);
              await sleep(pollDelay(err), signal);
              continue;
            }
            const op = metadata(operation, raw);
            last = op;
            blocked = undefined;
            if (op.state === 'succeeded') return said(`${line(op)}.\n\n${NOT_BOOTED}`, op);
            if (op.state === 'failed') return refused(`${line(op)}.`, op);
            // A state this server does not know, on an operation the platform
            // says has FINISHED, is a final state added after it was written.
            // Polling it would run to the deadline and then call it live.
            if (op.finished_at !== null && op.state !== 'pending' && op.state !== 'running') {
              return refused(
                `${line(op)}. It has finished in a state this server does not know; read it with get_operation.`,
                op,
              );
            }
            await beat(line(op));
            await sleep(POLL_MS, signal);
          }
          return refused(
            blocked
              ? `Gave up after ${timeout_s}s; the platform could not be asked — the last attempt said: ${blocked}. The operation is not stopped by that; get_operation says where it got to.`
              : `Still ${last?.state ?? 'live'} after ${timeout_s}s. The operation is not stopped by that; wait again, or read it with get_operation.`,
            last,
          );
        } finally {
          await beat.stop();
        }
      }),
  );
};
