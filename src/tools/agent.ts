import { z } from 'zod';
import { MODEL_KEY_HEADER } from '../api.js';
import { topUpUrl } from '../credits.js';
import {
  APIError,
  agentRunAdvice,
  authenticationAdvice,
  creditsExhaustedAdvice,
  FUNDED_UNAVAILABLE,
  fundedUnavailableAdvice,
  platformSaid,
} from '../errors.js';
import { errorMetadata, failed, guarded, refused, said, withErrorMetadata } from '../format.js';
import * as P from '../paths.js';
import type { ProgressExtra } from '../poll.js';
import type { Session } from '../session.js';
import { safeResult } from './chat.js';
import type { Registrar } from './types.js';

/** run_agent's annotations, shared with the check that decides whether to ask about credits. */
export const RUN_AGENT_ANNOTATIONS = { openWorldHint: true } as const;

const TITLE = 'Have the platform drive the computer';

/** What both descriptions say after their first sentence about who pays. */
const HOW =
  'Use it to delegate a long stretch of pixel work; drive with the individual tools when you want to see each frame yourself. The computer must already be running. A run is MINUTES, not seconds: it reports progress on every step so a client that sends a progressToken and sets resetTimeoutOnProgress can hold the request open, and a client that cannot should lower max_steps rather than watch its own default timeout cancel a run it is already paying for.';

const TASK =
  'Give the computer a task in plain language and let the platform drive it — screenshot, decide, click, type, repeat — until it is done.';

const computerId = z
  .string()
  .optional()
  .describe('Which computer. Defaults to the one selected with use_computer.');
const prompt = z.string().describe('The task, in plain language.');
const nonblankModel = z.string().refine((v) => v.trim().length > 0, 'model must not be blank');
const STEPS_CAP = `Defaults to 20 and is capped at ${P.AGENT_MAX_STEPS} here, so a larger value is refused before the call rather than after it.`;
/** How many actions, told the way each payer needs it told. */
const maxSteps = (bill: string, bound: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(P.AGENT_MAX_STEPS)
    .default(20)
    .describe(
      `How many ACTIONS the loop may take on the desktop. Not a count of model calls and not a proxy for ${bill}: one model reply can ask for several actions and spends a step on each, a paused turn is resubmitted for tokens and no step, and a bash call or a cursor read takes no screenshot. So a run can make more model calls than steps AND more steps than screenshots — bound the work with this, and ${bound}. ${STEPS_CAP}`,
    );

type RunArgs = {
  computer_id?: string;
  prompt: string;
  system?: string;
  provider?: 'anthropic' | 'openai';
  model?: string;
  max_steps: number;
  max_cost_usd?: number;
};
type RunExtra = ProgressExtra & { signal: AbortSignal };

/**
 * The platform's own agent loop, as one tool.
 *
 * Registered only when something can pay for it, and that is the point of the
 * conditional: a tool a model can see is a tool it will try, and one that fails
 * on every call with "no model key" costs a turn to discover. Absent is a
 * clearer answer than present-and-broken. Two things can pay. A configured
 * model key is the caller's own, and always wins. Without one, the account's
 * Mandala AI credits pay, when `GET /credits` said at the session's start that
 * they could (OPL-5866); then the tool takes `max_cost_usd`, and loses `system`
 * and `provider`, which a run on credits is refused.
 *
 * Worth having even though the caller is already a model with eyes. The outer
 * agent pays for every screenshot in context; this route runs the pixel-level
 * loop inside the platform and hands back a sentence. Ten clicks stop being ten
 * images.
 */
export const registerAgent: Registrar = (server, session) => {
  const run = (args: RunArgs, extra: RunExtra) =>
    runAgent(server.server, session, args, extra).then((result) =>
      safeResult(result, session.modelKey),
    );

  if (session.modelKey) {
    server.registerTool(
      'run_agent',
      {
        title: TITLE,
        description: `${TASK} Runs on the Anthropic or OpenAI key this server was configured with, and bills that key for every step. ${HOW}`,
        inputSchema: {
          computer_id: computerId,
          prompt,
          system: z.string().optional().describe('Standing instructions carried into the run.'),
          provider: z
            .enum(['anthropic', 'openai'])
            .optional()
            .describe(
              'Inferred from model when omitted. Select openai to use gpt-6.1-sol by default. The configured MANDALA_MODEL_KEY must match the provider.',
            ),
          model: nonblankModel
            .optional()
            .describe(
              'A computer-capable Anthropic or OpenAI model id to run with. Omit it for the one the platform picks. The configured key must be able to use it; a model it cannot use fails the run.',
            ),
          max_steps: maxSteps('what your key is billed', 'budget the bill on the key itself'),
        },
        annotations: RUN_AGENT_ANNOTATIONS,
      },
      run,
    );
    return;
  }
  if (!session.funded) return;

  server.registerTool(
    'run_agent',
    {
      title: TITLE,
      description: `${TASK} Runs on this account's Mandala AI credits, because no model key is configured: each model call reserves $0.25 and is charged for its usage, max_cost_usd caps what one run may start, and get_credits reads the balance. ${HOW}`,
      inputSchema: {
        computer_id: computerId,
        prompt,
        model: nonblankModel
          .optional()
          .describe(
            'claude-sonnet-5-5, the default, or claude-opus-5-5; credits pay for these two. Another model needs a model key.',
          ),
        max_steps: maxSteps('what a run costs', 'the spend with max_cost_usd'),
        max_cost_usd: z
          .number()
          .min(0.25)
          .max(20)
          .optional()
          .describe(
            'The most this run may spend from credits, in USD, 0.25 to 20; the platform defaults to 2. No model call starts past it, but the last one can go over. A run that reaches it ends with stop max_cost.',
          ),
      },
      annotations: RUN_AGENT_ANNOTATIONS,
    },
    run,
  );
};

/** One run, BYOK or funded: `session.modelKey` decides which. */
function runAgent(
  log: { sendLoggingMessage: (p: { level: 'info'; data: string }) => Promise<void> },
  session: Session,
  { computer_id, prompt, system, model, provider, max_steps, max_cost_usd }: RunArgs,
  extra: RunExtra,
) {
  return guarded(async () => {
    const id = session.resolve(computer_id);
    const steps: string[] = [];
    let done: Record<string, unknown> | undefined;
    // The newest balance a step reported. The `done` frame carries the run's
    // cost but not this, and a model told what a run cost wants to know what
    // is left as well.
    let remaining: number | undefined;
    // The token the CLIENT sends when it wants progress, exactly as
    // watch_build reads it. Without one there is nothing to address a
    // progress notification to, and this falls back to logging alone.
    const progressToken = extra._meta?.progressToken;

    try {
      for await (const ev of session.api.sse('POST', P.computerAction(id, 'agent'), {
        body: P.agentBody({
          prompt,
          system,
          model,
          provider,
          max_steps,
          max_cost_usd,
          stream: true,
        }),
        // No header at all on a run that credits pay for: its absence is what
        // tells the platform to use them.
        ...(session.modelKey ? { headers: { [MODEL_KEY_HEADER]: session.modelKey } } : {}),
        signal: extra.signal,
      })) {
        if (ev.event === 'step') {
          if (!isRecord(ev.data)) continue;
          const s = ev.data as { n?: number; action?: string; detail?: string };
          if (finite(ev.data.credits_remaining_usd)) remaining = ev.data.credits_remaining_usd;
          steps.push(`${s.n ?? steps.length + 1}. ${s.detail ?? s.action ?? 'step'}`);
          // A PROGRESS notification, not only a logging one, for the reason
          // watch_build sends one: `_onprogress` in the SDK's
          // shared/protocol.js resets a pending request's timer, and
          // `notifications/message` — what sendLoggingMessage emits — never
          // touches it. This tool had only the logging half, so a run of the
          // default 20 steps, most of them a model call and a screenshot, sailed past
          // the client's 60s default and was cancelled while the platform went
          // on driving the desktop on the caller's own model-provider key.
          //
          // Not sufficient on its own, and the same caveat applies here as
          // there: protocol.js reads `options?.resetTimeoutOnProgress ?? false`,
          // so a client that mints a token and leaves that option alone is
          // still cancelled. What this does is make the keepalive AVAILABLE.
          // The description says so, and max_steps is the lever for a client
          // that cannot opt in.
          if (progressToken !== undefined) {
            await extra
              .sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  // The step COUNT, which the SDK's ProgressSchema asks to
                  // increase every time. `max_steps` is a real total here —
                  // unlike a build's step count it is known before the first
                  // step and cannot change — so the bar means something.
                  progress: steps.length,
                  total: max_steps,
                  message: steps[steps.length - 1],
                },
              })
              .catch(() => {});
          }
          // Told, not just collected. A run is minutes of clicking, and a tool
          // that says nothing until it is over is one nobody watching can tell
          // from a hang.
          await log
            .sendLoggingMessage({ level: 'info', data: steps[steps.length - 1] })
            .catch(() => {});
        } else if (ev.event === 'done') {
          // Stop at the terminal frame rather than waiting for EOF, as
          // watch_build does. Waiting held a result that was already in hand
          // until the generator ended, so a client that aborted in that window
          // — or a stream the platform left open — turned a finished run into
          // a CancelledError and threw the answer away.
          //
          // Terminal means it SAYS SO, which is watch_build's discipline
          // (OPL-3835) applied to this stream's own vocabulary: `stop` is the
          // field the platform always sends on a result — the AgentResult type
          // on the platform side requires it, and every `done` it yields carries
          // one — and it is the field the verdict below reads. A record
          // without it is not a result, so it is kept, in case nothing better
          // arrives, but it does not end the loop and discard the frame that
          // would have been the real one. A `done` that is not a record at all
          // is skipped entirely: the null-done case the regression suite pins.
          if (isRecord(ev.data)) {
            done = ev.data;
            if (typeof ev.data.stop === 'string' && ev.data.stop) break;
          }
        } else if (ev.event === 'error') {
          // A run that errored is a failure, and has to carry `isError` to
          // say so. Prose alone leaves it indistinguishable at the protocol
          // level from a run that worked — a caller checking whether the step
          // succeeded would read this one as a success that happened to have
          // a discouraging sentence in it.
          //
          // And it has to say WHY in words, because this is the one place a
          // status cannot be read off the response: the platform answered 200
          // before the first step, so a run stopped by the credential, the role
          // or the model provider arrives as a frame in a successful stream. A model
          // handed "the run failed" and a JSON blob does the natural thing,
          // which is to call this tool again with the same prompt — paying for
          // every completed step a second time to be refused the same way.
          const frame = isRecord(ev.data) ? ev.data : {};
          const diagnostic = new APIError(
            '',
            typeof frame.status === 'number' ? frame.status : 0,
            frame,
          );
          const spent = spending(frame.cost_usd, remaining);
          const topUp = topUpUrl(frame.status, frame, session.api.baseUrl);
          return withErrorMetadata(
            refused(
              `The run failed after ${steps.length} step(s).${stopReason(ev.data, topUp, session.funded)}` +
                (spent.line ? `\n\n${spent.line}` : '') +
                (steps.length ? `\n\nWhat it did, and is billed for:\n${steps.join('\n')}` : ''),
              {
                error: platformSaid(frame),
                status: errorMetadata({ status: frame.status }).fields.status,
                ...(topUp ? { code: INSUFFICIENT_CREDITS, top_up_url: topUp } : {}),
                ...spent.fields,
                steps: frame.steps,
                usage: frame.usage,
              },
            ),
            {
              status: frame.status,
              reason: diagnostic.reason,
              request_id: diagnostic.requestId,
            },
          );
        }
      }
    } catch (err) {
      // Refused before the stream opened. Two refusals are worded here rather
      // than by the shared advice: a run on credits the account cannot cover
      // (a 402 naming a top-up page, which that advice would call a plan
      // limit), and a run on credits the platform's AI service cannot serve
      // (which it would call a change that may or may not have happened).
      if (!(err instanceof APIError)) throw err;
      const topUp = topUpUrl(err.status, err.body, session.api.baseUrl);
      if (topUp) {
        const result = failed(err, true, creditsExhaustedAdvice(topUp, 'run_agent'));
        result.content.push(
          ...said('Refusal metadata:', { code: INSUFFICIENT_CREDITS, top_up_url: topUp }).content,
        );
        return result;
      }
      if (fundedOutage(session.funded, err.status, err.body))
        return failed(err, true, fundedUnavailableAdvice('run_agent'));
      throw err;
    }

    if (!done) {
      return refused(
        `The stream ended without a result after ${steps.length} step(s). What it did:\n${steps.join('\n')}`,
      );
    }
    // `stop` is the field that matters and the one a caller most easily
    // ignores: a run that hit max_steps ended without finishing, and
    // treating every ending as success reports a failure as a result.
    const stop = String(done.stop ?? 'unknown');
    const verdict =
      stop === 'end_turn'
        ? 'finished'
        : stop === 'max_steps'
          ? `RAN OUT OF STEPS after ${done.steps ?? max_steps} — the task is probably unfinished`
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
                      : `ended: ${stop}`;
    // Interpolated only when it IS a string, which is the same discipline
    // `stop` gets three lines up. `String()` over a shape this build does
    // not know — a content-block array is the plausible one — renders the
    // run's whole output as `[object Object]` in the sentence that carries
    // it, and a model reading that has lost the result while being told it
    // finished. Serialized instead: unfamiliar but readable beats confident
    // and empty.
    const text =
      typeof done.text === 'string'
        ? done.text
        : done.text === undefined || done.text === null
          ? ''
          : JSON.stringify(done.text);
    const spent = spending(done.cost_usd, remaining);
    const result =
      `${verdict}\n\n${text}` +
      (spent.line ? `\n\n${spent.line}` : '') +
      `\n\nWhat it did:\n${steps.join('\n')}`;
    // The cost fields as read above, not as sent: a value that is not a
    // finite number (or a negative charge) is left out rather than repeated.
    const { cost_usd: _cost, credits_remaining_usd: _left, ...rest } = done;
    const record = { ...rest, ...spent.fields };
    return stop === 'end_turn' ? said(result, record) : refused(result, record);
  });
}

/**
 * What a run on credits cost, and what the account has left, as a sentence and
 * as fields — or nothing, on a run a model key paid for, which reports neither.
 *
 * `cost_usd` is the run's cumulative charge, from its last frame.
 * `credits_remaining_usd` is the balance the newest step reported, and can be
 * negative after a call overran what was left; the platform leaves it out when
 * it could not read the balance, and so does this.
 */
function spending(
  cost: unknown,
  remaining: number | undefined,
): { line?: string; fields: { cost_usd?: number; credits_remaining_usd?: number } } {
  const fields: { cost_usd?: number; credits_remaining_usd?: number } = {};
  // A charge is never negative; a balance can be, after a call overran it.
  if (finite(cost) && cost >= 0) fields.cost_usd = cost;
  if (remaining !== undefined) fields.credits_remaining_usd = remaining;
  if (fields.cost_usd === undefined && remaining === undefined) return { fields };
  const parts = [
    ...(fields.cost_usd !== undefined ? [`${usd(fields.cost_usd)} of AI credits spent`] : []),
    ...(remaining !== undefined ? [`${usd(remaining)} left on the account`] : []),
  ];
  return { line: `Cost: ${parts.join('; ')}.`, fields };
}

/** Dollars to the cent, or to a hundredth of a cent when a cent would read as nothing. */
const usd = (value: number): string => {
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(digits)}`;
};

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** The code the SDKs give a run on credits the account cannot cover. */
const INSUFFICIENT_CREDITS = 'insufficient_credits';

/**
 * Whether a run on credits failed in the platform's AI service rather than in
 * the way its status usually means: the platform's fixed sentence for that, at
 * any status, or any other 402 — no plan limit refuses inside a run, and there
 * is no key of the caller's for a provider to bill. Asked only after a 402
 * naming a top-up page has been ruled out. Never on a run a model key paid
 * for, whose statuses keep their own readings.
 */
function fundedOutage(funded: boolean, status: unknown, body: unknown): boolean {
  if (!funded) return false;
  // A 402 whatever its body, which need not be JSON at all.
  return status === 402 || (isRecord(body) && body.error === FUNDED_UNAVAILABLE);
}

/**
 * What an `error` frame says about whether calling this tool again can work.
 *
 * Two kinds of stop are about the CALLER rather than the computer, and both
 * answer a second run the same way after it has paid for its steps again. The
 * platform's own authority re-check is a 401 or 403 carrying `reason:
 * 'revoked'`; the 401 gets the credential sentence, and the 403 says the account
 * no longer permits the run. A 402 naming a top-up page is the account's AI
 * credits run out (OPL-5866). On a run credits paid for, the platform reports
 * its provider's failures in its own fixed words over the provider's status,
 * and those are the platform's AI service failing, whatever the status (see
 * {@link fundedOutage}). Everything else with a status here is the model
 * provider's, relayed for the configured model key — a 402 without that page is
 * its billing error, not the Mandala plan (OPL-5437) — and {@link agentRunAdvice}
 * words those.
 *
 * Anything else is left as the platform's own sentence. A run can fail for
 * reasons that are worth another attempt, and inventing a verdict for a status
 * this version has not been told about would be the same mistake in the other
 * direction: the leading space is part of the returned clause so that an
 * unclassified stop reads as one sentence rather than as a missing one.
 */
function stopReason(data: unknown, topUp: string | undefined, funded: boolean): string {
  const frame = isRecord(data) ? data : undefined;
  const status = typeof frame?.status === 'number' ? frame.status : undefined;
  const said = platformSaid(frame);
  const why = said ? ` ${said}` : '';
  const reason = new APIError('', status ?? 0, frame).reason;
  // Before either credential reading: on a run credits paid for, a 401 the
  // platform reports in its own AI-service words is its provider refusing
  // Mandala's key, not the caller's credential.
  if (!topUp && fundedOutage(funded, status, frame))
    return ` HTTP ${status}: ${fundedUnavailableAdvice('run_agent')}.${why}`;
  // 401 and 403 are split, because the recovery is not the same one. A shared
  // clause told a caller whose ROLE had been taken away to re-authenticate,
  // which restores nothing and sends it round the same refusal with another
  // prompt's worth of billed steps behind it (Codex review).
  if (status === 401) {
    return (
      ` HTTP ${status}: ${authenticationAdvice(reason)}.${why} Do NOT call run_agent again with the same` +
      ` prompt. Read what the steps below already did before deciding what is left to do.`
    );
  }
  const advice = agentRunAdvice(status, reason, 'run_agent', topUp);
  return advice ? ` HTTP ${status}: ${advice}.${why}` : why;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
