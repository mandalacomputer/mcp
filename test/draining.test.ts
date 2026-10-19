/**
 * A start refused while the platform updates (OPL-6094): a 503 with
 * `reason: "draining"` and a `Retry-After`, answered before any run starts on
 * the three calls that start one. Nothing started and nothing was billed, so
 * every tool that starts a run says so and gives the wait, where any other 5xx
 * keeps saying the outcome is unknown.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APIError,
  errorForStatus,
  isTransient,
  isTransientForPoll,
  outcomeUnknownOn503,
  pausedForUpdate,
  pausedForUpdateAdvice,
  reasonKind,
} from '../src/errors.js';
import { failed } from '../src/format.js';
import { connect, installFakePlatform } from './harness.js';

let platform: ReturnType<typeof installFakePlatform>;
let recording: typeof fetch;
const connections: Awaited<ReturnType<typeof connect>>[] = [];
async function open(cfg: Parameters<typeof connect>[0] = {}) {
  const connection = await connect(cfg);
  connections.push(connection);
  return connection;
}
beforeEach(() => {
  platform = installFakePlatform();
  recording = globalThis.fetch;
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()));
  platform.restore();
});

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** The platform's refusal, as it sends it. */
const DRAINING = {
  error:
    'New agent runs are paused for a few minutes while the platform updates; runs already going are not affected. Send the same request again after the Retry-After wait.',
  reason: 'draining',
};

/**
 * Answer every request that starts a run with this status, body and headers,
 * recording it; anything else goes to the fake platform as usual.
 */
function startsAnswer(status: number, body: unknown, headers: Record<string, string> = {}) {
  let starts = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const url = new URL(String(args[0] instanceof Request ? args[0].url : args[0]));
    const starting =
      url.pathname.endsWith('/agent') ||
      url.pathname.endsWith('/agent/runs') ||
      url.pathname.endsWith('/chat/completions');
    if (!starting) return recording(...args);
    starts += 1;
    await recording(...args);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return () => starts;
}

const NOTHING = 'NOTHING STARTED AND NOTHING WAS BILLED';

describe('a start refused while the platform updates', () => {
  it('run_agent says nothing started or was billed, and when to send it again', async () => {
    const starts = startsAnswer(503, DRAINING, { 'Retry-After': '30' });
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('run_agent', { prompt: 'open firefox' });
    expect(res.isError).toBe(true);
    const said = textOf(res);
    expect(said).toContain('the platform is updating');
    expect(said).toContain(NOTHING);
    expect(said).toContain('Call run_agent again with the same arguments after 30 seconds');
    expect(said).not.toContain('MAY OR MAY NOT HAVE HAPPENED');
    expect(said).toContain('"reason": "draining"');
    expect(said).toContain('"retry_after_ms": 30000');
    // Told, not done: this server sends the start once and leaves the resend
    // to the caller.
    expect(starts()).toBe(1);
  });

  it('run_agent on AI credits says the same, not that the AI service failed', async () => {
    startsAnswer(503, DRAINING, { 'Retry-After': '30' });
    const { call } = await open({ funded: true });
    const said = textOf(await call('run_agent', { prompt: 'open firefox' }));
    expect(said).toContain(NOTHING);
    expect(said).toContain('after 30 seconds');
    expect(said).not.toContain('AI service could not serve');
    expect(said).not.toContain('MAY OR MAY NOT HAVE HAPPENED');
  });

  it('start_agent_run says no run started, rather than that one may have', async () => {
    const starts = startsAnswer(503, DRAINING, { 'Retry-After': '30' });
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('start_agent_run', { computer_id: 'vm-3', prompt: 'go' });
    expect(res.isError).toBe(true);
    const said = textOf(res);
    expect(said).toContain(NOTHING);
    expect(said).toContain('Call start_agent_run again with the same arguments after 30 seconds');
    expect(said).not.toContain('MAY HAVE STARTED');
    expect(said).not.toContain('list_agent_runs with computer_id');
    expect(said).not.toContain('MAY OR MAY NOT HAVE HAPPENED');
    expect(starts()).toBe(1);
  });

  it('start_agent_run on AI credits says the same', async () => {
    startsAnswer(503, DRAINING, { 'Retry-After': '30' });
    const { call } = await open({ funded: true });
    const said = textOf(await call('start_agent_run', { prompt: 'go' }));
    expect(said).toContain(NOTHING);
    expect(said).not.toContain('MAY HAVE STARTED');
    expect(said).not.toContain('AI service could not serve');
  });

  it('run_agent_chat says nothing was billed, not that recorded work may be', async () => {
    const starts = startsAnswer(503, DRAINING, { 'Retry-After': '30' });
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('run_agent_chat', {
      messages: [{ role: 'user', content: 'open firefox' }],
    });
    expect(res.isError).toBe(true);
    const said = textOf(res);
    expect(said).toContain(NOTHING);
    expect(said).toContain('Call run_agent_chat again with the same arguments after 30 seconds');
    expect(said).not.toContain('may already be billed');
    expect(said).not.toContain('MAY OR MAY NOT HAVE HAPPENED');
    expect(said).toContain('"retry_after_ms": 30000');
    expect(starts()).toBe(1);
  });

  it('gives the wait it was given, and says so when it was given none', async () => {
    startsAnswer(503, DRAINING, { 'Retry-After': '1' });
    const { call } = await open({ modelKey: 'sk-ant-test' });
    expect(textOf(await call('run_agent', { prompt: 'go' }))).toContain('after 1 second,');
    startsAnswer(503, DRAINING);
    const unnamed = textOf(await call('start_agent_run', { prompt: 'go' }));
    expect(unnamed).toContain(NOTHING);
    expect(unnamed).toContain('after a short wait (the answer did not say how long)');
  });
});

describe('every other 5xx keeps its unknown outcome', () => {
  it('run_agent: a 503 with no word, or another word, may or may not have happened', async () => {
    const { call } = await open({ modelKey: 'sk-ant-test' });
    for (const body of [
      { error: 'a host could not be reached' },
      { error: 'a host could not be reached', reason: 'contention' },
    ]) {
      startsAnswer(503, body, { 'Retry-After': '30' });
      const said = textOf(await call('run_agent', { prompt: 'go' }));
      expect(said).toContain('MAY OR MAY NOT HAVE HAPPENED');
      expect(said).not.toContain(NOTHING);
    }
  });

  it('run_agent: the word on any status but 503 is not the update refusal', async () => {
    const { call } = await open({ modelKey: 'sk-ant-test' });
    for (const status of [500, 502, 504]) {
      startsAnswer(status, DRAINING, { 'Retry-After': '30' });
      const said = textOf(await call('run_agent', { prompt: 'go' }));
      expect(said).not.toContain(NOTHING);
      expect(said).not.toContain('the platform is updating');
    }
  });

  it('start_agent_run: any other 5xx may have started a run', async () => {
    const { call } = await open({ modelKey: 'sk-ant-test' });
    for (const [status, body] of [
      [503, { error: 'the control plane could not be reached' }],
      [503, { error: { message: 'x', reason: 'draining' } }],
      [500, DRAINING],
    ] as const) {
      startsAnswer(status, body);
      const said = textOf(await call('start_agent_run', { computer_id: 'vm-3', prompt: 'go' }));
      expect(said).toContain('A RUN MAY HAVE STARTED on vm-3');
      expect(said).not.toContain(NOTHING);
    }
  });

  it('run_agent_chat: a run failure in the nested envelope is not the update refusal', async () => {
    // The chat route's own 503 is a run that failed, relayed in OpenAI's
    // envelope; a word nested in it says nothing about whether steps ran.
    startsAnswer(
      503,
      {
        error: {
          message: 'the host could not be reached',
          reason: 'draining',
          steps: [{ n: 1, detail: 'clicked once' }],
        },
      },
      { 'Retry-After': '30' },
    );
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const said = textOf(
      await call('run_agent_chat', { messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(said).toContain('may already be billed');
    expect(said).toContain('clicked once');
    expect(said).not.toContain(NOTHING);
  });

  it('every tool: the word beside a record of work never says nothing started', async () => {
    const mixed = {
      ...DRAINING,
      error: {
        message: 'the host could not be reached',
        steps: [{ n: 1, detail: 'clicked once' }],
      },
      thread_id: 'thr_0123456789abcdef01234567',
    };
    const { call } = await open({ modelKey: 'sk-ant-test' });
    startsAnswer(503, mixed, { 'Retry-After': '30' });
    const agent = textOf(await call('run_agent', { prompt: 'go' }));
    expect(agent).toContain('MAY OR MAY NOT HAVE HAPPENED');
    expect(agent).not.toContain(NOTHING);
    const start = textOf(await call('start_agent_run', { computer_id: 'vm-3', prompt: 'go' }));
    expect(start).toContain('A RUN MAY HAVE STARTED on vm-3');
    expect(start).not.toContain(NOTHING);
    const chat = textOf(
      await call('run_agent_chat', { messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(chat).toContain('may already be billed');
    expect(chat).toContain('clicked once');
    expect(chat).not.toContain(NOTHING);
    startsAnswer(503, { ...DRAINING, steps: [{ n: 1, detail: 'clicked twice' }] });
    const flat = textOf(
      await call('run_agent_chat', { messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(flat).toContain('may already be billed');
    expect(flat).toContain('clicked twice');
    expect(flat).not.toContain(NOTHING);
  });

  it('run_agent_chat: a flat 503 without the word keeps its billing warning', async () => {
    startsAnswer(503, { error: 'the host could not be reached' });
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const said = textOf(
      await call('run_agent_chat', { messages: [{ role: 'user', content: 'go' }] }),
    );
    expect(said).toContain('may already be billed');
    expect(said).not.toContain(NOTHING);
  });
});

describe('the classification under the wording', () => {
  const post = (body: unknown, status = 503) =>
    errorForStatus(status, 'x', body, 30_000, { method: 'POST' });

  it('does not read the word over a body that reports work', () => {
    // An inconsistent body: the word beside a record of a run. The record is
    // evidence that work was done, and outranks the word saying none was.
    for (const extra of [
      { steps: [{ n: 1, detail: 'clicked once' }] },
      { steps_taken: [{ n: 1, detail: 'clicked once' }] },
      { usage: { input_tokens: 10 } },
      { cost_usd: 0.25 },
      { thread_id: 'thr_0123456789abcdef01234567' },
      { agent: { computer_id: 'vm-1', steps: [] } },
    ]) {
      const err = post({ ...DRAINING, ...extra });
      expect(pausedForUpdate(err), JSON.stringify(extra)).toBe(false);
      expect(isTransient(err), JSON.stringify(extra)).toBe(false);
      expect(textOf(failed(err))).toContain('MAY OR MAY NOT HAVE HAPPENED');
    }
    // Nor beside a run's own failure envelope, or with no sentence at all.
    expect(pausedForUpdate(post({ error: { message: 'x' }, reason: 'draining' }))).toBe(false);
    expect(pausedForUpdate(post({ reason: 'draining' }))).toBe(false);
    // Absent and null record nothing.
    expect(pausedForUpdate(post({ ...DRAINING, thread_id: null }))).toBe(true);
  });

  it('reads the word only at the top level of a 503', () => {
    expect(pausedForUpdate(post(DRAINING))).toBe(true);
    expect(pausedForUpdate(post({ error: { message: 'x', reason: 'draining' } }))).toBe(false);
    expect(pausedForUpdate(post(DRAINING, 500))).toBe(false);
    expect(pausedForUpdate(post({ error: 'x', reason: 'contention' }))).toBe(false);
    expect(pausedForUpdate(new APIError('x', 503, DRAINING))).toBe(false);
    expect(pausedForUpdate(undefined)).toBe(false);
  });

  it('is the one change answered 503 that is worth sending again unchanged', () => {
    // isTransient is exported: an embedder's retry wrapper may resend this one.
    expect(isTransient(post(DRAINING))).toBe(true);
    expect(outcomeUnknownOn503(post(DRAINING))).toBe(false);
    expect(isTransient(post({ error: 'x' }))).toBe(false);
    expect(isTransient(post({ error: 'x', reason: 'contention' }))).toBe(false);
    expect(isTransient(post({ error: { message: 'x', reason: 'draining' } }))).toBe(false);
    expect(isTransient(post(DRAINING, 500))).toBe(false);
    expect(isTransientForPoll(post(DRAINING))).toBe(true);
  });

  it('is a rule about a 503, not a word that clears a 409', () => {
    // As in both SDKs: the word is read on its status, and a 409 carrying it
    // is as unclassified as it was.
    expect(reasonKind('draining')).toBeUndefined();
    for (const status of [400, 409]) {
      const refusal = errorForStatus(status, 'x', DRAINING, undefined, { method: 'POST' });
      expect(isTransient(refusal), String(status)).toBe(false);
      expect(isTransientForPoll(refusal), String(status)).toBe(false);
      expect(pausedForUpdate(refusal), String(status)).toBe(false);
    }
  });

  it('says so through the shared refusal, for any tool that meets it', () => {
    const said = textOf(failed(post(DRAINING)));
    expect(said).toContain(NOTHING);
    expect(said).toContain('Send the same call again after 30 seconds');
    expect(said).not.toContain('MAY OR MAY NOT HAVE HAPPENED');
    expect(textOf(failed(post({ error: 'x' })))).toContain('MAY OR MAY NOT HAVE HAPPENED');
  });

  it('rounds the wait up to whole seconds and never says zero', () => {
    expect(pausedForUpdateAdvice(30_000)).toContain('after 30 seconds');
    expect(pausedForUpdateAdvice(1_500)).toContain('after 2 seconds');
    expect(pausedForUpdateAdvice(0)).toContain('after 1 second,');
    expect(pausedForUpdateAdvice(undefined)).toContain('after a short wait');
  });
});

describe('the descriptions', () => {
  it('say what a draining refusal means on every tool that starts a run', async () => {
    const { client } = await open({ modelKey: 'sk-ant-test' });
    const { tools } = await client.listTools();
    for (const name of ['run_agent', 'start_agent_run', 'run_agent_chat']) {
      const description = tools.find((t) => t.name === name)?.description ?? '';
      expect(description, name).toContain('a 503 with reason draining');
      // The resend is granted on the answer's own sentence, which a body
      // recording work never gets, and not on the status and the word.
      expect(description, name).toContain(`only when the answer says ${NOTHING}`);
      expect(description, name).toContain('even if it shows reason draining');
      expect(description, name).not.toMatch(/reason draining means/);
    }
    const start = tools.find((t) => t.name === 'start_agent_run')?.description ?? '';
    expect(start).toContain('any other 5xx, a run may have started');
  });

  it('say it on a session that runs on AI credits too', async () => {
    const { client } = await open({ funded: true });
    const { tools } = await client.listTools();
    for (const name of ['run_agent', 'start_agent_run']) {
      expect(tools.find((t) => t.name === name)?.description, name).toContain(
        `only when the answer says ${NOTHING}`,
      );
    }
  });
});
