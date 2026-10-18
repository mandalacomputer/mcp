import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MODEL_KEY_HEADER } from '../api.js';
import { topUpUrl } from '../credits.js';
import { APIError, FUNDED_UNAVAILABLE, neverSent } from '../errors.js';
import { failed, guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import type { Session } from '../session.js';
import {
  BYOK_BILLING,
  BYOK_RUN_ARGS,
  FUNDED_BILLING,
  FUNDED_RUN_ARGS,
  preRunRefusal,
  RUN_AGENT_ANNOTATIONS,
  stopReason,
  usd,
} from './agent.js';
import { safeResult } from './chat.js';
import { keptThread, stopVerdict, threadIdArg, threadLine } from './conversation.js';
import { count, label, metadata, metadataCall } from './directory.js';
import { readAnnotations } from './results.js';
import type { Registrar } from './types.js';

// Background agent runs (OPL-6085). Which tools, and why:
//
// - start_agent_run: registered exactly when run_agent is, for run_agent's
//   reason: something has to pay for the run, and a tool refused on every call
//   for want of a key costs a turn to discover. It takes what run_agent takes
//   on the same payer, less `store` — a background run is kept so it can be
//   read back, and the platform refuses `store: false` on it.
// - get_agent_run, list_agent_runs and cancel_agent_run: always, filters
//   permitting. A run can be started from anywhere — an SDK, the CLI, the
//   dashboard, another session — and reading or stopping one needs only the
//   member role, not anything to pay with.
//
// A client driving a long task is the reason these exist: run_agent holds one
// tool call open for the whole run, which is minutes, and a client that cannot
// keep a call open that long watched its own timeout cancel a run it was paying
// for. Here the call that starts a run answers at once and the run goes on.

const money = z.number().finite().nonnegative();

/** One action, as a run records it. Display fields: lenient, but each typed. */
const step = z.object({
  n: count,
  tool: z.string().optional(),
  action: z.string().optional(),
  detail: z.string().optional(),
  error: z.string().optional(),
});
type Step = z.infer<typeof step>;

/**
 * How a completed run ended. `stop` is the field the verdict reads, so it is
 * required; a `result` without one is not a result.
 */
const result = z.object({
  stop: label,
  steps: count.optional(),
  text: z.string().optional(),
  usage: z
    .object({
      input_tokens: count,
      output_tokens: count,
      cache_read_tokens: count,
      cache_write_tokens: count,
    })
    .partial()
    .optional(),
  cost_usd: money.optional(),
});

/** Why a failed or interrupted run ended: the status the agent route would have answered. */
const runError = z.object({
  error: z.string(),
  status: z.number().int(),
  reason: z.string().optional(),
  top_up_url: z.string().optional(),
});

/**
 * One background run, projected to its public fields.
 *
 * `status` is an open string, as an operation's state is: a status this
 * server does not know is a status, and is read as not finished rather than
 * as a malformed answer. The id is held to its documented shape, because it
 * is what every later call names.
 */
const agentRun = z.object({
  id: z.string().regex(P.RUN_ID),
  computer_id: label,
  thread_id: z.string().nullable().optional(),
  status: label,
  prompt: z.string(),
  model: z.string(),
  max_steps: count,
  steps: count,
  cost_usd: money.optional(),
  result: result.optional(),
  error: runError.optional(),
  steps_taken: z.array(step),
  created_at: z.string(),
  updated_at: z.string(),
  ended_at: z.string().nullable(),
});
type AgentRun = z.infer<typeof agentRun>;

const runPage = z.object({ runs: z.array(agentRun), has_more: z.boolean() });

const STATUSES = ['running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;

const runIdArg = z
  .string()
  .regex(P.RUN_ID, 'run_id is run_ followed by 24 lowercase hex characters')
  .describe('The run_id start_agent_run or list_agent_runs answered: run_ and 24 hex characters.');

/** Whether a run's record says the task was done: completed, and stopped at end_turn. */
const finishedRun = (run: AgentRun): boolean =>
  run.status === 'completed' && run.result?.stop === 'end_turn';

/**
 * The first thing said about a run: whether it is going, finished, or ended
 * without finishing, and what to do next. Only `completed` with `end_turn` is
 * finished, and that is said in as many words, because every other ending is a
 * run whose steps stand on a task that is not done.
 */
function verdict(run: AgentRun, session: Session): string {
  switch (run.status) {
    case 'running':
      return 'STILL RUNNING — not finished. Read it again with get_agent_run in a few seconds (a step takes at least that long); cancel_agent_run stops it.';
    case 'completed': {
      if (!run.result)
        return 'completed, but its record carries no result, so whether the task was finished is unknown — take a screenshot before relying on it.';
      const stop = run.result.stop;
      return stop === 'end_turn'
        ? 'FINISHED: completed with stop end_turn.'
        : `completed WITHOUT FINISHING (stop ${stop}): ${stopVerdict(stop, run.result.steps ?? run.steps)}. The steps it took stand: take a screenshot before deciding what is left.`;
    }
    case 'failed': {
      const err = run.error;
      if (!err)
        return 'FAILED, and its record does not say why. The steps it took stand: take a screenshot before deciding what is left.';
      const topUp = topUpUrl(err.status, err, session.api.baseUrl);
      // A run on credits reports its charge; the platform's fixed sentence for
      // its AI service failing marks one that has none yet.
      const funded = run.cost_usd !== undefined || err.error === FUNDED_UNAVAILABLE;
      return `FAILED after ${run.steps} step(s).${stopReason(err, topUp, funded, 'start_agent_run')} The steps it took stand: take a screenshot before deciding what is left.`;
    }
    case 'cancelled':
      return 'CANCELLED: stopped where it was by a cancel, so the task is not finished. What it did stands: take a screenshot before deciding what is left.';
    case 'interrupted':
      return `INTERRUPTED: the platform restarted while it was going, or it stopped without its ending being recorded${run.error ? ` (${run.error.error})` : ''}. It was not resumed, and IT MAY HAVE DONE MORE THAN IT RECORDED: take a screenshot before starting another.`;
    default:
      return `status ${run.status}, which this server does not know: treat the task as not finished, and read the run again with get_agent_run.`;
  }
}

const stepLine = (s: Step): string =>
  `${s.n}. ${s.detail ?? s.action ?? s.tool ?? 'step'}${s.error ? ` — refused or failed: ${s.error}` : ''}`;

/** A run told in full: the verdict, then what it did, then its closing text. */
function describe(run: AgentRun, session: Session): string {
  const parts = [`${run.id} on ${run.computer_id}: ${verdict(run, session)}`];
  parts.push(
    `${run.steps} of at most ${run.max_steps} step(s), model ${run.model}; started ${run.created_at}` +
      (run.ended_at ? `, ended ${run.ended_at}.` : '.') +
      (run.cost_usd !== undefined ? ` Cost so far: ${usd(run.cost_usd)} of AI credits.` : ''),
  );
  const thread = keptThread(run.thread_id);
  if (thread) parts.push(threadLine(thread));
  else if (run.status === 'running')
    parts.push('No thread yet: a run is kept in one once it has acted, and its id appears here.');
  if (run.result?.text) parts.push(`Its closing text:\n${run.result.text}`);
  if (run.steps_taken.length)
    parts.push(
      `What it did${run.status === 'running' ? ' so far' : ''}:\n${run.steps_taken.map(stepLine).join('\n')}`,
    );
  return parts.join('\n\n');
}

/** The record beside the prose: everything but the steps, which the prose lists. */
const record = ({ steps_taken: _steps, ...rest }: AgentRun) => rest;

/** A prompt's first line, short enough for a listing. */
function title(prompt: string): string {
  const first = prompt.split('\n', 1)[0].trim();
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

/** One run in a listing: no steps and no closing text, and a shortened prompt. */
function summary(run: AgentRun) {
  const { steps_taken: _steps, result: done, prompt, ...rest } = run;
  return {
    ...rest,
    prompt: title(prompt),
    ...(done ? { stop: done.stop } : {}),
    finished: finishedRun(run),
  };
}

const listLine = (run: AgentRun): string =>
  `${run.id}: ${run.status}${run.result ? ` (stop ${run.result.stop})` : ''}${finishedRun(run) ? ', finished' : run.status === 'running' ? '' : ', NOT finished'} on ${run.computer_id} — ${run.steps} step(s), started ${run.created_at}: ${JSON.stringify(title(run.prompt))}`;

const POLL =
  'Only status completed with stop end_turn means the task was finished. completed with any other stop (max_steps, max_cost, credits_exhausted, rate_limited, refusal, …) stopped without finishing; failed carries the error that ended it; cancelled was stopped by cancel_agent_run; interrupted means the platform restarted while it was going, or its ending was not recorded, and it was not resumed — it MAY HAVE DONE MORE THAN IT RECORDED. Whatever the ending, the steps a run took stand: take a screenshot before deciding what is left, and continue with its thread_id rather than running the whole task again.';

const START =
  "Start the platform's agent loop on a computer in the BACKGROUND and answer at once with the run's id: the same loop run_agent drives — screenshot, decide, click, type, repeat — but this call does not wait for it.";

const WHEN =
  'Prefer it to run_agent when the task may take longer than your client holds one tool call open (a run is minutes), or when you have other work to do meanwhile; use run_agent when you can wait and want the answer in one call. Then read it with get_agent_run every few seconds — a step takes at least that long — until its status is no longer running; cancel_agent_run stops it.';

const RULES =
  "The computer must already be running, and one run drives a computer at a time: a computer another run is driving is refused with 409 (contention) — wait for that run or cancel it (list_agent_runs with status running finds it). thread_id continues an earlier run's conversation; the run's own thread_id, once it has one, continues this one. If this call's answer is lost, or it fails with a 5xx, a run may have started: list_agent_runs with computer_id and status running before starting another. Cancelling this call does not stop a run that has started; cancel_agent_run does.";

type StartArgs = {
  computer_id?: string;
  prompt: string;
  system?: string;
  provider?: 'anthropic' | 'openai';
  model?: string;
  max_steps: number;
  max_cost_usd?: number;
  thread_id?: string;
};

export const registerRuns: Registrar = (server, session) => {
  const out = (result: CallToolResult) => safeResult(result, session.modelKey);

  const start = (
    { computer_id, prompt, system, provider, model, max_steps, max_cost_usd, thread_id }: StartArgs,
    extra: { signal: AbortSignal },
  ) =>
    guarded(async () => {
      const id = session.resolve(computer_id);
      // Built before the request, so a path refused here is not mistaken for
      // a request whose answer was lost.
      const path = P.agentRuns(id);
      const body = P.agentBody({
        prompt,
        system,
        provider,
        model,
        max_steps,
        max_cost_usd,
        thread_id,
      });
      let raw: unknown;
      try {
        raw = await session.api.json('POST', path, {
          body,
          // No header at all on a run that credits pay for, as on run_agent:
          // its absence is what tells the platform to use them.
          ...(session.modelKey ? { headers: { [MODEL_KEY_HEADER]: session.modelKey } } : {}),
          signal: extra.signal,
        });
      } catch (err) {
        const refusal = preRunRefusal(err, session, 'start_agent_run');
        if (refusal) return refusal;
        // A 4xx is a refusal given before any run was recorded, and a request
        // that never left started nothing. Anything else — a 5xx, an answer
        // that never arrived — leaves open whether a run started, and starting
        // another once the first has ended would do the task twice. The
        // lookup that settles it is named here, where it is needed, and not
        // only in the description.
        if ((err instanceof APIError && err.status < 500) || neverSent(err)) throw err;
        const result = failed(err);
        result.content.push({
          type: 'text',
          text: `A RUN MAY HAVE STARTED on ${id}. Before starting another, call list_agent_runs with computer_id ${id}: a run still going shows with status running, and one that already ended is the newest on the list.`,
        });
        return result;
      }
      // Accepted is a run that holds the computer. An answer that cannot be
      // read is still that, and the one thing a model must not do then is
      // start another run blind.
      const parsed = agentRun.safeParse(raw);
      if (!parsed.success)
        return refused(
          `The platform accepted the run on ${id}, but its answer could not be read, so the run id is unknown and A RUN MAY BE GOING. Call list_agent_runs with computer_id ${id} and status running to find it before starting another.`,
        );
      const run = parsed.data;
      return said(
        `Started ${run.id} in the background; it goes on without this call. Read it with get_agent_run (run_id ${run.id}) every few seconds until its status is no longer running.\n\n${describe(run, session)}`,
        record(run),
      );
    }).then(out);

  if (session.modelKey) {
    server.registerTool(
      'start_agent_run',
      {
        title: 'Start a background agent run',
        description: `${START} ${BYOK_BILLING} ${WHEN} ${POLL} ${RULES}`,
        inputSchema: { ...BYOK_RUN_ARGS, thread_id: threadIdArg },
        annotations: RUN_AGENT_ANNOTATIONS,
      },
      start,
    );
  } else if (session.funded) {
    server.registerTool(
      'start_agent_run',
      {
        title: 'Start a background agent run',
        description: `${START} ${FUNDED_BILLING} ${WHEN} ${POLL} ${RULES}`,
        inputSchema: { ...FUNDED_RUN_ARGS, thread_id: threadIdArg },
        annotations: RUN_AGENT_ANNOTATIONS,
      },
      start,
    );
  }

  server.registerTool(
    'get_agent_run',
    {
      title: 'Read a background agent run',
      description: `A background agent run as it stands: its status, every step so far, its cost on AI credits, and once it has ended, how. Poll it every few seconds while its status is running; a step takes at least that long, so polling faster only spends rate budget. ${POLL} A run this key cannot see is not found.`,
      inputSchema: { run_id: runIdArg },
      annotations: readAnnotations,
    },
    ({ run_id }, extra) =>
      metadataCall(async () => {
        const run = metadata(
          agentRun,
          await session.api.json('GET', P.agentRun(run_id), { signal: extra.signal }),
        );
        return said(describe(run, session), record(run));
      }).then(out),
  );

  server.registerTool(
    'list_agent_runs',
    {
      title: 'List background agent runs',
      description:
        "Background agent runs on this account, newest first, a page at a time: each run's id, computer, status (running, completed, failed, cancelled or interrupted), how it stopped, its steps and cost. Only completed with stop end_turn is finished. computer_id keeps one computer's runs — it is not defaulted to the selected computer — and status keeps one status: status running finds a run still going, which is the one to wait for or cancel before starting another on that computer. Steps and closing text are not listed, and long prompts are shortened; get_agent_run reads one whole. Pass before with the last run's id for the next page. A key confined to a workspace sees that workspace's runs. The account keeps its 1000 newest ended runs and every run still going.",
      inputSchema: {
        computer_id: z
          .string()
          .min(1)
          .optional()
          .describe("Only this computer's runs. Not defaulted to the selected computer."),
        status: z.enum(STATUSES).optional().describe('Only runs in this status.'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size; default 20.'),
        before: z
          .string()
          .regex(P.RUN_ID, 'before is a run_id: run_ followed by 24 lowercase hex characters')
          .optional()
          .describe('The id of the last run on the previous page, for the page after it.'),
      },
      annotations: readAnnotations,
    },
    ({ computer_id, status, limit, before }, extra) =>
      metadataCall(async () => {
        const page = metadata(
          runPage,
          await session.api.json('GET', P.AGENT_RUNS, {
            query: { computer_id, status, limit, before },
            signal: extra.signal,
          }),
        );
        const more = page.has_more && page.runs.length;
        const data = { runs: page.runs.map(summary), has_more: page.has_more };
        if (!page.runs.length) return said('No background runs.', data);
        return said(
          page.runs.map(listLine).join('\n') +
            (more
              ? `\n\nMore: pass before=${page.runs[page.runs.length - 1].id} for the next page.`
              : ''),
          data,
        );
      }).then(out),
  );

  server.registerTool(
    'cancel_agent_run',
    {
      title: 'Cancel a background agent run',
      description:
        'Stop a background agent run where it is: the model call in flight is abandoned and no further action is taken. What it already did to the desktop stands, and so does what it cost: take a screenshot before deciding what is left. Cancelling a run that has already ended changes nothing and answers it as it is. A run this key cannot see is not found.',
      inputSchema: { run_id: runIdArg },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ run_id }, extra) =>
      guarded(async () => {
        const run = metadata(
          agentRun,
          await session.api.json('POST', P.agentRunCancel(run_id), { signal: extra.signal }),
        );
        const head =
          run.status === 'cancelled'
            ? `Cancelled ${run.id}: it stopped where it was.`
            : run.status === 'running'
              ? `The cancel of ${run.id} was answered, but the run still reads running: read it again with get_agent_run before relying on it having stopped.`
              : `${run.id} had already ended (${run.status}), so nothing was cancelled.`;
        return said(`${head}\n\n${describe(run, session)}`, record(run));
      }).then(out),
  );
};
