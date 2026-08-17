import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('desktop credentials', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('never puts the control token in an ordinary result', async () => {
    const { call, close } = await connect();
    for (const tool of ['list_computers', 'get_computer', 'use_computer', 'start_computer']) {
      const res = await call(tool, tool === 'use_computer' ? { computer_id: 'vm-1' } : {});
      expect(textOf(res), `${tool} leaked a desktop credential`).not.toContain('SECRET-CONTROL');
    }
    await close();
  });

  it('hands over the watch-only link by default and the control one only when asked', async () => {
    const { call, close } = await connect();
    const watching = textOf(await call('get_desktop_url', {}));
    expect(watching).toContain('view-only');
    expect(watching).not.toContain('SECRET-CONTROL');

    const driving = textOf(await call('get_desktop_url', { control: true }));
    expect(driving).toContain('SECRET-CONTROL');
    await close();
  });
});

describe('the session binding', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('says what to do when nothing is selected', async () => {
    const { call, close } = await connect({ computerId: undefined });
    const res = await call('screenshot', {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('use_computer');
    await close();
  });

  it('lets an explicit id override the binding without changing it', async () => {
    const { call, close } = await connect({ computerId: 'vm-1' });
    await call('get_computer', { computer_id: 'vm-9' });
    await call('get_computer', {});
    await close();
    const paths = platform.calls.map((c) => c.path);
    expect(paths).toContain('/computers/vm-9');
    expect(paths).toContain('/computers/vm-1');
  });

  it('forgets a computer it has just deleted', async () => {
    const { call, close } = await connect({ computerId: 'vm-1' });
    await call('delete_computer', { computer_id: 'vm-1', confirm: true });
    const res = await call('screenshot', {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('No computer selected');
    await close();
  });

  it('selects the computer a create just made', async () => {
    const { call, close } = await connect({ computerId: undefined });
    await call('create_computer', { template: 'base' });
    const res = await call('screenshot', {});
    expect(res.isError).toBeFalsy();
    await close();
  });
});

describe('screenshots', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('come back as an image, not as a path or a blob of base64 text', async () => {
    const { call, close } = await connect();
    const res = await call('screenshot', {});
    await close();
    const img = res.content.find((c) => c.type === 'image');
    expect(img).toBeDefined();
    expect((img as { mimeType: string }).mimeType).toBe('image/png');
  });

  it('skip the frame cache by default', async () => {
    const { call, close } = await connect();
    await call('screenshot', {});
    await close();
    const shot = platform.calls.find((c) => c.path.endsWith('/screenshot'));
    // A cached frame can predate the click that prompted the look, and a model
    // reading it concludes the click missed and clicks again.
    expect(shot?.query.get('fresh')).toBe('1');
  });
});

describe('input bodies', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const lastInput = () =>
    platform.calls.filter((c) => c.path.endsWith('/input')).at(-1)?.body as Record<string, unknown>;

  it('omits the coordinate on a click that named none', async () => {
    const { call, close } = await connect();
    await call('click', {});
    await close();
    // Not zeros: a click with no coordinate clicks where the pointer already
    // is, which is a different request from clicking the corner of the screen.
    expect(lastInput()).toEqual({ action: 'left_click' });
  });

  it('sends a scroll position as coordinate, never as a flat zero pair', async () => {
    const { call, close } = await connect();
    await call('scroll', { direction: 'up', x: 0, y: 0, amount: 2 });
    await close();
    // The platform reads a flat x:0,y:0 on a scroll as "no position", so the
    // corner of the screen is unsayable that way.
    expect(lastInput().coordinate).toEqual([0, 0]);
    expect(lastInput().x).toBeUndefined();
  });

  it('turns a double click into the verb the platform has for it', async () => {
    const { call, close } = await connect();
    await call('click', { x: 5, y: 6, count: 2 });
    await close();
    expect(lastInput()).toMatchObject({ action: 'double_click', x: 5, y: 6 });
  });

  it('refuses half an origin on a drag rather than dropping it', async () => {
    const { call, close } = await connect();
    const res = await call('drag', { to_x: 9, to_y: 9, from_x: 1 });
    await close();
    // Silently ignoring the half given produces a drag that succeeds while
    // selecting a different region — a mistake nothing reports.
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('both from_x and from_y');
  });

  it('refuses a wait longer than the platform will hold a request open for', async () => {
    const { call, close } = await connect();
    const res = await call('wait', { seconds: 30.5 });
    await close();
    expect(res.isError).toBe(true);
  });
});

describe('files', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('encodes a guest path with punctuation in it', async () => {
    const { call, close } = await connect();
    await call('write_file', { path: '/home/user/Q3 profit & loss.txt', content: 'x' });
    await close();
    const put = platform.calls.find((c) => c.method === 'PUT');
    // Unencoded, `&` ends the query parameter and `+` decodes to a space, so
    // the platform would write a different file and nothing would report it.
    expect(put?.query.get('path')).toBe('/home/user/Q3 profit & loss.txt');
  });
});

describe('failures', () => {
  it("hand back the platform's own sentence, as something the model can read", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: 'the guest agent is not answering yet (the computer may still be booting)',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    const { call, close } = await connect();
    const res = await call('exec', { command: 'true' });
    await close();
    globalThis.fetch = real;

    expect(res.isError).toBe(true);
    // Not a status line: this sentence is the one that tells a model to wait and
    // try again rather than to give up or report a broken tool.
    expect(textOf(res)).toContain('may still be booting');
    expect(textOf(res)).toContain('409');
  });

  it('says plainly when a command timed out but is still running', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ exit_code: -1, timed_out: true, stdout: '' }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const { call, close } = await connect();
    const res = await call('exec', { command: 'sleep 600' });
    await close();
    globalThis.fetch = real;

    expect(textOf(res)).toContain('TIMED OUT');
    expect(textOf(res)).toContain('background');
  });
});
