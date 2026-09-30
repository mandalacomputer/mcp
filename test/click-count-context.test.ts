/** The click tool's repeat count and its post-click window context (OPL-5472). */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

const textOf = (res: CallToolResult) =>
  res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('click count and context', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const lastInput = () => platform.calls.filter((c) => c.path.endsWith('/input')).at(-1)!;

  it('sends a count past three, and on the right and middle buttons', async () => {
    const { call, close } = await connect();
    const four = await call('click', { x: 5, y: 6, count: 4 });
    expect(lastInput().body).toEqual({ action: 'left_click', x: 5, y: 6, count: 4 });
    expect(textOf(four)).toContain('left_click x4 at 5,6');
    // Refused until now: a right or middle button could not repeat at all.
    const right = await call('click', { button: 'right', count: 2 });
    expect(right.isError).toBeFalsy();
    expect(lastInput().body).toEqual({ action: 'right_click', count: 2 });
    await call('click', { button: 'middle', count: 10 });
    expect(lastInput().body).toEqual({ action: 'middle_click', count: 10 });
    await close();
  });

  it('keeps a left double and triple click on the verbs the platform has for them', async () => {
    const { call, close } = await connect();
    await call('click', { x: 1, y: 2, count: 2 });
    expect(lastInput().body).toEqual({ action: 'double_click', x: 1, y: 2 });
    await call('click', { x: 1, y: 2, count: 3 });
    expect(lastInput().body).toEqual({ action: 'triple_click', x: 1, y: 2 });
    await call('click', { x: 1, y: 2 });
    expect(lastInput().body).toEqual({ action: 'left_click', x: 1, y: 2 });
    await close();
  });

  it('refuses a count past ten before anything is sent', async () => {
    const inputs = () => platform.calls.filter((c) => c.path.endsWith('/input')).length;
    const { call, close } = await connect();
    const before = inputs();
    const res = await call('click', { x: 1, y: 2, count: 11 });
    await close();
    expect(res.isError).toBe(true);
    expect(inputs()).toBe(before);
  });

  it('asks for context and hands back the windows after the click', async () => {
    const { call, close } = await connect();
    const res = await call('click', { x: 5, y: 6, context: true });
    await close();
    expect(lastInput().query.get('context')).toBe('1');
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain('left_click at 5,6. The desktop now:');
    expect(text).toContain('"focused"');
    expect(text).toContain('Xfce4-terminal');
  });

  it('says why when the windows could not be read, without calling the click a failure', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/input')) {
        return new Response(
          JSON.stringify({
            ok: true,
            context_error: 'listing windows is not supported on Windows guests yet',
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return real(input as never, init);
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('click', { x: 5, y: 6, context: true });
      await close();
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain(
        'Its windows could not be read (listing windows is not supported',
      );
    } finally {
      globalThis.fetch = real;
    }
  });

  it('sends no query when context is not asked for', async () => {
    const { call, close } = await connect();
    await call('click', { x: 5, y: 6 });
    await close();
    expect(lastInput().query.get('context')).toBeNull();
  });
});
