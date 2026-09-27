import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { IDEMPOTENCY_KEY_PATTERN } from '../api.js';
import {
  type APIError,
  CancelledError,
  idempotencyAdvice,
  isTransientForPoll,
  keyedOutcomeUnknown,
  platformAnsweredFailure,
} from '../errors.js';
import { failed, guarded, operationIdOf, refused, said } from '../format.js';
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
  // The key the call that started it was sent with (OPL-5127): null for one
  // sent without, and absent from a platform that predates the field.
  idempotency_key: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
});
type Operation = z.infer<typeof operation>;

const page = z.object({
  operations: z.array(operation),
  next_cursor: z.string().min(1).nullable(),
});

/**
 * The `idempotency_key` every lifecycle tool takes (platform OPL-5127), checked
 * against the platform's rule here so a key it would refuse never leaves.
 */
export const idempotencyKeyArg = z
  .string()
  .regex(
    IDEMPOTENCY_KEY_PATTERN,
    'idempotency_key must be 1 to 255 characters, each printable ASCII other than a space',
  )
  .optional()
  .describe(
    "Optional. Omit it on a first attempt: a fresh key is sent for you, and an answer that is lost names it. Pass the key such an answer named to send the SAME call again without it being done twice — the platform answers with the first call's result, or says it is still running. After a 5xx the platform answered, or idempotency_outcome_unknown, the key is spent: read get_computer or get_operation first, since resending with that key answers idempotency_outcome_unknown, and send the call with a new key (or none) only if the step did not happen. Keys last 24 hours; the same key with different arguments is refused.",
  );

/**
 * The answer to a lifecycle tool call that failed, with what its key means.
 *
 * The platform's own `idempotency_*` refusals get their sentence instead of the
 * generic `reason` advice. A failure whose outcome is unknown ENDS with the
 * retry that cannot do the step twice, and which one depends on who answered:
 *
 * - The answer never arrived, the keyed call is still running, or a proxy in
 *   front of the platform answered: the same tool, with the same key.
 * - The platform itself answered a `5xx`: it has settled that key as lost
 *   (OPL-5304), so the same key can only be answered
 *   `idempotency_outcome_unknown`. Read first, then resend with a new key or
 *   none, and only if the step did not happen.
 */
export function keyedFailure(
  err: unknown,
  tool: string,
  what: string,
  key: string,
): CallToolResult {
  const advice = idempotencyAdvice(err);
  const result = failed(err, advice === undefined);
  const [first, ...rest] = result.content;
  if (first?.type !== 'text') return result;
  let text = first.text;
  if (advice) text += `\n\nAbout its idempotency_key: ${advice}.`;
  if (keyedOutcomeUnknown(err)) {
    text += `\n\nTo retry without risking a second ${what}, call ${tool} again with idempotency_key "${key}".`;
  } else if (platformAnsweredFailure(err)) {
    const op = operationIdOf((err as APIError).body);
    text +=
      `\n\nThe platform answered this itself, so whether it took effect is unknown, and it has settled idempotency_key "${key}": resending with that key will answer idempotency_outcome_unknown, not do it. ` +
      `Read first — get_computer (list_computers after a create or a clone)${op ? `, or get_operation ${op}` : ''} — and only if it did not take effect, call ${tool} again with a new idempotency_key, or none, so there is no second ${what}.`;
  }
  return { ...result, content: [{ ...first, text }, ...rest] };
}

const operationIdArg = z
  .string()
  .min(1)
  .describe(
    'The operation_id a lifecycle tool answered: a create, a clone, a start, stop, suspend or restart, a resize, a snapshot restore, or a move.',
  );

/** The sentence every answer about an operation starts with. */
const line = (op: Operation): string =>
  `${op.id}: ${op.kind}${op.computer_id ? ` of ${op.computer_id}` : ''} — ${op.state}` +
  (op.error ? ` (${op.error.code}: ${op.error.message})` : '') +
  (op.idempotency_key ? ` [idempotency_key ${JSON.stringify(op.idempotency_key)}]` : '');

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
      description: `One lifecycle operation: what an accepted create, clone, start, stop, suspend, restart, snapshot restore, resize, move or delete started, and where it got to. A call made with an idempotency_key is recorded pending before it is carried out, so it can be found even when its answer was lost; one the platform never heard end is failed with error.code lost. state is pending or running while live, and succeeded or failed once final; a failed one carries error.code (start_failed, build_failed, computer_gone, move_failed, resize_not_applied, lost, and more may be added) and a sentence. Most are already succeeded when the call that started them answered; a clone is running until its disk is copied, and a move until it lands. ${NOT_BOOTED} An id this key cannot see, or one that has expired, is not found.`,
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
        idempotency_key: z
          .string()
          .regex(
            IDEMPOTENCY_KEY_PATTERN,
            'idempotency_key must be 1 to 255 characters, each printable ASCII other than a space',
          )
          .optional()
          .describe(
            "Only the operation the lifecycle call sent with this idempotency_key recorded — found even when that call's answer was lost — within the key's 24 hours.",
          ),
      },
      annotations: readAnnotations,
    },
    ({ computer_id, limit, cursor, idempotency_key }, extra) =>
      metadataCall(async () => {
        const data = metadata(
          page,
          await session.api.json('GET', P.OPERATIONS, {
            query: { computer_id, limit, cursor, idempotency_key },
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
