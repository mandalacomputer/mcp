/**
 * The page in the focused Chromium window in an input tool's context, and the
 * platform's reason when there is none.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

const textOf = (res: CallToolResult) =>
  res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

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

const CHROMIUM = {
  id: '0x3',
  title: 'Inbox - Chromium',
  class: 'Chromium',
  type: 'normal',
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  focused: true,
  visible: true,
};

const DOM = {
  url: 'https://mail.example/inbox',
  title: 'Inbox',
  truncated: false,
  elements: [
    { tag: 'button', role: '', name: 'Compose', text: '', x: 24, y: 188, width: 96, height: 32 },
    {
      tag: 'a',
      role: 'tab',
      name: '',
      text: 'Next',
      href: 'https://mail.example/2',
      x: 1180,
      y: 188,
      width: 40,
      height: 18,
    },
    { tag: 'a', x: 'nope' },
  ],
};

describe('page context', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  let restore: () => void = () => {};
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => {
    restore();
    platform.restore();
  });

  it('renders the page as one line per element, with the point to click', async () => {
    restore = answerInput({
      ok: true,
      context: { windows: [CHROMIUM], focused: CHROMIUM, dom: DOM },
    });
    const { call, close } = await connect();
    const res = await call('press_key', { keys: ['ctrl', 'l'], context: true });
    await close();
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain('The desktop now:');
    expect(text).toContain('"page"');
    expect(text).toContain('https://mail.example/inbox');
    // The name when there is no text, and the centre of the box.
    expect(text).toContain('button \\"Compose\\" — click 72,204 (box 24,188 96x32)');
    expect(text).toContain(
      'a[role=tab] \\"Next\\" — click 1200,197 (box 1180,188 40x18) -> https://mail.example/2',
    );
    // An element that is not one is left out rather than guessed at.
    expect(text).not.toContain('nope');
    expect(text).not.toContain('"dom"');
    expect(text).not.toContain('page_not_read');
  });

  it('passes the reason through beside the windows when there is no page', async () => {
    const said = 'the focused window is not Chromium, so no page elements were read';
    restore = answerInput({
      ok: true,
      context: { windows: [CHROMIUM], focused: CHROMIUM },
      context_error: said,
    });
    const { call, close } = await connect();
    const res = await call('press_key', { keys: ['ctrl', 'l'], context: true });
    await close();
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain('The desktop now:');
    expect(text).toContain('"focused"');
    expect(text).toContain(`"page_not_read": "${said}"`);
    expect(text).not.toContain('"page":');
  });

  it('still says the windows could not be read when there is no context', async () => {
    restore = answerInput({ ok: true, context_error: 'no active desktop session' });
    const { call, close } = await connect();
    const res = await call('press_key', { keys: ['ctrl', 'l'], context: true });
    await close();
    expect(textOf(res)).toContain('Its windows could not be read (no active desktop session)');
  });
});
