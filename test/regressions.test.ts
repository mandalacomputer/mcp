import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';
import { parse } from '../src/cli.js';
import { unwrapComputer } from '../src/format.js';
import { windowBody } from '../src/paths.js';
import { BASE, connect, installFakePlatform } from './harness.js';

/**
 * One test per bug an adversarial review found and this repo then fixed.
 *
 * Kept together rather than filed by subject, because what they have in common
 * is not a module — it is that each one passed review, shipped, and was wrong
 * anyway. The comment on each says what the code used to do.
 */

describe('argv parsing', () => {
  it('keeps a value that contains an equals sign', () => {
    // `split('=', 2)` truncates rather than splits: the limit discards the
    // remainder instead of keeping it, so the key silently became `com_a`.
    expect(parse(['--key=com_a=b'])).toEqual({ key: 'com_a=b' });
    expect(parse(['--base-url=https://h/v1?a=b'])).toEqual({
      'base-url': 'https://h/v1?a=b',
    });
  });

  it('still takes a separate value, and a bare flag as true', () => {
    expect(parse(['--port', '3000'])).toEqual({ port: '3000' });
    expect(parse(['--http'])).toEqual({ http: true });
  });
});

describe('a computer that would not boot', () => {
  it('keeps a start_error the platform nested with the computer', () => {
    // The outer value was written unconditionally, so a nested reason was
    // replaced with `undefined` — losing the only account of why a machine
    // that exists and is billable never came up.
    expect(unwrapComputer({ computer: { id: 'vm-1', start_error: 'no host capacity' } })).toEqual({
      id: 'vm-1',
      start_error: 'no host capacity',
    });
  });

  it('still prefers the sibling form the SDK flattens', () => {
    expect(unwrapComputer({ computer: { id: 'vm-1' }, start_error: 'boom' }).start_error).toBe(
      'boom',
    );
  });
});

describe('window actions', () => {
  it('refuses half a coordinate instead of sending it', () => {
    // A move with only x went to the platform as a partial body. The window
    // manager places the frame where it likes, so the result of that does not
    // look like an error — it looks like the usual approximation.
    expect(() => windowBody({ action: 'move', x: 5 })).toThrow(/both x and y/);
    expect(() => windowBody({ action: 'resize' })).toThrow(/width, height/);
  });

  it('leaves the actions that take no geometry alone', () => {
    expect(windowBody({ action: 'focus' })).toEqual({ action: 'focus' });
    expect(windowBody({ action: 'move', x: 5, y: 6 })).toEqual({ action: 'move', x: 5, y: 6 });
  });
});

describe('an empty body from a route that should have answered', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('is a named failure, not undefined cast to the expected type', async () => {
    // `as T` handed every caller `undefined` typed as present. What a caller
    // did with it was either `text: undefined` — not a valid tool result, so
    // the client rejected the whole call — or a TypeError reading a field.
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const api = new Api('com_test', BASE);
    await expect(api.json('GET', 'templates')).rejects.toThrow(/empty body/);
  });

  it('is an ordinary answer on the routes that may legitimately be silent', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const api = new Api('com_test', BASE);
    await expect(api.send('DELETE', 'snapshots/snap-1')).resolves.toBeUndefined();
  });
});

describe('a desktop link the platform did not send', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('is said in words, not printed as an empty object', async () => {
    // `JSON.stringify` drops an undefined value rather than recording it, so a
    // vnc object without the requested key produced `{}` underneath a sentence
    // promising full control of the machine.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ id: 'vm-1', status: 'running', vnc: { view_url: 'wss://v' } }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      )) as typeof fetch;

    const { call, close } = await connect();
    const res = await call('get_desktop_url', { control: true });
    const said = res.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(said).not.toContain('{}');
    expect(said).toMatch(/no control URL/i);
    await close();
  });
});

describe('refusals this server decides on its own', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  // Every one of these used to come back as a successful tool call carrying a
  // sentence of bad news, which a caller reading isError could not tell from a
  // step that worked.
  it.each([
    ['update_computer', {}],
    ['click', { count: 2, button: 'right' }],
    ['write_file', { path: '/a', content: '!!!!', encoding: 'base64' }],
    ['snapshot_schedule', { set: { enabled: true, hour: 3 }, clear: true }],
  ])('%s says isError when it refuses', async (tool, args) => {
    const { call, close } = await connect();
    const res = await call(tool, args);
    expect(res.isError, `${tool} reported a refusal as a success`).toBe(true);
    await close();
  });

  it('does not clear a schedule that was sent alongside a set', async () => {
    const { call, close } = await connect();
    await call('snapshot_schedule', { set: { enabled: true, hour: 3 }, clear: true });
    expect(platform.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    await close();
  });
});
