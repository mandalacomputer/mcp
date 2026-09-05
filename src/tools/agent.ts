import { z } from 'zod';
import { MODEL_KEY_HEADER } from '../api.js';
import { guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

/**
 * The platform's own agent loop, as one tool.
 *
 * Registered only when a model key is configured, and that is the point of the
 * conditional: a tool a model can see is a tool it will try, and one that fails
 * on every call with "no model key" costs a turn to discover. Absent is a
 * clearer answer than present-and-broken.
 *
 * Worth having even though the caller is already a model with eyes. The outer
 * agent pays for every screenshot in context; this route runs the pixel-level
 * loop inside the platform on the caller's own Anthropic key and hands back a
 * sentence. Ten clicks stop being ten images.
 */
export const registerAgent: Registrar = (server, session) => {
  if (!session.modelKey) return;

  server.registerTool(
    'run_agent',
    {
      title: 'Have the platform drive the computer',
      description:
        'Give the computer a task in plain language and let the platform drive it — screenshot, decide, click, type, repeat — until it is done. Runs on the Anthropic key this server was configured with, and bills that key for every step. Use it to delegate a long stretch of pixel work; drive with the individual tools when you want to see each frame yourself. The computer must already be running. A run is MINUTES, not seconds: it reports progress on every step so a client that sends a progressToken and sets resetTimeoutOnProgress can hold the request open, and a client that cannot should lower max_steps rather than watch its own default timeout cancel a run it is already paying for.',
      inputSchema: {
        computer_id: z
          .string()
          .optional()
          .describe('Which computer. Defaults to the one selected with use_computer.'),
        prompt: z.string().describe('The task, in plain language.'),
        system: z.string().optional().describe('Standing instructions carried into the run.'),
        max_steps: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe(
            'Each step is a model call plus a screenshot on your key, so this is a spending cap as much as a loop bound.',
          ),
      },
      annotations: { openWorldHint: true },
    },
    ({ computer_id, prompt, system, max_steps }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const steps: string[] = [];
        let done: Record<string, unknown> | undefined;
        // The token the CLIENT sends when it wants progress, exactly as
        // watch_build reads it. Without one there is nothing to address a
        // progress notification to, and this falls back to logging alone.
        const progressToken = extra._meta?.progressToken;

        for await (const ev of session.api.sse('POST', P.computerAction(id, 'agent'), {
          body: P.agentBody({ prompt, system, max_steps, stream: true }),
          headers: { [MODEL_KEY_HEADER]: session.modelKey as string },
          signal: extra.signal,
        })) {
          if (ev.event === 'step') {
            if (!isRecord(ev.data)) continue;
            const s = ev.data as { n?: number; action?: string; detail?: string };
            steps.push(`${s.n ?? steps.length + 1}. ${s.detail ?? s.action ?? 'step'}`);
            // A PROGRESS notification, not only a logging one, for the reason
            // watch_build sends one: `_onprogress` in the SDK's
            // shared/protocol.js resets a pending request's timer, and
            // `notifications/message` — what sendLoggingMessage emits — never
            // touches it. This tool had only the logging half, so a run of the
            // default 20 steps, each a model call plus a screenshot, sailed past
            // the client's 60s default and was cancelled while the platform went
            // on driving the desktop on the caller's own Anthropic key.
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
            await server.server
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
            // in its lib/agent.ts requires it, and every `done` it yields carries
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
            return refused(`The run failed after ${steps.length} step(s).`, ev.data);
          }
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
              : stop === 'refusal'
                ? 'the model declined the task'
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
        const result = `${verdict}\n\n${text}\n\nWhat it did:\n${steps.join('\n')}`;
        return stop === 'end_turn' ? said(result, done) : refused(result, done);
      }),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
