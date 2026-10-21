/**
 * A free trial's refusals (OPL-6134). `TRIAL_FULL` and `TRIAL_UNAVAILABLE` are
 * 503s the platform answers before a create, start or resume is sent, so
 * nothing happened; every other 503 to a change keeps saying the outcome is
 * unknown. The 402s and the 409 a trial meets each say what to do instead.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  errorForStatus,
  isTransient,
  outcomeUnknownOn503,
  trialUnavailable,
  unclassifiedConflict,
} from '../src/errors.js';
import { failed } from '../src/format.js';
import { connect, installFakePlatform } from './harness.js';

let platform: ReturnType<typeof installFakePlatform>;
let recording: typeof fetch;
const connections: Awaited<ReturnType<typeof connect>>[] = [];
async function open() {
  const connection = await connect({});
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

const FULL = {
  error: 'Every trial computer is in use right now. Try again in a minute.',
  code: 'TRIAL_FULL',
};
const PAUSED = {
  error:
    'Trials are paused on this service right now. Nothing was used up; choose a plan to launch a computer, or try again later.',
  code: 'TRIAL_UNAVAILABLE',
};

/** Answer every POST whose path ends with `suffix` with this status, body and headers. */
function postsAnswer(
  suffix: string,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  let sent = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const url = new URL(String(args[0] instanceof Request ? args[0].url : args[0]));
    const method = (args[0] instanceof Request ? args[0].method : args[1]?.method) ?? 'GET';
    if (method.toUpperCase() !== 'POST' || !url.pathname.endsWith(suffix))
      return recording(...args);
    sent += 1;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return () => sent;
}

const NOTHING = 'NOTHING HAPPENED AND NOTHING WAS USED UP';
const post = (status: number, body: unknown, retryAfterMs?: number) =>
  errorForStatus(status, 'x', body, retryAfterMs, { method: 'POST' });

describe('a trial refused before anything was sent', () => {
  it('create_computer on TRIAL_FULL says nothing happened, the wait, and the same key', async () => {
    const sent = postsAnswer('/computers', 503, FULL, { 'Retry-After': '60' });
    const { call } = await open();
    const res = await call('create_computer', { idempotency_key: 'trial-key-1' });
    expect(res.isError).toBe(true);
    const said = textOf(res);
    expect(said).toContain('every free-trial slot is in use');
    expect(said).toContain(NOTHING);
    expect(said).toContain('after 60 seconds');
    expect(said).toContain('send the SAME idempotency_key');
    expect(said).toContain('"code": "TRIAL_FULL"');
    expect(said).not.toContain('MAY OR MAY NOT HAVE HAPPENED');
    expect(said).not.toContain('nothing may have been done');
    expect(sent()).toBe(1);
  });

  it('start_computer on TRIAL_UNAVAILABLE says nothing happened and that it does not clear soon', async () => {
    postsAnswer('/start', 503, PAUSED);
    const { call } = await open();
    const said = textOf(await call('start_computer', { computer_id: 'vm-1' }));
    expect(said).toContain('trials are paused');
    expect(said).toContain(NOTHING);
    expect(said).toContain('does not clear in seconds');
    expect(said).not.toContain('MAY OR MAY NOT HAVE HAPPENED');
    expect(said).not.toContain('after a short wait on a busy');
  });

  it('only in the shape the platform sends: anything else keeps the unknown outcome', () => {
    for (const body of [
      { error: { message: 'x' }, code: 'TRIAL_FULL' },
      { code: 'TRIAL_FULL' },
      { error: 'x', reason: 'TRIAL_FULL' },
      { error: 'x', code: 'TRIAL_ELSE' },
    ]) {
      expect(trialUnavailable(post(503, body)), JSON.stringify(body)).toBe(false);
      expect(textOf(failed(post(503, body)))).toContain('MAY OR MAY NOT HAVE HAPPENED');
    }
    // A 500 with the code is not the refusal either.
    expect(trialUnavailable(post(500, FULL))).toBe(false);
  });

  it('leaves the retry predicate as it was', () => {
    expect(trialUnavailable(post(503, FULL))).toBe(true);
    expect(isTransient(post(503, FULL, 60_000))).toBe(false);
    expect(isTransient(post(503, PAUSED))).toBe(false);
    expect(outcomeUnknownOn503(post(503, FULL))).toBe(true);
  });

  it('says no wait was named rather than a nonsense number', () => {
    expect(textOf(failed(post(503, FULL)))).toContain(
      'after a short wait (the answer did not say how long)',
    );
    expect(textOf(failed(post(503, FULL, Number.NaN)))).not.toContain('NaN');
  });
});

describe('what a trial is not allowed', () => {
  it.each([
    ['TRIAL_LIMIT', 402, 'the trial does not include this'],
    ['TRIAL_CREATES_USED', 402, 'launched every computer it can'],
    ['PLAN_REQUIRED', 402, 'no plan that covers this'],
    ['TRIAL_CREATE_PENDING', 409, 'earlier create is still under way'],
  ])('%s says what to do instead, and is final', (code, status, words) => {
    const err = post(status, { error: 'x', code });
    const said = textOf(failed(err));
    expect(said).toContain(words);
    expect(said).not.toContain('does not cover what was asked for');
    expect(isTransient(err)).toBe(false);
    expect(unclassifiedConflict(err)).toBe(false);
  });

  it('a code on another status keeps that status’s own advice', () => {
    const said = textOf(failed(post(403, { error: 'x', code: 'TRIAL_LIMIT' })));
    expect(said).not.toContain('the trial does not include this');
  });

  it('create_computer on TRIAL_CREATES_USED says to use the computer it has', async () => {
    postsAnswer('/computers', 402, {
      error: 'This trial has launched its 4 computers. Choose a plan to launch another.',
      code: 'TRIAL_CREATES_USED',
    });
    const { call } = await open();
    const said = textOf(await call('create_computer', {}));
    expect(said).toContain('launched every computer it can');
    expect(said).toContain('list_computers');
  });
});
