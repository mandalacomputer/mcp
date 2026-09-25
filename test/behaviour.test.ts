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

  it('offers the saved frame when a new capture is refused', async () => {
    // The default asks for a capture, and a capture needs a computer that is
    // awake — so on a suspended one the default is refused. A bare 409 leaves a
    // model with nothing to try but the same call again, and this tool has an
    // argument that asks a question the platform CAN answer: the last frame it
    // saved. The refusal is where a model meets the problem, so it is where the
    // option has to be named.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/screenshot')) {
        return Response.json(
          { error: 'computer is suspended; resume it to capture the screen' },
          {
            status: 409,
          },
        );
      }
      return real(input as never, init);
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('screenshot', { width: 1280 });
      await close();
      expect(res.isError).toBe(true);
      // The platform's own sentence survives — it is the half that says which
      // computer and what state it is in.
      expect(textOf(res)).toContain('resume it to capture the screen');
      expect(textOf(res)).toContain('fresh: false');
      // Offered as a fallback, not as a promise: `fresh: false` permits the
      // cache, it does not establish that anything is in it.
      expect(textOf(res)).toContain('fallback and not a guarantee');
      // And it does not pass that saved frame off as the present.
      expect(textOf(res)).toContain('not the screen now');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('and that fallback is one the platform actually answers', async () => {
    // The half a sentence cannot prove. A refusal naming a parameter is only
    // worth having if the call it names goes through, so the recovery is walked
    // rather than asserted: the refused capture, then the saved frame.
    let asked = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/screenshot')) {
        asked += 1;
        if (new URL(String(input)).searchParams.get('fresh') === '1') {
          return Response.json({ error: 'computer is suspended' }, { status: 409 });
        }
      }
      return real(input as never, init);
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      expect((await call('screenshot', {})).isError).toBe(true);
      const saved = await call('screenshot', { fresh: false });
      await close();
      expect(saved.isError).toBeFalsy();
      expect(saved.content.some((c) => c.type === 'image')).toBe(true);
      expect(asked).toBe(2);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('does not send a conflict that clears by itself off to a different parameter', async () => {
    // A busy agent and a sleeping computer refuse a capture identically here, and
    // this cannot tell them apart — so the platform's own classification has to
    // stay in front of the fallback. Sent to `fresh: false` instead, a caller
    // trades a refusal that clears by waiting for one that may not clear at all
    // (Codex review).
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/screenshot')) {
        return Response.json(
          { error: 'a capture is already running', reason: 'contention' },
          {
            status: 409,
          },
        );
      }
      return real(input as never, init);
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('screenshot', {});
      await close();
      expect(res.isError).toBe(true);
      // The platform's word still speaks, and it says to wait.
      expect(textOf(res)).toContain('worth sending again');
      // And the fallback is subordinate to it rather than the headline.
      expect(textOf(res)).toContain('Read the sentence above before anything else');
      // Nothing tells an awake computer to wake up.
      expect(textOf(res)).not.toContain('has to be awake');
      // And the retry is not promised to produce a picture. What the platform's
      // word establishes is that the thing in the way can finish — a computer
      // that turns out to be stopped when it does needs starting, and a sentence
      // saying waiting is the answer sends a caller round a loop instead
      // (Codex review).
      expect(textOf(res)).toContain('not a promise that the capture then works');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('leaves a refusal alone when the caller already asked for the saved frame', async () => {
    // Nothing left to offer: the option has been taken, so naming it again is
    // advice to do what the caller just did.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/screenshot')) {
        return Response.json({ error: 'no saved frame for this computer' }, { status: 409 });
      }
      return real(input as never, init);
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('screenshot', { fresh: false });
      await close();
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('no saved frame for this computer');
      expect(textOf(res)).not.toContain('fresh: false');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('shaped screenshots', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const lastShot = () => [...platform.calls].reverse().find((c) => c.path.endsWith('/screenshot'));

  it('sends a crop, a scale, an encoding and a quality as the platform spells them', async () => {
    const { call, close } = await connect();
    const res = await call('screenshot', {
      region: { x: 100, y: 50, width: 640, height: 400 },
      scale: 0.5,
      format: 'jpeg',
      quality: 60,
    });
    await close();
    expect(res.isError).toBeFalsy();
    const q = lastShot()?.query;
    expect(q?.get('region')).toBe('100,50,640,400');
    expect(q?.get('scale')).toBe('0.5');
    expect(q?.get('format')).toBe('jpeg');
    expect(q?.get('quality')).toBe('60');
    expect(q?.get('fresh')).toBe('1');
    // The picture is in its own pixel space and click takes screen pixels, so
    // the tool says how to get from one to the other, with the numbers.
    expect(textOf(res)).toContain('divide its position by 0.5, then add 100 to x and 50 to y');
  });

  it('turns a width over a region into the factor the platform applies', async () => {
    const { call, close } = await connect();
    const res = await call('screenshot', {
      region: { x: 0, y: 0, width: 800, height: 600 },
      width: 400,
    });
    await close();
    expect(lastShot()?.query.get('w')).toBe('400');
    expect(textOf(res)).toContain('scaled by 0.5');
  });

  it('says how to click in a crop that is not scaled', async () => {
    const { call, close } = await connect();
    const res = await call('screenshot', { region: { x: 10, y: 20, width: 30, height: 40 } });
    await close();
    expect(textOf(res)).toContain('add 10 to its x and 20 to its y');
  });

  it('sends none of them when none is asked for', async () => {
    const { call, close } = await connect();
    await call('screenshot', {});
    await close();
    const q = lastShot()?.query;
    for (const name of ['region', 'scale', 'format', 'quality']) expect(q?.has(name)).toBe(false);
  });

  it('refuses what the platform would refuse, before sending anything', async () => {
    const { call, close } = await connect();
    const sent = platform.calls.length;
    const both = await call('screenshot', { width: 320, scale: 0.5 });
    const pngQuality = await call('screenshot', { quality: 60 });
    const explicitPng = await call('screenshot', { format: 'png', width: 320, quality: 60 });
    const tooBig = await call('screenshot', { scale: 1.5 });
    const empty = await call('screenshot', { region: { x: 0, y: 0, width: 0, height: 5 } });
    await close();
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain('not both');
    expect(pngQuality.isError).toBe(true);
    expect(textOf(pngQuality)).toContain('format: jpeg');
    expect(explicitPng.isError).toBe(true);
    expect(tooBig.isError).toBe(true);
    expect(empty.isError).toBe(true);
    expect(platform.calls.length).toBe(sent);
  });

  it("names the way out of a suspended computer's refusal to shape its saved picture", async () => {
    // Only a width and format: jpeg are answered from a suspended computer's
    // saved JPEG. A crop asked for with fresh off is refused 409 unavailable,
    // and the ways out are to start the computer or drop the crop.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/screenshot')) {
        return Response.json(
          {
            error:
              'this computer is suspended and has only its saved desktop picture, which cannot be cropped, scaled or re-encoded; start it for a live screenshot',
            reason: 'unavailable',
          },
          { status: 409 },
        );
      }
      return real(input as never, init);
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('screenshot', {
        fresh: false,
        region: { x: 0, y: 0, width: 10, height: 10 },
        quality: 50,
        format: 'jpeg',
      });
      const fresh = await call('screenshot', { scale: 0.5 });
      await close();
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('cannot be cropped, scaled or re-encoded');
      expect(textOf(res)).toContain('start_computer');
      expect(textOf(res)).toContain('without region, quality');
      // With fresh on, fresh: false is still named, but not as enough by itself.
      expect(fresh.isError).toBe(true);
      expect(textOf(fresh)).toContain('fresh: false has to go without scale as well');
    } finally {
      globalThis.fetch = real;
    }
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

  it('offers overwrite in the write_file schema, defaulting to replace (OPL-4994)', async () => {
    const { client, close } = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'write_file');
    await close();
    expect(tool?.inputSchema.properties?.overwrite).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(tool?.inputSchema.required ?? []).not.toContain('overwrite');
    expect(tool?.description).toContain('overwrite: false');
  });

  it('sends overwrite=false only for a create-only write', async () => {
    const { call, close } = await connect();
    await call('write_file', { path: '/home/user/a.txt', content: 'x' });
    await call('write_file', { path: '/home/user/a.txt', content: 'x', overwrite: true });
    await call('write_file', { path: '/home/user/a.txt', content: 'x', overwrite: false });
    await close();
    const puts = platform.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.query.get('overwrite'))).toEqual([null, null, 'false']);
    expect(puts.every((c) => c.query.get('path') === '/home/user/a.txt')).toBe(true);
  });

  it('says plainly that a create-only path is taken, and not to send it again', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/files') && init?.method === 'PUT') {
        return Response.json(
          { error: 'a file already exists at /home/user/a.txt', reason: 'exists' },
          { status: 409 },
        );
      }
      return real(input as never, init);
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('write_file', {
        path: '/home/user/a.txt',
        content: 'x',
        overwrite: false,
      });
      await close();
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('a file already exists at /home/user/a.txt');
      expect(textOf(res)).toContain('this attempt wrote nothing');
      expect(textOf(res)).toContain('do not send the same call again');
      expect(textOf(res)).toContain('overwrite: true');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('does not tell a retry after a lost answer that nothing of its own landed', async () => {
    // Codex review: the first create-only write lands and its answer is lost, so
    // the retry meets 409 exists on the caller's OWN file. Saying "nothing was
    // written, use another path or overwrite" would send the model away from a
    // file it already wrote, or have it replace it blind.
    let puts = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/files') && init?.method === 'PUT') {
        puts += 1;
        if (puts === 1) throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
        return Response.json(
          { error: 'a file already exists at /home/user/a.txt', reason: 'exists' },
          { status: 409 },
        );
      }
      return real(input as never, init);
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const args = { path: '/home/user/a.txt', content: 'x', overwrite: false };
      expect((await call('write_file', args)).isError).toBe(true);
      const retry = await call('write_file', args);
      await close();
      expect(puts).toBe(2);
      expect(retry.isError).toBe(true);
      const said = textOf(retry);
      expect(said).not.toContain('nothing was written');
      expect(said).toContain('this attempt wrote nothing');
      expect(said).toContain(
        'If an earlier attempt\u2019s outcome was unknown, the file may be yours: read it and compare ' +
          'before choosing another path or overwriting.',
      );
    } finally {
      globalThis.fetch = real;
    }
  });

  it.each([
    ['empty', () => new Response('', { status: 409 })],
    ['not JSON', () => new Response('<html>conflict</html>', { status: 409 })],
    ['JSON with no reason', () => Response.json({ error: 'conflict' }, { status: 409 })],
    ['JSON with a numeric reason', () => Response.json({ reason: 5 }, { status: 409 })],
    ['JSON with a blank reason', () => Response.json({ reason: ' ' }, { status: 409 })],
    ['empty JSON object', () => Response.json({}, { status: 409 })],
    [
      'JSON whose error text claims existence',
      () => Response.json({ error: 'a file already exists at that path' }, { status: 409 }),
    ],
  ])('does not call a create-only 409 with an %s body worth resending', async (_kind, answer) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/files') && init?.method === 'PUT') return answer();
      return real(input as never, init);
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('write_file', {
        path: '/home/user/a.txt',
        content: 'x',
        overwrite: false,
      });
      await close();
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('refused as a conflict, reason unknown');
      expect(textOf(res)).toContain('Do not send the same call again');
      // Not even for JSON: without the platform's word the write may have landed.
      expect(textOf(res)).not.toContain('wrote nothing');
      expect(textOf(res)).toContain('whether this attempt wrote anything is unconfirmed');
      expect(textOf(res)).not.toContain('already exists');
      expect(textOf(res)).not.toContain('Something is already at');
    } finally {
      globalThis.fetch = real;
    }
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

  it('does not suggest replaying a command that timed out but is still running', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ exit_code: -1, timed_out: true, stdout: '' }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const { call, close } = await connect();
    const res = await call('exec', { command: 'sleep 600' });
    await close();

    const answer = textOf(res);
    expect(answer).toContain('TIMED OUT');
    expect(answer).toContain('still running');
    expect(answer).not.toMatch(/re-?run with background/i);
    expect(answer).toMatch(/rerun.+recover.+output/i);
    expect(answer).toMatch(/repeat.+effects|effects.+repeat/i);
    expect(answer).toMatch(/inspect.+process.+effects/i);
    expect(answer).toMatch(/future.+background/i);
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

  it('refuses half a character rather than pasting a replacement for it', async () => {
    // The one refusal here that is NOT the platform's, and the reason it has to
    // be this server's: nothing downstream objects. JSON.stringify escapes the
    // lone code unit, Go decodes it to U+FFFD, and the desktop ends up holding a
    // replacement character where the caller's text was — a write that succeeds
    // with text nobody sent. A lone surrogate is what a string cut through the
    // middle of an emoji is made of, which is not an exotic way to arrive here.
    const { call, close } = await connect({ computerId: 'vm-1' });
    const before = platform.calls.length;
    // A high surrogate, a low one, and one of each in the wrong order — the
    // last because a pair is only a pair in that order, and a scan that tested
    // membership rather than sequence would call it well-formed.
    for (const text of ['\ud800', 'a\udc00b', '\udfff\ud800']) {
      const res = await call('write_clipboard', { text });
      expect(res.isError, `write_clipboard accepted ${JSON.stringify(text)}`).toBe(true);
      expect(textOf(res)).toMatch(/unpaired surrogate/);
    }
    expect(platform.calls.length).toBe(before);
    // And the pair those halves come from still goes through: refusing the
    // whole emoji would be the same defect from the other side.
    expect((await call('write_clipboard', { text: '😀' })).isError).toBeFalsy();
    expect(platform.calls.at(-1)?.body).toEqual({ text: '\u{1F600}' });
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
