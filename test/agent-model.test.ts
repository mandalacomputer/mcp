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
