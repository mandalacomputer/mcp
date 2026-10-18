import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { APIError, NotFoundError, neverSent } from '../errors.js';
import { guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import { usd } from './agent.js';
import { safeResult } from './chat.js';
import { stopVerdict } from './conversation.js';
import { count, label, metadata, metadataCall } from './directory.js';
import { readAnnotations } from './results.js';
import type { Registrar } from './types.js';

// Agent threads (OPL-6085): the conversations agent runs keep. Which tools,
// and why:
//
// - list_agent_threads and get_agent_thread: yes. A thread is how an earlier
//   run's work is found again — what it was asked, what it answered, how it
//   ended — and its id is what continues it. Reading one needs the member role
//   and nothing to pay with, so they are offered whether or not this session
//   can start a run.
// - delete_agent_thread: yes, behind `confirm: true`, for the reason
//   delete_secret is offered: cleaning up what a task made is part of the task.
//   A prompt is where private text ends up, and a thread keeps every prompt and
//   answer until it is deleted or displaced; and an account keeps 1000, past
//   which a key that can delete none of them (a workspace key whose workspace
//   holds none) gets runs that are not kept at all. What it removes is history
//   only: no run is stopped and nothing on a desktop changes. It is not
//   undoable, and every thread on the account is visible to this key, so the
//   description limits it to threads this conversation made or the user named.
//   Unlike minting or revoking an API key, which stay out of a model's hands,
//   nothing here hands a model a credential or cuts anyone off.

const money = z.number().finite().nonnegative();

const threadSummary = z.object({
  id: z.string().regex(P.THREAD_ID),
  computer_id: label,
  title: z.string(),
  turns: count,
  created_at: z.string(),
  updated_at: z.string(),
});
type ThreadSummary = z.infer<typeof threadSummary>;

/**
 * One turn. `role` and `stop` are open strings: a role or an ending this
 * server does not know is shown as it came, and an ending it does not know is
 * read as not finished.
 */
const turn = z.object({
  role: label,
  text: z.string(),
  stop: z.string().optional(),
  error: z.string().optional(),
  steps: count.optional(),
  cost_usd: money.optional(),
  created_at: z.string(),
});
type Turn = z.infer<typeof turn>;

const thread = threadSummary.extend({ messages: z.array(turn) });
const threadPage = z.object({ threads: z.array(threadSummary), has_more: z.boolean() });

const threadIdArg = z
  .string()
  .regex(P.THREAD_ID, 'thread_id is thr_ followed by 24 lowercase hex characters')
  .describe('The thread: thr_ and 24 hex characters, from an agent run or list_agent_threads.');

/**
 * How much turn text one get_agent_thread answer carries, in characters.
 *
 * A thread holds up to 100 turns of up to 32,000 characters each, and one
 * answer holding all of them is past what a client will put in a model's
 * context — or is cut by the client, which drops the newest turns, the ones a
 * continuation needs. So an answer holds the newest turns that fit, at least
 * one whatever its size, and says which turn to read back from for the rest.
 */
const THREAD_CHARS = 48_000;

/** The endings that leave a turn's run doing, or having done, more than it says. */
const UNSETTLED = new Set(['running', 'aborted', 'interrupted']);

/** How an assistant turn's run ended, in words. Only end_turn is finished. */
function ending(t: Turn): string {
  switch (t.stop) {
    case undefined:
      return 'no ending recorded';
    case 'running':
      return 'STILL RUNNING: its run is going, and MAY DO MORE THAN THIS SAYS';
    case 'aborted':
      return 'ABORTED part way: it MAY HAVE DONE MORE THAN IT REPORTED';
    case 'interrupted':
      return 'INTERRUPTED: the platform restarted before it finished, and it MAY HAVE DONE MORE THAN IT REPORTED';
    case 'error':
      return `FAILED${t.error ? `: ${t.error}` : ''}`;
    default:
      return `${stopVerdict(t.stop, t.steps)} (stop ${t.stop})`;
  }
}

function turnLine(t: Turn, n: number): string {
  if (t.role !== 'assistant') return `${n}. ${t.role}, ${t.created_at}:\n${t.text}`;
  const facts = [
    ending(t),
    ...(t.steps !== undefined ? [`${t.steps} step(s)`] : []),
    ...(t.cost_usd !== undefined ? [`${usd(t.cost_usd)} of AI credits`] : []),
  ];
  return `${n}. assistant, ${t.created_at} — ${facts.join('; ')}:\n${t.text}`;
}

/** `Turn 4 is` or `Turns 1 to 3 are`: a run of turn numbers, with its verb. */
const span = (from: number, to: number, one: string, many: string): string =>
  from === to ? `Turn ${from} ${one}` : `Turns ${from} to ${to} ${many}`;

const summaryLine = (t: ThreadSummary): string =>
  `${t.id} on ${t.computer_id}: ${JSON.stringify(t.title)} — ${t.turns} turn(s), last used ${t.updated_at}`;

export const registerThreads: Registrar = (server, session) => {
  const out = (result: CallToolResult) => safeResult(result, session.modelKey);

  server.registerTool(
    'list_agent_threads',
    {
      title: 'List kept agent conversations',
      description:
        "The conversations agent runs have kept on this account, most recently used first: each thread's id, the computer it belongs to, a title (the first line of its first prompt) and how many turns it holds. Runs from run_agent, run_agent_chat and start_agent_run are kept unless they sent store: false. To continue one, send its id as thread_id on the next run, on the same computer. computer_id keeps one computer's threads — it is not defaulted to the selected computer. Pass before with the last thread's id for the next page. A key confined to a workspace sees that workspace's threads; viewers are refused, since a prompt is where private text ends up.",
      inputSchema: {
        computer_id: z
          .string()
          .min(1)
          .optional()
          .describe("Only this computer's threads. Not defaulted to the selected computer."),
        limit: z.number().int().min(1).max(100).optional().describe('Page size; default 20.'),
        before: z
          .string()
          .regex(P.THREAD_ID, 'before is a thread_id: thr_ followed by 24 lowercase hex characters')
          .optional()
          .describe('The id of the last thread on the previous page, for the page after it.'),
      },
      annotations: readAnnotations,
    },
    ({ computer_id, limit, before }, extra) =>
      metadataCall(async () => {
        const page = metadata(
          threadPage,
          await session.api.json('GET', P.AGENT_THREADS, {
            query: { computer_id, limit, before },
            signal: extra.signal,
          }),
        );
        if (!page.threads.length) return said('No kept agent conversations.', page);
        return said(
          page.threads.map(summaryLine).join('\n') +
            (page.has_more
              ? `\n\nMore: pass before=${page.threads[page.threads.length - 1].id} for the next page.`
              : ''),
          page,
        );
      }).then(out),
  );

  server.registerTool(
    'get_agent_thread',
    {
      title: 'Read a kept agent conversation',
      description:
        'One kept conversation, oldest turn first: each user turn is a prompt, and each assistant turn is how that run answered — its closing text, how it ended, its steps, and its cost on AI credits. Read it to see what earlier runs on a computer were asked and did before continuing it with thread_id. An answer holds the newest turns that fit in about 48,000 characters; when earlier turns did not fit it says so, and before_turn reads the ones before. Only an assistant turn that ended end_turn finished its task. One that is running (its run is still going), aborted (stopped part way) or interrupted (the platform restarted mid-run) MAY HAVE DONE MORE THAN IT REPORTED: look at the desktop before relying on it. A thread this key cannot see is not found.',
      inputSchema: {
        thread_id: threadIdArg,
        before_turn: z
          .number()
          .int()
          .min(2)
          .optional()
          .describe(
            'Only turns numbered below this one, for the turns an earlier answer said did not fit. Leave it out for the newest turns.',
          ),
      },
      annotations: readAnnotations,
    },
    ({ thread_id, before_turn }, extra) =>
      metadataCall(async () => {
        const data = metadata(
          thread,
          await session.api.json('GET', P.agentThread(thread_id), { signal: extra.signal }),
        );
        const { messages, ...meta } = data;
        // Over every turn, not only the ones shown: a run that may have done
        // more than it said is worth knowing about wherever it sits.
        const unsettled = messages.flatMap((t, i) =>
          t.role === 'assistant' && t.stop !== undefined && UNSETTLED.has(t.stop) ? [i + 1] : [],
        );
        const last = Math.min(messages.length, (before_turn ?? messages.length + 1) - 1);
        const shown: string[] = [];
        let first = last + 1;
        let used = 0;
        for (let n = last; n >= 1; n--) {
          const line = turnLine(messages[n - 1], n);
          if (shown.length && used + line.length > THREAD_CHARS) break;
          shown.unshift(line);
          used += line.length;
          first = n;
        }
        const head =
          `${summaryLine(data)}. Continue it with thread_id ${data.id} on ${data.computer_id}.` +
          (unsettled.length
            ? `\n\nTurn ${unsettled.join(', ')} ended running, aborted or interrupted: ${unsettled.length === 1 ? 'that run' : 'those runs'} may have done more than reported. Take a screenshot before continuing, and do not assume what was or was not done.`
            : '');
        const earlier =
          first > 1
            ? `\n\n${span(1, first - 1, 'is not', 'are not')} shown, to keep this answer bounded: call get_agent_thread again with before_turn ${first} for ${first > 2 ? 'them' : 'it'}.`
            : '';
        const later =
          last < messages.length
            ? `\n\n${span(last + 1, messages.length, 'comes', 'come')} after these: leave before_turn out for the newest.`
            : '';
        return said(
          `${head}${earlier}${later}\n\n${shown.length ? shown.join('\n\n') : 'No turns.'}`,
          { ...meta, ...(shown.length ? { shown_turns: { first, last } } : {}) },
        );
      }).then(out),
  );

  server.registerTool(
    'delete_agent_thread',
    {
      title: 'Delete a kept agent conversation',
      description:
        "Permanently delete a kept conversation: its turns are gone and its id can no longer be continued. Nothing else changes — no run is stopped (cancel_agent_run stops a background run), and what its runs did to the desktop stands. Delete only a thread this conversation started or one the user asked to remove: every thread on the account is visible to this key, including other people's. It is for removing a prompt that held private text, or making room: the account keeps 1000 threads, replacing the least recently used, and a key that can delete none of them gets runs that are not kept. Needs confirm: true.",
      inputSchema: z
        .object({
          thread_id: threadIdArg,
          confirm: z
            .literal(true)
            .describe('Must be true. The conversation is gone for good and cannot be continued.'),
        })
        .strict(),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ thread_id }, extra) =>
      guarded(async () => {
        const path = P.agentThread(thread_id);
        let res: unknown;
        try {
          res = await session.api.with(extra.signal).send('DELETE', path);
        } catch (err) {
          if (!(err instanceof APIError)) {
            // A request that never left deleted nothing.
            if (neverSent(err)) throw err;
            const why = err instanceof Error ? err.message : String(err);
            return refused(
              `The delete of ${thread_id} could not be read back (${why}). IT MAY OR MAY NOT HAVE BEEN DELETED — get_agent_thread says whether it is still there.`,
            );
          }
          // A 404 is the state this call asked for, and the tool is annotated
          // idempotent, so the retry after a lost answer is one a client may
          // make. Said as a success but not as "Deleted": the same 404 answers
          // an id that was never there.
          if (!(err instanceof NotFoundError)) throw err;
          return said(
            `Nothing was deleted: there is no thread ${thread_id} this key can see. Either it was already deleted — if this is a retry, the first call did it — or the id is wrong. list_agent_threads says which.`,
          );
        }
        if (!z.object({ ok: z.literal(true) }).safeParse(res).success) {
          return refused(
            `The delete of ${thread_id} answered without the platform's acknowledgment. IT MAY OR MAY NOT HAVE BEEN DELETED — get_agent_thread says whether it is still there.`,
          );
        }
        return said(
          `Deleted ${thread_id}: its turns are gone and it can no longer be continued. What its runs did to the desktop stands.`,
          res,
        );
      }).then(out),
  );
};
