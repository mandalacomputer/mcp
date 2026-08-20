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
        'Give the computer a task in plain language and let the platform drive it — screenshot, decide, click, type, repeat — until it is done. Runs on the Anthropic key this server was configured with, and bills that key for every step. Use it to delegate a long stretch of pixel work; drive with the individual tools when you want to see each frame yourself. The computer must already be running.',
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

        for await (const ev of session.api.sse('POST', P.computerAction(id, 'agent'), {
          body: P.agentBody({ prompt, system, max_steps, stream: true }),
          headers: { [MODEL_KEY_HEADER]: session.modelKey as string },
          signal: extra.signal,
        })) {
          if (ev.event === 'step') {
            const s = ev.data as { n?: number; action?: string; detail?: string };
            steps.push(`${s.n ?? steps.length + 1}. ${s.detail ?? s.action ?? 'step'}`);
            // Told, not just collected. A run is minutes of clicking, and a tool
            // that says nothing until it is over is one nobody watching can tell
            // from a hang.
            await server.server
              .sendLoggingMessage({ level: 'info', data: steps[steps.length - 1] })
              .catch(() => {});
          } else if (ev.event === 'done') {
            done = ev.data as Record<string, unknown>;
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
        const result = `${verdict}\n\n${String(done.text ?? '')}\n\nWhat it did:\n${steps.join('\n')}`;
        return stop === 'end_turn' ? said(result, done) : refused(result, done);
      }),
  );
};
