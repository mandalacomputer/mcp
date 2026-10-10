/**
 * run_agent's optional `model` (OPL-5323): passed to the platform's agent body,
 * and left out when not given so the platform picks.
 */

import { afterEach, beforeEach, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

let platform: ReturnType<typeof installFakePlatform>;
beforeEach(() => {
  platform = installFakePlatform();
});
afterEach(() => platform.restore());

const agentBody = () =>
  platform.calls.filter((c) => c.path.endsWith('/agent')).at(-1)?.body as Record<string, unknown>;

it('sends model when given, and not otherwise', async () => {
  const { call, close } = await connect({ modelKey: 'sk-test' });
  const chosen = await call('run_agent', { prompt: 'open firefox', model: 'claude-test-model' });
  expect(chosen.isError).toBeFalsy();
  expect(agentBody()).toMatchObject({ prompt: 'open firefox', model: 'claude-test-model' });
  await call('run_agent', { prompt: 'open firefox' });
  expect(agentBody()).not.toHaveProperty('model');
  await close();
});

it('refuses a blank model before any request', async () => {
  const { call, close } = await connect({ modelKey: 'sk-test' });
  const before = platform.calls.length;
  const res = await call('run_agent', { prompt: 'open firefox', model: '  ' });
  expect(res.isError).toBe(true);
  expect(platform.calls.length).toBe(before);
  await close();
});

it.each(['run_agent', 'run_agent_chat'])(
  'forwards provider from %s and rejects unknown providers before HTTP',
  async (tool) => {
    const { call, close } = await connect({ modelKey: 'sk-test' });
    const task =
      tool === 'run_agent' ? { prompt: 'go' } : { messages: [{ role: 'user', content: 'go' }] };
    try {
      const chosen = await call(tool, { ...task, provider: 'openai', model: 'custom-model' });
      expect(chosen.isError).toBeFalsy();
      expect(platform.calls.at(-1)?.body).toMatchObject({
        provider: 'openai',
        model: 'custom-model',
      });
      const before = platform.calls.length;
      const invalid = await call(tool, { ...task, provider: 'typo' });
      expect(invalid.isError).toBe(true);
      expect(platform.calls).toHaveLength(before);
      await call(tool, task);
      expect(platform.calls.at(-1)?.body).not.toHaveProperty('provider');
    } finally {
      await close();
    }
  },
);
