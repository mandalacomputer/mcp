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
    // Every tool that returns a computer, not a sample of them: the one left
    // out of this list is the one that leaks, which is exactly how
    // wait_for_computer came to hand the control token to the model.
    for (const tool of [
      'list_computers',
      'get_computer',
      'use_computer',
      'start_computer',
      'stop_computer',
      'suspend_computer',
      'restart_computer',
      'update_computer',
      'wait_for_computer',
      'create_computer',
      'clone_computer',
      'clone_snapshot',
    ]) {
      const args =
        tool === 'use_computer'
          ? { computer_id: 'vm-1' }
          : tool === 'update_computer'
            ? { name: 'renamed' }
            : tool === 'clone_snapshot'
              ? { snapshot_id: 'snap-1' }
              : {};
      const res = await call(tool, args);
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

  it('does not label a screenshot with another computer’s resolution', async () => {
    const { call, close } = await connect({ computerId: 'vm-1' });
    // Bind vm-1 and learn its geometry, then shoot a different machine.
    await call('get_computer', {});
    const own = await call('screenshot', {});
    const other = await call('screenshot', { computer_id: 'vm-9' });
    await close();
    // session.screen is the BOUND computer's resolution — noteResolution
    // refuses to update it for any other id — so printing it beside a picture
    // of vm-9 states the wrong coordinate space to click in.
    expect(textOf(own)).toContain('1280x800x24');
    expect(textOf(other)).not.toContain('1280x800x24');
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

  it('refuses half a coordinate rather than completing it with a zero', async () => {
    const { call, close } = await connect();
    // A y with no x used to send x:0 — the edge of the screen — while the reply
    // said the action happened "where the pointer was". Right for the drag,
    // right for these.
    for (const [tool, args] of [
      ['click', { y: 400 }],
      ['mouse_button', { state: 'down', y: 400 }],
      ['scroll', { direction: 'up', y: 400 }],
    ] as const) {
      const res = await call(tool, args);
      expect(res.isError, `${tool} accepted half a coordinate`).toBe(true);
      expect(textOf(res)).toContain('both x and y');
    }
    await close();
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

  it('refuses malformed base64 instead of writing a silently corrupt file', async () => {
    const { call, close } = await connect();
    const res = await call('write_file', {
      path: '/home/user/a.bin',
      content: 'not base64!!!',
      encoding: 'base64',
    });
    await close();
    // Buffer.from(…, 'base64') drops what it does not recognise and never
    // throws, so this used to write six bytes and report success.
    expect(textOf(res)).toContain('Nothing was written');
    expect(platform.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('accepts the base64 Node decodes correctly, padded or not', async () => {
    const { call, close } = await connect();
    // The guard has to match the decoder, not a stricter idea of the format.
    // Node reads unpadded base64 and the base64url alphabet byte-perfectly, so
    // refusing either would reject content that used to be written correctly —
    // while telling the caller it was corrupt.
    for (const content of ['YWJjZA==', 'YWJjZA', 'aGVsbG8', '--__']) {
      const res = await call('write_file', {
        path: '/home/user/a.bin',
        content,
        encoding: 'base64',
      });
      expect(textOf(res), `refused decodable base64: ${content}`).toContain('Wrote');
    }
    await close();
  });
});

describe('failures', () => {
  // The restore is unconditional, not a statement after the assertions. A throw
  // anywhere in the body — connect, close, or an expect — would otherwise leave
  // one of these stubs installed as the process-wide fetch, and every later
  // test in the file would fail somewhere far from the cause.
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it("hand back the platform's own sentence, as something the model can read", async () => {
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

    expect(res.isError).toBe(true);
    // Not a status line: this sentence is the one that tells a model to wait and
    // try again rather than to give up or report a broken tool.
    expect(textOf(res)).toContain('may still be booting');
    expect(textOf(res)).toContain('409');
  });

  it('says plainly when a command timed out but is still running', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ exit_code: -1, timed_out: true, stdout: '' }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const { call, close } = await connect();
    const res = await call('exec', { command: 'sleep 600' });
    await close();

    expect(textOf(res)).toContain('TIMED OUT');
    expect(textOf(res)).toContain('background');
  });
});

describe('the clipboard', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('states the xclip image requirement everywhere it recommends the tools', async () => {
    const { client, call, close } = await connect({ computerId: 'vm-1' });
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    const guidance = [
      tools.get('read_clipboard')?.description,
      tools.get('write_clipboard')?.description,
      textOf(await call('get_desktop_url', { control: true })),
    ];
    for (const text of guidance) {
      expect(text).toMatch(/image.+xclip|xclip.+image/);
      expect(text).toContain('400');
    }
    await close();
  });

  it('reads the selection and hands back the text', async () => {
    const { call, close } = await connect({ computerId: 'vm-1' });
    const res = await call('read_clipboard', {});
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('on the clipboard');
    const read = platform.calls.at(-1);
    expect([read?.method, read?.path]).toEqual(['GET', '/computers/vm-1/clipboard']);
    await close();
  });

  it('writes the one field the platform decodes', async () => {
    const { call, close } = await connect({ computerId: 'vm-1' });
    const res = await call('write_clipboard', { text: 'hello' });
    expect(res.isError).toBeFalsy();
    const wrote = platform.calls.at(-1);
    expect([wrote?.method, wrote?.path]).toEqual(['PUT', '/computers/vm-1/clipboard']);
    expect(wrote?.body).toEqual({ text: 'hello' });
    await close();
  });

  it('refuses what the platform would refuse, without spending the call', async () => {
    // Asserted as NO REQUEST at all. A refusal that still sent it would have
    // spent the round trip the local check exists to save — and the NUL one
    // would have spent it on a write that lands and is then reported as having
    // failed, because the platform confirms through a command substitution and
    // a shell truncates one at the first NUL.
    const { call, close } = await connect({ computerId: 'vm-1' });
    const before = platform.calls.length;
    for (const text of ['', 'a\0b', 'x'.repeat(64 * 1024 + 1)]) {
      const res = await call('write_clipboard', { text });
      expect(res.isError, `write_clipboard accepted ${JSON.stringify(text.slice(0, 8))}`).toBe(
        true,
      );
    }
    expect(platform.calls.length).toBe(before);
    await close();
  });

  it('counts its cap in bytes, so an emoji costs four', async () => {
    // A `text.length` check would pass four times the legal payload to an
    // execve that answers E2BIG.
    const { call, close } = await connect({ computerId: 'vm-1' });
    expect(
      (await call('write_clipboard', { text: '\u{1F600}'.repeat(16 * 1024) })).isError,
    ).toBeFalsy();
    expect(
      (await call('write_clipboard', { text: '\u{1F600}'.repeat(16 * 1024 + 1) })).isError,
    ).toBe(true);
    await close();
  });

  it('refuses a read that came back with no text rather than saying "undefined"', async () => {
    // `String(undefined)` is a four-word clipboard nobody copied, and a model
    // handed it goes on to paste it.
    const { call, close } = await connect({ computerId: 'vm-1' });
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname.endsWith('/clipboard')) {
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }
      return real(input as never, init);
    }) as typeof fetch;
    const res = await call('read_clipboard', {});
    globalThis.fetch = real;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('no text in it');
    await close();
  });
});
