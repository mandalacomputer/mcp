import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_MS } from '../src/poll.js';
import { CHAT_COMPLETION, connect, installFakePlatform } from './harness.js';

const task = { messages: [{ role: 'user', content: 'Open the browser' }] };
const ACCOUNT = 'com_chat_account_sentinel';
const MODEL = 'sk-ant-chat-model-sentinel';
let platform: ReturnType<typeof installFakePlatform>;
let connection: Awaited<ReturnType<typeof connect>>;
let release: ReturnType<typeof vi.fn>;
function answer(value: unknown, status = 200, headers = {}) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await previous(...args);
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  };
}
const text = (value: unknown) => JSON.stringify(value);
beforeEach(async () => {
  platform = installFakePlatform();
  release = vi.fn();
  connection = await connect({ apiKey: ACCOUNT, modelKey: MODEL, activity: () => release });
});
afterEach(async () => {
  vi.useRealTimers();
  await connection.close();
  platform.restore();
  vi.restoreAllMocks();
});

describe('BYOK JSON chat request and response contract', () => {
  it('sends the whole textual message array with body computer, fixed stream false and only caller keys', async () => {
    const messages = [
      { role: 'system', content: 'Standing instructions' },
      { role: 'user', content: 'Old task' },
      { role: 'assistant', content: 'Previous response' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'New ' },
          { type: 'text', text: 'task' },
        ],
      },
    ];
    const result = await connection.call('run_agent_chat', {
      computer_id: 'vm-other',
      messages,
      model: 'claude-explicit',
      max_steps: 4,
    });
    expect(result.isError).not.toBe(true);
    expect(platform.calls).toHaveLength(1);
    expect(platform.calls[0]).toMatchObject({
      method: 'POST',
      path: '/chat/completions',
      body: {
        computer_id: 'vm-other',
        messages,
        model: 'claude-explicit',
        max_steps: 4,
        stream: false,
      },
      headers: { authorization: `Bearer ${ACCOUNT}`, 'x-model-key': MODEL },
    });
    expect([...platform.calls[0].query]).toEqual([]);
    expect(text(result)).not.toContain(ACCOUNT);
    expect(text(result)).not.toContain(MODEL);
    expect(release).toHaveBeenCalledOnce();
    const tool = (await connection.client.listTools()).tools.find(
      (t) => t.name === 'run_agent_chat',
    );
    expect(tool?.annotations?.openWorldHint).toBe(true);
    expect(tool?.annotations?.readOnlyHint).not.toBe(true);
    expect(tool?.description).toContain('last user');
    expect(tool?.description).toContain('resetTimeoutOnProgress');
  });
  it('omits unspecified model and preserves completion, usage and underlying stop metadata', async () => {
    const result = await connection.call('run_agent_chat', task);
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain('finished');
    expect(platform.calls[0].body).toEqual({
      ...task,
      computer_id: 'vm-1',
      max_steps: 20,
      stream: false,
    });
    for (const field of [
      'chatcmpl-fixture',
      'mandala-agent',
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'end_turn',
    ])
      expect(text(result)).toContain(field);
  });
  it.each([
    { messages: [] },
    { messages: [{ role: 'assistant', content: 'No task' }] },
    {
      messages: [
        { role: 'user', content: 'Old task' },
        { role: 'user', content: '  ' },
      ],
    },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'not-text' }] }] },
    { messages: [null] },
    { ...task, model: ' ' },
    ...[0, 101, 1.5].map((max_steps) => ({ ...task, max_steps })),
  ])('rejects invalid chat arguments %# before requests or heartbeat', async (args) => {
    const log = vi.spyOn(connection.server.server, 'sendLoggingMessage');
    expect((await connection.call('run_agent_chat', args)).isError).toBe(true);
    expect(platform.calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });
  it.each([
    'max_steps',
    'refusal',
    'max_tokens',
    'model_context_window_exceeded',
    'pause_turn',
    'unknown',
  ])('does not report stop=%s as successful even with finish_reason stop', async (stop) => {
    answer({ ...CHAT_COMPLETION, agent: { ...CHAT_COMPLETION.agent, stop } });
    const result = await connection.call('run_agent_chat', task);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(stop);
    expect(text(result)).toContain('total_tokens');
    expect(platform.calls).toHaveLength(1);
  });
  it.each([
    { ...CHAT_COMPLETION, agent: undefined },
    { ...CHAT_COMPLETION, agent: { computer_id: 'vm-1', steps: 2 } },
    { ...CHAT_COMPLETION, choices: [] },
    { ...CHAT_COMPLETION, choices: null },
    {
      ...CHAT_COMPLETION,
      choices: [{ message: { role: 'assistant', content: 'Partial answer' } }],
    },
    { ...CHAT_COMPLETION, choices: [{ ...CHAT_COMPLETION.choices[0], finish_reason: 'length' }] },
    { ...CHAT_COMPLETION, agent: { ...CHAT_COMPLETION.agent, computer_id: 'wrong' } },
    { ...CHAT_COMPLETION, usage: { ...CHAT_COMPLETION.usage, total_tokens: 99 } },
    { ...CHAT_COMPLETION, agent: { ...CHAT_COMPLETION.agent, steps: 21 } },
    {},
    null,
  ])(
    'refuses malformed or conflicting terminal envelope %# with valid partial fields kept',
    async (response) => {
      answer(response);
      const result = await connection.call('run_agent_chat', task);
      expect(result.isError).toBe(true);
      expect(platform.calls).toHaveLength(1);
      expect(release).toHaveBeenCalledOnce();
      if (response && 'usage' in response) expect(text(result)).toContain('prompt_tokens');
      if (response && 'id' in response) expect(text(result)).toContain('chatcmpl-fixture');
    },
  );
  it('keeps valid token counts and assistant text when part of the terminal metadata is malformed', async () => {
    answer({
      ...CHAT_COMPLETION,
      usage: { prompt_tokens: 'invalid', completion_tokens: 7, total_tokens: 30 },
      agent: { steps: 2 },
      choices: [{ message: { role: 'assistant', content: 'Partial answer' } }],
    });
    const result = await connection.call('run_agent_chat', task);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Partial answer');
    expect(text(result)).toContain('completion_tokens');
    expect(text(result)).toContain('steps');
    expect(text(result)).not.toContain('invalid');
  });
  it('redacts provider-echoed keys in known fields as well as ignoring unknown objects', async () => {
    answer({
      ...CHAT_COMPLETION,
      choices: [
        {
          ...CHAT_COMPLETION.choices[0],
          message: { role: 'assistant', content: `Sentinels: ${ACCOUNT} ${MODEL}` },
        },
      ],
      request: { Authorization: ACCOUNT },
      extra: MODEL,
    });
    const result = await connection.call('run_agent_chat', task);
    expect(text(result)).not.toContain(ACCOUNT);
    expect(text(result)).not.toContain(MODEL);
    expect(text(result)).toContain('[redacted]');
    expect(text(result)).not.toContain('Authorization');
  });
});

describe('flat and nested chat failures', () => {
  it.each([401, 403, 402, 429, 503])(
    'preserves actual HTTP %i despite conflicting nested code and retained billed work',
    async (status) => {
      answer(
        {
          error: {
            message: `Provider refused ${MODEL} ${ACCOUNT}`,
            code: 200,
            reason: 'contention',
            steps: [{ n: 1, action: 'click', detail: 'clicked once', secret: MODEL }],
            usage: CHAT_COMPLETION.usage,
            request: { headers: { Authorization: ACCOUNT } },
          },
        },
        status,
        { 'Retry-After': '3' },
      );
      const result = await connection.call('run_agent_chat', task);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(`HTTP ${status}`);
      expect(text(result)).toContain('clicked once');
      expect(text(result)).toContain('prompt_tokens');
      expect(text(result)).toContain('already recorded work');
      expect(text(result)).toContain('3000');
      expect(text(result)).not.toContain(ACCOUNT);
      expect(text(result)).not.toContain(MODEL);
      expect(text(result)).not.toContain('headers');
      expect(platform.calls).toHaveLength(1);
      expect(release).toHaveBeenCalledOnce();
      if (status === 401) {
        expect(text(result)).toContain('account key or model key');
        expect(text(result)).not.toContain('credential this server is using stopped');
      }
      if (status === 403) expect(text(result)).toContain('Retrying does not help');
      if (status === 402) expect(text(result)).toContain('not something waiting fixes');
    },
  );
  it('continues to support flat preflight errors', async () => {
    answer({ error: 'model key is required', reason: 'unsupported' }, 400);
    const result = await connection.call('run_agent_chat', task);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('model key is required');
    expect(platform.calls).toHaveLength(1);
  });
});

describe('chat heartbeat and callback lifetime', () => {
  it.each(['success', 'error', 'malformed', 'cancelled'] as const)(
    'counts neutral heartbeats and stops after %s',
    async (outcome) => {
      const prior = globalThis.fetch;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let started = false;
      let forwardedSignal: AbortSignal | null | undefined;
      globalThis.fetch = async (...args) => {
        started = true;
        forwardedSignal = args[1]?.signal;
        await pending;
        await prior(...args);
        return new Response(
          JSON.stringify(
            outcome === 'error'
              ? { error: { message: 'run refused' } }
              : outcome === 'malformed'
                ? {}
                : CHAT_COMPLETION,
          ),
          {
            status: outcome === 'error' ? 403 : 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      };
      vi.useFakeTimers();
      const beats: { progress: number; total?: number; message?: string }[] = [];
      const logs = vi.spyOn(connection.server.server, 'sendLoggingMessage');
      const controller = new AbortController();
      const result = connection.client
        .callTool({ name: 'run_agent_chat', arguments: task }, undefined, {
          signal: controller.signal,
          resetTimeoutOnProgress: true,
          onprogress: (p) => {
            beats.push(p);
          },
        })
        .catch((error) => error);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toBe(true);
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2 + 1);
        expect(beats.length).toBeGreaterThanOrEqual(3);
        expect(beats.map((p) => p.progress)).toEqual(beats.map((_, i) => i + 1));
        expect(
          beats.every((p) => p.total === undefined && p.message?.includes('not completed actions')),
        ).toBe(true);
        expect(text(beats)).not.toContain(MODEL);
        expect(text(logs.mock.calls)).not.toContain(ACCOUNT);
        if (outcome === 'cancelled') {
          controller.abort();
          await result;
          await vi.advanceTimersByTimeAsync(0);
          expect(release).not.toHaveBeenCalled();
          expect(forwardedSignal?.aborted).toBe(true);
        }
      } finally {
        finish();
      }
      const response = await result;
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === 'success') expect(response.isError).not.toBe(true);
      if (outcome === 'error' || outcome === 'malformed') expect(response.isError).toBe(true);
      expect(release).toHaveBeenCalledOnce();
      const before = beats.length;
      const logged = logs.mock.calls.length;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
      expect(beats).toHaveLength(before);
      expect(logs).toHaveBeenCalledTimes(logged);
      expect(platform.calls).toHaveLength(1);
    },
  );
  it('does not dispatch an already-cancelled caller request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      connection.client.callTool({ name: 'run_agent_chat', arguments: task }, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(platform.calls).toHaveLength(0);
  });
});
