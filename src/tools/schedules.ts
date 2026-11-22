import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { APIError, NotFoundError, neverSent } from '../errors.js';
import { failed, guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import { safeResult } from './chat.js';
import { count, label, metadata, metadataCall } from './directory.js';
import { readAnnotations } from './results.js';
import type { Registrar } from './types.js';

// Agent schedules: a cron expression that starts a background agent run on
// one computer at each time it names. Which tools, and why:
//
// - create_agent_schedule and update_agent_schedule: always. Every scheduled
//   run spends the account's AI credits whatever this session pays its own
//   runs with — nothing is there to send a model key when one fires — so how
//   this session pays says nothing about whether the account can; the
//   platform answers that, with a 400 that says so.
// - list_agent_schedules and get_agent_schedule: always, filters permitting.
//   A schedule can be made from anywhere, and reading one needs only the
//   member role.
// - pause_agent_schedule, resume_agent_schedule and delete_agent_schedule:
//   always. Stopping a schedule that is spending credits must not depend on
//   how this session pays; delete takes confirm: true.

const fire = z.object({
  scheduled_for: z.string(),
  fired_at: z.string(),
  outcome: label,
  run_id: z.string().nullable(),
  error: z.string().nullable(),
});

/** One schedule, projected to its public fields. `paused_reason` and a fire's `outcome` stay open strings. */
const agentSchedule = z.object({
  id: z.string().regex(P.SCHEDULE_ID),
  computer_id: label,
  thread_id: z.string().nullable(),
  name: z.string().nullable(),
  cron: z.string(),
  timezone: z.string(),
  prompt: z.string(),
  model: z.string(),
  max_steps: count,
  max_cost_usd: z.number().finite().nonnegative(),
  paused: z.boolean(),
  paused_reason: z.string().nullable(),
  next_fire_at: z.string().nullable(),
  last_fire_at: z.string().nullable(),
  last_run_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  recent_fires: z.array(fire),
});
type AgentSchedule = z.infer<typeof agentSchedule>;

const schedulePage = z.object({ schedules: z.array(agentSchedule), has_more: z.boolean() });

const scheduleIdArg = z
  .string()
  .regex(P.SCHEDULE_ID, 'schedule_id is sch_ followed by 24 lowercase hex characters')
  .describe(
    'The schedule_id create_agent_schedule or list_agent_schedules answered: sch_ and 24 hex characters.',
  );

const PAUSED: Record<string, string> = {
  paused: 'paused on request',
  credential: 'paused because the API key it acts as was deleted or no longer works',
  authority: "paused because its key's holder can no longer start runs on this computer",
  thread_deleted: 'paused because the thread it continued was deleted',
  failing: 'paused after five failed fires in a row',
  never_fires: 'paused because its cron expression matches no time in the next eight years',
};

/** A prompt's first line, short enough for a listing. */
function title(prompt: string): string {
  const first = prompt.split('\n', 1)[0].trim();
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

function state(s: AgentSchedule): string {
  if (!s.paused) return `active; next fire ${s.next_fire_at ?? 'unknown'}`;
  const why = s.paused_reason
    ? (PAUSED[s.paused_reason] ?? `paused (${s.paused_reason})`)
    : 'paused';
  return `${why}; resume_agent_schedule resumes it`;
}

function describe(s: AgentSchedule): string {
  const parts = [
    `${s.id}${s.name ? ` (${s.name})` : ''} on ${s.computer_id}: ${JSON.stringify(s.cron)} in ${s.timezone}, ${state(s)}.`,
    `Each fire starts a background run with model ${s.model}, at most ${s.max_steps} step(s), and no model call starts once it has spent $${s.max_cost_usd} of AI credits (the last one can go over)${s.thread_id ? `, continuing thread ${s.thread_id}` : ', in a new thread'}.`,
    `Prompt: ${JSON.stringify(s.prompt)}`,
  ];
  if (s.recent_fires.length)
    parts.push(
      `Latest fires:\n${s.recent_fires
        .map(
          (f) =>
            `${f.scheduled_for}: ${f.outcome}${f.run_id ? ` — run ${f.run_id} (get_agent_run reads it)` : ''}${f.error ? ` — ${f.error}` : ''}`,
        )
        .join('\n')}`,
    );
  return parts.join('\n');
}

const CRON =
  'Five fields: minute hour day-of-month month day-of-week, each *, a number, a range a-b, a step */n, or a comma list; months and weekdays also take names (JAN, MON). At most one fire every five minutes. Example: "0 9 * * MON-FRI" for 09:00 on weekdays.';

const FIELDS = {
  timezone: z
    .string()
    .min(1)
    .optional()
    .describe(
      'An IANA time zone the cron expression is read in, such as Europe/London. Default UTC.',
    ),
  model: z
    .enum(['claude-sonnet-5-5', 'claude-opus-5-5'])
    .optional()
    .describe('The model each run uses. Default claude-sonnet-5-5.'),
  max_steps: z
    .number()
    .int()
    .min(1)
    .max(P.AGENT_MAX_BACKGROUND_STEPS)
    .optional()
    .describe('The step cap of each run. Default 20.'),
  max_cost_usd: z
    .number()
    .min(0.25)
    .max(20)
    .optional()
    .describe(
      'The AI-credit budget of each run, in USD, 0.25 to 20; default 2. No model call starts past it, but the last one can go over.',
    ),
  name: z.string().max(100).nullable().optional().describe('A label of your choosing.'),
  provider: z
    .enum(['anthropic'])
    .optional()
    .describe('Only anthropic: a schedule runs on AI credits, which are Anthropic models.'),
};

const ABOUT =
  "Every fire starts a background agent run, on the account's AI credits, and acts as the API key this server uses. A fire is skipped while the previous run is still going or the computer is not running (it does not start the computer); one the platform could not send within five minutes of its time is recorded as missed and never sent late; five failed fires in a row pause it. get_agent_schedule shows its latest fires and the run each started.";

export const registerSchedules: Registrar = (server, session) => {
  const out = (result: CallToolResult) => safeResult(result, session.modelKey);
  /**
   * Send a change. One refused with a 4xx, or never sent, changed nothing and
   * is passed on as it is. Any other failure leaves open whether it took
   * effect, and repeating a change moves the next fire again (Codex, round 3),
   * so the read that settles it is named instead of a retry.
   */
  const change = async (
    scheduleId: string,
    body: Record<string, unknown>,
    what: string,
    signal: AbortSignal,
  ): Promise<CallToolResult> => {
    let raw: unknown;
    try {
      raw = await session.api.json('PATCH', P.agentSchedule(scheduleId), { body, signal });
    } catch (err) {
      if ((err instanceof APIError && err.status < 500) || neverSent(err)) throw err;
      const why = err instanceof Error ? err.message : String(err);
      return refused(
        `${what} could not be confirmed (${why}). IT MAY HAVE TAKEN EFFECT: read the schedule with get_agent_schedule (schedule_id ${scheduleId}) before sending it again, since every change sets the next fire from now.`,
      );
    }
    return answered(raw, what);
  };
  const answered = (raw: unknown, what: string): CallToolResult => {
    const parsed = agentSchedule.safeParse(raw);
    if (!parsed.success)
      return refused(
        `${what} was answered, but the answer could not be read: get_agent_schedule reads it as it is. Read it before sending a change again, since a change moves the next fire.`,
      );
    return said(describe(parsed.data), parsed.data);
  };
  server.registerTool(
    'create_agent_schedule',
    {
      title: 'Schedule background agent runs',
      description: `Run the same agent task on a computer on a timetable: at each time a cron expression names, a background agent run starts with this prompt. ${ABOUT} Only make one the user asked for: it spends credits on every fire until it is paused or deleted.`,
      inputSchema: {
        computer_id: z
          .string()
          .min(1)
          .optional()
          .describe('The computer; default the selected one.'),
        cron: z.string().min(1).describe(CRON),
        prompt: z
          .string()
          .min(1)
          .max(64_000)
          .describe('What each run is asked to do, in plain language.'),
        ...FIELDS,
        thread_id: z
          .string()
          .regex(P.THREAD_ID, 'thread_id is thr_ followed by 24 lowercase hex characters')
          .optional()
          .describe(
            "A thread of this computer's for every fire to continue. Leave it out for a new thread each time.",
          ),
        paused: z.boolean().optional().describe('Make it paused.'),
      },
      // Every fire is an agent run free to act on the desktop, as
      // start_agent_run's is (Codex, round 3).
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    ({ computer_id, ...fields }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        // Built before the request, so a path refused here is not mistaken
        // for a create whose answer was lost.
        const path = P.agentSchedules(id);
        // A create is not idempotent: one whose answer was lost, or failed
        // with a 5xx, may have made a schedule that spends credits on every
        // fire, and making another would double it. The read that settles it
        // is named where it is needed.
        const recover = `Do not make another blind: call list_agent_schedules with computer_id ${id} and look for one with this cron expression, time zone and prompt created just now. Another client may have made one there too, so if more than one could be it, or none clearly is, ask the user rather than making another.`;
        let raw: unknown;
        try {
          raw = await session.api.json('POST', path, { body: fields, signal: extra.signal });
        } catch (err) {
          if ((err instanceof APIError && err.status < 500) || neverSent(err)) throw err;
          const result = failed(err);
          result.content.push({
            type: 'text',
            text: `A SCHEDULE MAY HAVE BEEN MADE on ${id}. ${recover}`,
          });
          return result;
        }
        const parsed = agentSchedule.safeParse(raw);
        if (!parsed.success) {
          const made =
            raw !== null &&
            typeof raw === 'object' &&
            typeof (raw as { id?: unknown }).id === 'string' &&
            P.SCHEDULE_ID.test((raw as { id: string }).id)
              ? (raw as { id: string }).id
              : undefined;
          return refused(
            made
              ? `The platform made the schedule on ${id} as ${made}, but the rest of its answer could not be read: read it with get_agent_schedule (schedule_id ${made}) rather than making another.`
              : `The platform answered the create on ${id}, but its answer could not be read, so A SCHEDULE MAY HAVE BEEN MADE. ${recover}`,
          );
        }
        return said(describe(parsed.data), parsed.data);
      }).then(out),
  );

  server.registerTool(
    'update_agent_schedule',
    {
      title: 'Change an agent schedule',
      description: `Change any of a schedule's fields; what is not sent stays. thread_id null makes each fire start a new thread. Its next fire becomes the first time after now, and it acts as this server's API key from then on. A schedule paused for a reason of its own stays paused: resume_agent_schedule resumes it. ${CRON}`,
      inputSchema: {
        schedule_id: scheduleIdArg,
        cron: z.string().min(1).optional().describe(CRON),
        prompt: z.string().min(1).max(64_000).optional().describe('What each run is asked to do.'),
        ...FIELDS,
        thread_id: z
          .string()
          .regex(P.THREAD_ID, 'thread_id is thr_ followed by 24 lowercase hex characters')
          .nullable()
          .optional()
          .describe(
            "A thread of the schedule's computer to continue, or null for a new thread each time.",
          ),
      },
      // Not idempotent: each change sets the next fire from now, so a retry
      // after a fire time can move that fire to the next one (Codex round 2).
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    ({ schedule_id, ...fields }, extra) =>
      guarded(() => change(schedule_id, fields, `The change to ${schedule_id}`, extra.signal)).then(
        out,
      ),
  );

  server.registerTool(
    'list_agent_schedules',
    {
      title: 'List agent schedules',
      description:
        "Agent schedules on this account, newest first, a page at a time: each one's id, computer, cron expression and time zone, whether it is paused and why, and when it next fires. computer_id keeps one computer's. Pass before with the last schedule's id for the next page. get_agent_schedule reads one with its latest fires.",
      inputSchema: {
        computer_id: z
          .string()
          .min(1)
          .optional()
          .describe("Only this computer's schedules. Not defaulted to the selected computer."),
        limit: z.number().int().min(1).max(100).optional().describe('Page size; default 20.'),
        before: z
          .string()
          .regex(
            P.SCHEDULE_ID,
            'before is a schedule_id: sch_ followed by 24 lowercase hex characters',
          )
          .optional()
          .describe('The id of the last schedule on the previous page, for the page after it.'),
      },
      annotations: readAnnotations,
    },
    ({ computer_id, limit, before }, extra) =>
      metadataCall(async () => {
        const page = metadata(
          schedulePage,
          await session.api.json('GET', P.AGENT_SCHEDULES, {
            query: { computer_id, limit, before },
            signal: extra.signal,
          }),
        );
        if (!page.schedules.length) return said('No agent schedules.', page);
        const more = page.has_more && page.schedules.length;
        return said(
          page.schedules
            .map(
              (s) =>
                `${s.id}${s.name ? ` (${s.name})` : ''} on ${s.computer_id}: ${JSON.stringify(s.cron)} in ${s.timezone}, ${state(s)}`,
            )
            .join('\n') +
            (more
              ? `\n\nMore: pass before=${page.schedules[page.schedules.length - 1].id} for the next page.`
              : ''),
          // Summaries only, as list_agent_runs gives: a prompt may be 64,000
          // characters, and twenty of them whole would swamp a client's
          // context. get_agent_schedule reads one whole.
          {
            schedules: page.schedules.map(({ recent_fires: _fires, prompt, ...rest }) => ({
              ...rest,
              prompt: title(prompt),
            })),
            has_more: page.has_more,
          },
        );
      }).then(out),
  );

  server.registerTool(
    'get_agent_schedule',
    {
      title: 'Read an agent schedule',
      description:
        'One agent schedule: its cron expression and time zone, prompt, whether it is paused and why, when it next fires, and its 20 latest fires with the run each started (get_agent_run reads a run). A schedule this key cannot see is not found.',
      inputSchema: { schedule_id: scheduleIdArg },
      annotations: readAnnotations,
    },
    ({ schedule_id }, extra) =>
      metadataCall(async () => {
        const s = metadata(
          agentSchedule,
          await session.api.json('GET', P.agentSchedule(schedule_id), { signal: extra.signal }),
        );
        return said(describe(s), s);
      }).then(out),
  );

  for (const [tool, paused] of [
    ['pause_agent_schedule', true],
    ['resume_agent_schedule', false],
  ] as const) {
    server.registerTool(
      tool,
      {
        title: paused ? 'Pause an agent schedule' : 'Resume an agent schedule',
        description: paused
          ? 'Pause a schedule: it starts no more runs until resumed. A run it already started goes on; cancel_agent_run stops one.'
          : "Resume a schedule, whatever paused it; its next fire is the first time after now, and it acts as this server's API key from then on. Its runs spend the account's AI credits, which must be available.",
        inputSchema: { schedule_id: scheduleIdArg },
        // A pause repeats harmlessly; a resume sets the next fire from now.
        // A resume lets its runs act on the desktop again; a pause stops them.
        annotations: { readOnlyHint: false, destructiveHint: !paused, idempotentHint: paused },
      },
      ({ schedule_id }, extra) =>
        guarded(() =>
          change(
            schedule_id,
            { paused },
            `The ${paused ? 'pause' : 'resume'} of ${schedule_id}`,
            extra.signal,
          ),
        ).then(out),
    );
  }

  server.registerTool(
    'delete_agent_schedule',
    {
      title: 'Delete an agent schedule',
      description:
        'Delete a schedule: it starts no more runs. Runs it already started are untouched (cancel_agent_run stops one). Delete only a schedule this conversation made or one the user asked to remove. Needs confirm: true.',
      inputSchema: z.strictObject({
        schedule_id: scheduleIdArg,
        confirm: z.literal(true).describe('Must be true. The schedule is gone for good.'),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ schedule_id }, extra) =>
      guarded(async () => {
        const path = P.agentSchedule(schedule_id);
        let res: unknown;
        try {
          res = await session.api.with(extra.signal).send('DELETE', path);
        } catch (err) {
          if (!(err instanceof APIError)) {
            if (neverSent(err)) throw err;
            const why = err instanceof Error ? err.message : String(err);
            return refused(
              `The delete of ${schedule_id} could not be read back (${why}). IT MAY OR MAY NOT HAVE BEEN DELETED — get_agent_schedule says whether it is still there.`,
            );
          }
          if (!(err instanceof NotFoundError)) throw err;
          // Not a confirmed deletion (Codex, round 4): the platform answers the
          // same 404 for a schedule this key cannot see — one in another
          // workspace, or on a computer whose workspace is changing — and that
          // one still fires.
          return refused(
            `Nothing was deleted, and whether ${schedule_id} is gone is not known: this key can see no schedule with that id. It may already have been deleted, the id may be wrong, or it may be one this key cannot reach (another workspace, or a computer changing workspace) and still firing. An account-wide key, or the dashboard, can say which.`,
          );
        }
        if (!z.object({ ok: z.literal(true) }).safeParse(res).success)
          return refused(
            `The delete of ${schedule_id} answered without the platform's acknowledgment. IT MAY OR MAY NOT HAVE BEEN DELETED — get_agent_schedule says whether it is still there.`,
          );
        return said(
          `Deleted ${schedule_id}: it starts no more runs. Runs it already started are untouched.`,
          res,
        );
      }).then(out),
  );
};
