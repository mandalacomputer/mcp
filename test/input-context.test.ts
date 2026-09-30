/**
 * `context` on every input tool, not only click (OPL-5523), and the
 * User-Agent naming this server and its version.
 */

import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../src/server.js';
import { connect, installFakePlatform } from './harness.js';

const textOf = (res: CallToolResult) =>
  res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

/** Every input tool but click and cursor_position, with the action it sends. */
const TOOLS: [tool: string, action: string, args: Record<string, unknown>][] = [
  ['type_text', 'type', { text: 'hello' }],
  ['paste_text', 'paste', { text: 'hello' }],
  ['press_key', 'key', { keys: ['ctrl', 'l'] }],
  ['press_key', 'hold_key', { keys: ['shift'], hold_seconds: 1 }],
  ['scroll', 'scroll', { direction: 'down', x: 5, y: 6 }],
  ['drag', 'left_click_drag', { to_x: 5, to_y: 6, from_x: 1, from_y: 2 }],
  ['move_mouse', 'mouse_move', { x: 5, y: 6 }],
  ['mouse_button', 'left_mouse_down', { state: 'down' }],
  ['mouse_button', 'left_mouse_up', { state: 'up' }],
  ['wait', 'wait', { seconds: 1 }],
];

/** Answer every input call with `answer`, and everything else as the fake does. */
const answerInput = (answer: Record<string, unknown>) => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/input')) {
      return new Response(JSON.stringify(answer), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return real(input as never, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
};

describe('context on every input tool', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const lastInput = () => platform.calls.filter((c) => c.path.endsWith('/input')).at(-1)!;

  it.each(TOOLS)(
    '%s (%s) asks for context and hands back the windows',
    async (tool, action, args) => {
      const { call, close } = await connect();
      const res = await call(tool, { ...args, context: true });
      await close();
      expect(lastInput().query.get('context')).toBe('1');
      expect((lastInput().body as { action: string }).action).toBe(action);
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('The desktop now:');
      expect(text).toContain('"focused"');
      expect(text).toContain('Xfce4-terminal');
    },
  );

  it.each(TOOLS)(
    '%s (%s) sends no query and no windows when not asked',
    async (tool, action, args) => {
      const { call, close } = await connect();
      const res = await call(tool, args);
      await close();
      expect(lastInput().query.get('context')).toBeNull();
      expect((lastInput().body as { action: string }).action).toBe(action);
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).not.toContain('The desktop now');
    },
  );

  it.each(TOOLS)('%s (%s) says why the windows could not be read', async (tool, _action, args) => {
    const restore = answerInput({ ok: true, context_error: 'no active desktop session' });
    try {
      const { call, close } = await connect();
      const res = await call(tool, { ...args, context: true });
      await close();
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain('Its windows could not be read (no active desktop session)');
    } finally {
      restore();
    }
  });

  it('keeps what type_text says about how it typed, with the context after it', async () => {
    const restore = answerInput({
      ok: true,
      mechanism: 'physical',
      context: { windows: [], focused: null },
    });
    try {
      const { call, close } = await connect();
      const res = await call('type_text', { text: 'hello', context: true });
      await close();
      const text = textOf(res);
      expect(text).toContain('Typed 5 character(s)');
      expect(text).toContain('The desktop now:');
      expect(text).toContain('"focused": null');
    } finally {
      restore();
    }
  });
});

describe('User-Agent', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('names this server, its version and the Node it runs on, on every request', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(SERVER_VERSION).toBe(pkg.version);
    const { call, close } = await connect();
    await call('move_mouse', { x: 1, y: 2 });
    await call('list_computers', {});
    await close();
    expect(platform.calls.length).toBeGreaterThan(1);
    for (const c of platform.calls) {
      expect(c.headers['user-agent'], `${c.method} ${c.path}`).toBe(
        `mandala-computer-mcp/${SERVER_VERSION} node/${process.versions.node}`,
      );
    }
  });
});
