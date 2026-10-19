import { z } from 'zod';
import * as P from '../paths.js';

/**
 * What every tool that starts an agent run, or reads one back, says the same
 * way (OPL-6085): the thread arguments, the sentence that hands a model its
 * thread, and what a run's `stop` means. One module, so run_agent,
 * run_agent_chat and the background run tools cannot drift apart on them.
 */

/**
 * A thread to continue (OPL-6085), on every tool that starts a run.
 *
 * Checked against the platform's documented shape before the call: a value
 * that is not a thread id can only be refused, after a model has waited for it.
 */
export const threadIdArg = z
  .string()
  .regex(P.THREAD_ID, 'thread_id is thr_ followed by 24 lowercase hex characters')
  .optional()
  .describe(
    "Continue an earlier run's conversation: a thread_id an earlier agent run answered, or one from list_agent_threads. The model is given that thread's earlier turns, told they are done, and acts only on this task. Only on the computer the thread belongs to (another is refused with 409), and a thread holds at most 100 turns (a full one is refused with 409: leave thread_id out to start a new one). Leave it out to start a new thread.",
  );

/** Whether a run is kept in a thread at all (OPL-6085). Not on a background run, which refuses `false`. */
export const storeArg = z
  .boolean()
  .optional()
  .describe(
    'false keeps no record of this run: no thread_id comes back and it cannot be continued. It cannot be combined with thread_id. Leave it out to keep the run, which is the default.',
  );

/**
 * What a start refused during a platform update means, for the description of
 * every tool that starts a run (OPL-6094). The answer itself says it again,
 * with the wait the platform named.
 *
 * Keyed to the answer's own sentence, not to the status and the word: a 503
 * whose body carries `draining` beside a record of work is not that refusal,
 * the answer says so, and a description that granted a resend on the word
 * alone would contradict it.
 */
export const PAUSED_FOR_UPDATE =
  'While the platform updates it refuses new runs before they start (a 503 with reason draining): only when the answer says NOTHING STARTED AND NOTHING WAS BILLED, send the same call again after the wait it names, or after a short wait if it names none. Any other 5xx keeps its own advice, even if it shows reason draining.';

/** The refusal for `store: false` beside a `thread_id`, which the platform answers 400. */
export const STORE_WITH_THREAD =
  'store: false keeps nothing, so it cannot continue a thread: send thread_id or store: false, not both. Nothing was sent.';

/**
 * What a run's `stop` means, as the first thing a model reads about it.
 *
 * Shared by run_agent and the background run tools, because the same field
 * comes back on both and a run that hit max_steps reads the same either way:
 * a run that ended without finishing. Only `end_turn` is finished.
 */
export function stopVerdict(stop: string, steps: unknown): string {
  return stop === 'end_turn'
    ? 'finished'
    : stop === 'max_steps'
      ? `RAN OUT OF STEPS after ${typeof steps === 'number' ? steps : 'its max_steps'} — the task is probably unfinished`
      : stop === 'credits_exhausted'
        ? "RAN OUT OF AI CREDITS — the task is probably unfinished. A person can top up the account's credits on its billing page, or configure a model key"
        : stop === 'max_cost'
          ? 'REACHED max_cost_usd: another model call would have gone past it — the task is probably unfinished'
          : stop === 'refusal'
            ? 'the model declined the task'
            : stop === 'pause_turn'
              ? 'the model kept pausing its turn — the task is probably unfinished'
              : stop === 'incomplete'
                ? "the model's response was incomplete — the task is probably unfinished"
                : stop === 'safety_check'
                  ? 'STOPPED FOR A SAFETY CHECK: the model asked for approval of an action, which this tool cannot give — the task is unfinished; say so rather than running it again'
                  : stop === 'rate_limited'
                    ? 'RAN OUT OF RATE BUDGET part way — the task is probably unfinished; wait before sending what is left'
                    : `ended: ${stop} — not finished (only end_turn is)`;
}

/**
 * The thread a run was kept in, when the platform named one in the documented
 * shape. Anything else is left out of the sentence that tells a model to send
 * it back, rather than handed on as an id the next call would be refused.
 */
export function keptThread(value: unknown): string | undefined {
  return typeof value === 'string' && P.THREAD_ID.test(value) ? value : undefined;
}

/**
 * A `thread_id` field in an answer's schema: kept when it is a thread id, and
 * dropped — not a failed parse, and not handed on — when it is anything else.
 */
export const keptThreadField = z.string().regex(P.THREAD_ID).optional().catch(undefined);

/** The sentence that hands a model its thread. */
export const threadLine = (thread: string): string =>
  `Thread: ${thread}. Send it as thread_id with the next task to continue this conversation.`;
