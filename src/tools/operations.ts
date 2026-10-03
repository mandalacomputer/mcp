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
  resendAfterSpentKey,
  resendUnseenByRead,
} from '../errors.js';
import { failed, guarded, operationIdOf, refused, said, unavailableAdvice } from '../format.js';
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
 * The `idempotency_key` a lifecycle tool takes (platform OPL-5127), checked
 * against the platform's rule here so a key it would refuse never leaves.
 */
const keyArg = z
  .string()
  .regex(
    IDEMPOTENCY_KEY_PATTERN,
    'idempotency_key must be 1 to 255 characters, each printable ASCII other than a space',
  )
  .optional();

const KEY_FIRST =
  "Optional. Omit it on a first attempt: a fresh key is sent for you, and an answer that is lost names it. Pass the key such an answer named to send the SAME call again without it being done twice — the platform answers with the first call's result, or says it is still running. After a 5xx that names no operation_id, send the same call again with the same key: nothing may have been done, and the platform either carries it out (the key was released) or answers idempotency_outcome_unknown. After idempotency_outcome_unknown, or a 5xx that names an operation_id, the key is spent (resending with it answers idempotency_outcome_unknown)";
const KEY_LAST = ' Keys last 24 hours; the same key with different arguments is refused.';

/**
 * The key on a step a read of the computer shows: start, stop, suspend,
 * delete, move, update_computer (not restart: see
 * {@link restartIdempotencyKeyArg}). See {@link resendAfterSpentKey}.
 */
export const idempotencyKeyArg = keyArg.describe(
  `${KEY_FIRST}: read get_computer (and get_operation when the error named an operation_id: succeeded means it happened, running means wait on it, pending alone is no reason to wait), and if the step did not take effect, send the call again with a new key, or none.${KEY_LAST}`,
);

/**
 * The key on restart_computer, whose step no read of the computer shows: it
 * reads running before and after a reset. So the route never conditions a
 * resend on get_computer; see {@link resendAfterSpentKey}.
 */
export const restartIdempotencyKeyArg = keyArg.describe(
  `${KEY_FIRST}. A restart cannot be seen in get_computer (it reads running before and after one), so do not read the computer to decide: read get_operation with the operation_id the error named, or list_operations with the key. Succeeded means the restart happened; running means wait on it. Anything else leaves it possibly done, so ask the user before sending it again with a new key, or none — a second restart resets the guest again.${KEY_LAST}`,
);

/**
 * The key on a call that makes a new computer or overwrites a disk: create,
 * clone, clone_snapshot, restore_snapshot. A resend after a spent key waits for
 * the operation to be final. See {@link resendAfterSpentKey}.
 */
export const buildIdempotencyKeyArg = keyArg.describe(
  `${KEY_FIRST}, and the call may still be under way: read its operation first (get_operation with the operation_id the error named, or list_operations with the key), wait while it is pending or running and do not resend meanwhile, and send the call with a new key (or none) only once the operation is final as failed or not found AND get_computer shows the step did not happen.${KEY_LAST}`,
);

/** The status line's advice beside the unsent-refusal resend paragraph. */
const UNSENT_REFUSAL_ADVICE =
  'the platform could not carry this out right now; see below for how to resend it';

/**
 * The answer to a lifecycle tool call that failed, with what its key means.
 *
 * The platform's own `idempotency_*` refusals get their sentence instead of the
 * generic `reason` advice. A failure whose outcome is unknown ENDS with the
 * retry that cannot do the step twice, and which one depends on who answered:
 *
 * - The answer never arrived, the keyed call is still running, or a proxy in
 *   front of the platform answered: the same tool, with the same key.
 * - The platform itself answered a `5xx` naming no `operation_id`: a refusal
 *   given before the call was sent anywhere names none, and releases the key
 *   (platform OPL-5310), so the same key is the resend. It is also safe when
 *   the key was not released after all: that is answered
 *   `idempotency_outcome_unknown`, whose own advice is the read below.
 * - The platform itself answered a `5xx` naming an `operation_id`: it has
 *   settled that key as lost (OPL-5304), so the same key can only be answered
 *   `idempotency_outcome_unknown`. The next step is a read, then a resend
 *   with a new key or none if the step did not happen. Which read depends on
 *   the tool (see {@link resendAfterSpentKey}): a create, clone or restore
 *   waits for its operation to be final, since a read of the computer made
 *   at once cannot see one still landing; a restart, which no read of the
 *   computer shows, is read off its operation and otherwise left to the user;
 *   every other step is read off the computer, since its operation stays
 *   `pending` for an hour regardless.
 */
export function keyedFailure(
  err: unknown,
  tool: string,
  what: string,
  key: string,
): CallToolResult {
  const advice = idempotencyAdvice(err, tool);
  const unsentRefusal =
    !keyedOutcomeUnknown(err) &&
    platformAnsweredFailure(err) &&
    !operationIdOf((err as APIError).body);
  // The unsent-refusal paragraph below says how to resend, so the status line
  // must not also carry a 503's read-the-state-first sentence: two routes in
  // one answer, and the read-first one names no key, which is the resend that
  // could do it twice (OPL-5437). Only that sentence is replaced; any other
  // 5xx keeps the platform's own word.
  const result =
    unsentRefusal && unavailableAdvice(err as APIError) !== undefined
      ? failed(err, advice === undefined, UNSENT_REFUSAL_ADVICE)
      : failed(err, advice === undefined);
  const [first, ...rest] = result.content;
  if (first?.type !== 'text') return result;
  let text = first.text;
  if (advice) text += `\n\nAbout its idempotency_key: ${advice}.`;
  if (keyedOutcomeUnknown(err)) {
    text += `\n\nTo retry without risking a second ${what}, call ${tool} again with idempotency_key "${key}".`;
  } else if (unsentRefusal) {
    text +=
      `\n\nThe platform answered this itself and named no operation, so nothing may have been done: an answer like this is usually a refusal given before the call was sent anywhere, which releases idempotency_key "${key}". ` +
      `Call ${tool} again with the SAME idempotency_key "${key}" (after a short wait on a busy or unavailable answer): if the key was released the platform carries the call out, and if not it answers idempotency_outcome_unknown and says what to read before anything else. ` +
      `Do not switch to a new key or none for this resend — that is the one that could make a second ${what}.`;
  } else if (platformAnsweredFailure(err)) {
    const op = operationIdOf((err as APIError).body);
    text +=
      `\n\nThe platform answered this itself, so whether it took effect is unknown — its host may still be carrying out the ${what} — and it has settled idempotency_key "${key}": resending with that key will answer idempotency_outcome_unknown, not do it. ` +
      `${resendAfterSpentKey(tool, op, key, `call ${tool} again`)}.` +
      (resendUnseenByRead(tool) ? '' : ` That way there is no second ${what}.`);
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
        "The lifecycle operations started on this account, from the API or the dashboard, newest first, a page at a time: kind, computer_id, state, error and timestamps. computer_id keeps one computer's (for a clone, the new computer's) — omitted, it is the whole account's, not the selected computer's. Pass next_cursor back as cursor for the next page; it is null on the last. Calls made from the dashboard are listed too, except a move.",
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
