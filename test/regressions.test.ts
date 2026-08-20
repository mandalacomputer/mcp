import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api, filenameFrom, PLATFORM_HEADERS_TIMEOUT_MS } from '../src/api.js';
import {
  isEntrypoint,
  lifecycleEnabled,
  parse,
  port,
  str,
  wantsHelp,
  wantsVersion,
} from '../src/cli.js';
import {
  CancelledError,
  ConnectivityError,
  errorForStatus,
  GatewayTimeoutError,
  OriginResponseError,
  OriginUnreachableError,
  isTransient,
  OriginUnreachableError,
} from '../src/errors.js';
import { failed, MAX_INLINE_IMAGE_BYTES, unwrapComputer } from '../src/format.js';
import {
  CancelledError as PublicCancelledError,
  ConnectivityError as PublicConnectivityError,
  OriginUnreachableError as PublicOriginUnreachableError,
} from '../src/index.js';
import * as P from '../src/paths.js';
import { windowBody } from '../src/paths.js';
import { SERVER_VERSION } from '../src/server.js';
import { BASE, connect, installFakePlatform } from './harness.js';

/** Everything a tool said, as one string. */
const said = (res: CallToolResult) =>
  res.content.map((c) => ('text' in c ? c.text : '')).join('\n');

// --- latest adversarial review -------------------------------------------

describe('platform response deadlines', () => {
  it("gives a 300-second exec slack beyond undici's old 300-second header race", async () => {
    const real = globalThis.fetch;
    let dispatcher: unknown;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      dispatcher = (init as RequestInit & { dispatcher?: unknown })?.dispatcher;
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      await new Api('com_test', BASE).json('GET', 'computers');
      expect(PLATFORM_HEADERS_TIMEOUT_MS).toBeGreaterThan(300_000);
      expect(dispatcher).toBeTruthy();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('capped download truthfulness', () => {
  it('does not call a short EOF truncated merely because Content-Length claimed more', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'text/plain', 'Content-Length': '100' },
      })) as typeof fetch;
    try {
      const file = await new Api('com_test', BASE).bytes('GET', 'files', {}, 5);
      expect([...file.bytes]).toEqual([1, 2, 3]);
      expect(file.truncated).toBe(false);
      expect(file.totalBytes).toBe(3);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('agent stream media types and payloads', () => {
  it('names a successful non-SSE response as a content-type mismatch', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<html>sign in</html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })) as typeof fetch;
    try {
      const consume = async () => {
        for await (const _event of new Api('com_test', BASE).sse('POST', 'agent')) {
          // The content type is rejected before any event can be read.
        }
      };
      await expect(consume()).rejects.toThrow(/expected text\/event-stream.*text\/html/i);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('skips null step and done events without aborting a later valid result', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        'event: step\ndata: null\n\n' +
          'event: done\ndata: null\n\n' +
          'event: step\ndata: {"n":1,"detail":"clicked"}\n\n' +
          'event: done\ndata: {"stop":"end_turn","text":"Done"}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch;
    try {
      const { call, close } = await connect({ modelKey: 'sk-test' });
      const res = await call('run_agent', { prompt: 'finish' });
      expect(res.isError).toBeFalsy();
      expect(said(res)).toMatch(/finished/);
      expect(said(res)).toMatch(/clicked/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('explicit lifecycle flags', () => {
  it('lets --no-lifecycle=false override a disabling environment value', () => {
    expect(lifecycleEnabled(parse(['--no-lifecycle=false']), '1')).toBe(true);
    expect(lifecycleEnabled(parse([]), '1')).toBe(false);
    expect(lifecycleEnabled(parse(['--no-lifecycle']), undefined)).toBe(false);
  });
});

describe('empty image files', () => {
  it('refuses zero bytes instead of emitting invalid MCP image content', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(), {
        headers: { 'Content-Type': 'image/png' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('read_file', { path: '/tmp/empty.png' });
      expect(res.isError).toBe(true);
      expect(res.content.some((item) => item.type === 'image')).toBe(false);
      expect(said(res)).toMatch(/empty image\/png/i);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('wait deadlines under wall-clock changes', () => {
  it('stops on its monotonic timeout even when Date.now moves backward', async () => {
    const realFetch = globalThis.fetch;
    const realNow = Date.now;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener('abort', fail, { once: true });
      })) as typeof fetch;
    Date.now = () => 1;
    try {
      const { call, close } = await connect();
      const res = await call('wait_for_computer', { timeout_s: 5 });
      expect(res.isError).toBe(true);
      expect(said(res)).toMatch(/Gave up after 5s/);
      await close();
    } finally {
      Date.now = realNow;
      globalThis.fetch = realFetch;
    }
  }, 15_000);
});

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

  it('rejects unknown long flags instead of silently ignoring them', () => {
    expect(() => parse(['--computer-id', 'vm-1'])).toThrow(/unknown flag.*--computer-id/i);
    expect(() => parse(['--api-key=com_test'])).toThrow(/unknown flag.*--api-key/i);
    expect(() => parse(['--api-key=com_test'])).toThrow(/--computer.*--key/);
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

  it('does not forward geometry that belongs to another action', () => {
    expect(windowBody({ action: 'close', x: 5, y: 6, width: 7, height: 8 })).toEqual({
      action: 'close',
    });
    expect(windowBody({ action: 'move', x: 5, y: 6, width: 7, height: 8 })).toEqual({
      action: 'move',
      x: 5,
      y: 6,
    });
    expect(windowBody({ action: 'resize', x: 5, y: 6, width: 7 })).toEqual({
      action: 'resize',
      width: 7,
    });
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

  it('rejects JSON null on a route that must answer', async () => {
    globalThis.fetch = (async () =>
      new Response('null', { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const api = new Api('com_test', BASE);
    await expect(api.json('GET', 'computers/vm-1')).rejects.toThrow(/JSON null/);
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

describe('the guard that decides this file is the program', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-entry-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('recognises the module when argv[1] is a symlink to it', () => {
    // How the published binary is always started: npm writes
    // node_modules/.bin/mandala-computer-mcp as a symlink to dist/cli.js, Node
    // resolves the ESM entry through it and leaves argv[1] as the link. The
    // raw URL comparison never matched, so the installed command exited 0
    // having started no server and said nothing.
    const real = join(dir, 'cli.js');
    const link = join(dir, 'mandala-computer-mcp');
    writeFileSync(real, '');
    symlinkSync(real, link);

    // What Node puts in import.meta.url: the module path with every symlink
    // resolved, which on macOS includes /var itself.
    const moduleUrl = pathToFileURL(realpathSync(real)).href;
    expect(isEntrypoint(moduleUrl, link)).toBe(true);
    expect(isEntrypoint(moduleUrl, real)).toBe(true);
  });

  it('still says no to an import, and to an argv[1] that is not there', () => {
    const real = join(dir, 'cli.js');
    writeFileSync(real, '');
    const moduleUrl = pathToFileURL(realpathSync(real)).href;
    expect(isEntrypoint(pathToFileURL(join(realpathSync(dir), 'other.js')).href, real)).toBe(false);
    expect(isEntrypoint(moduleUrl, undefined)).toBe(false);
    expect(isEntrypoint(moduleUrl, join(dir, 'gone.js'))).toBe(false);
  });
});

describe('a 204 from a route a tool calls', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('never leaves cursor_position emitting text: undefined', async () => {
    // The shared input `post` was moved to `send`, which may resolve to
    // undefined — and `JSON.stringify(undefined)` is undefined, not a string,
    // which is the invalid content the json/send split existed to abolish. A
    // route that must answer says so, and its silence is reported as a failure
    // that names the route.
    const { call, close } = await connect();
    const res = await call('cursor_position');
    for (const c of res.content) if (c.type === 'text') expect(typeof c.text).toBe('string');
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => ('text' in c ? c.text : '')).join('\n')).toMatch(/empty body/);
    await close();
  });

  it('is how a DELETE ordinarily answers, so exec_kill reports the kill', async () => {
    // `json` on the DELETE turned a kill that had in fact worked into an
    // error, sending the model back at a pid that no longer existed.
    const { call, close } = await connect();
    const res = await call('exec_kill', { pid: 4242 });
    expect(res.isError).toBeFalsy();
    expect(res.content.map((c) => ('text' in c ? c.text : '')).join('\n')).toContain(
      'Killed pid 4242',
    );
    await close();
  });
});

// --- round three ----------------------------------------------------------
//
// The same rule as everything above: one test per bug that passed review,
// shipped, and was wrong anyway. The comment says what the code used to do.

describe('an id that is not an id', () => {
  it('refuses a dot segment instead of encoding it into a different route', () => {
    // `encodeURIComponent` leaves `.` alone, so `..` survived it byte for byte
    // and `new URL` then resolved the segment away: `computers/../exec` became
    // `/api/v1/exec` — a route the tool never asked for, reached with the
    // caller's key.
    expect(() => P.computer('..')).toThrow(/must not be/);
    expect(() => P.computer('.')).toThrow(/must not be/);
    expect(() => P.computer('  ')).toThrow(/must not be empty/);
    expect(() => P.computer('a/b')).toThrow(/slash/);
    expect(() => P.snapshot('..')).toThrow(/must not be/);
    expect(() => P.window_('vm-1', '..')).toThrow(/must not be/);
  });

  it('normalises to nothing once the refusal is in place', () => {
    // The property that made it a bug, pinned: this path, resolved against the
    // base URL, is not the path it looks like.
    expect(new URL(`${BASE}/computers/../exec`).pathname).toBe('/api/v1/exec');
  });

  it('leaves an ordinary id alone', () => {
    expect(P.computer('vm-1')).toBe('computers/vm-1');
    expect(P.computerAction('vm-1', 'exec')).toBe('computers/vm-1/exec');
    expect(P.snapshot('snap-1')).toBe('snapshots/snap-1');
    // Still encoded, just checked first.
    expect(P.computer('a b')).toBe('computers/a%20b');
  });
});

describe('a flag given without a value', () => {
  it('is refused by name rather than cast to a string', () => {
    // `parse` yields the boolean `true` for a valueless flag, and every one of
    // these was `as string`. `--key` bare reached the platform as
    // `Authorization: Bearer true`; `--base-url` bare threw a TypeError from
    // inside String.prototype.replace naming neither the flag nor the mistake.
    expect(() => str(true, 'key')).toThrow(/--key needs a value/);
    expect(() => str(true, 'base-url')).toThrow(/--base-url needs a value/);
    expect(str('com_abc', 'key')).toBe('com_abc');
    expect(str(undefined, 'key')).toBeUndefined();
  });
});

describe('PORT set to an empty string', () => {
  const saved = process.env.PORT;
  afterEach(() => {
    if (saved === undefined) delete process.env.PORT;
    else process.env.PORT = saved;
  });

  it('falls through to the default instead of binding a random port', () => {
    // `??` only skips null and undefined, so a set-but-empty PORT passed it
    // intact — and `Number('')` is 0, which passes every range check and means
    // "any free port". A server asked for 3000 bound something random.
    process.env.PORT = '';
    expect(port(undefined)).toBe(3000);
    process.env.PORT = '  ';
    expect(port(undefined)).toBe(3000);
    process.env.PORT = '8080';
    expect(port(undefined)).toBe(8080);
    // 0 still means "any free port" when it is asked for on purpose.
    expect(port('0')).toBe(0);
  });
});

describe('the version a user quotes in a bug report', () => {
  it('is the one the server reports over the protocol', () => {
    // Printed from a literal in cli.ts, a second in server.ts and a third in
    // package.json. Three copies drift silently, and --version is the one that
    // must never lie.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});

describe('a Content-Disposition this server did not expect', () => {
  it('reads a filename* in any charset, not only UTF-8', () => {
    // Matching only the UTF-8 spelling meant an ISO-8859-1 filename was read
    // by neither branch — the plain form cannot match it, since there is no
    // `filename=` in it — so a download the platform had named arrived unnamed.
    expect(filenameFrom("attachment; filename*=ISO-8859-1''report.txt")).toBe('report.txt');
    expect(filenameFrom("attachment; filename*=ISO-8859-1''a%20b.txt")).toBe('a b.txt');
    // A byte that is not valid UTF-8 keeps its raw spelling rather than
    // throwing — a download whose bytes arrived intact is not a failure over
    // the label on it. What matters is that it is no longer `undefined`.
    expect(filenameFrom("attachment; filename*=ISO-8859-1''caf%E9.txt")).toBe('caf%E9.txt');
    expect(filenameFrom("attachment; filename*=UTF-8''a%20b.txt")).toBe('a b.txt');
    expect(filenameFrom('attachment; filename="plain.txt"')).toBe('plain.txt');
    expect(filenameFrom(null)).toBeUndefined();
  });
});

describe('bodies the platform is not supposed to send', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  const answer = (v: unknown, headers: Record<string, string> = {}) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(v), {
        headers: { 'Content-Type': 'application/json', ...headers },
      })) as typeof fetch;
  };

  it('does not read a listing that is not a list as an empty account', async () => {
    // `listing<unknown[]>` is a claim, not a guarantee. An object body made
    // `list.length` undefined, which read as "no computers on this account
    // yet, create one" — the duplicate-create the partial-listing logic exists
    // to prevent, arrived at from the other side.
    answer({ items: [], next: null });
    const { call, close } = await connect();
    const res = await call('list_computers');
    expect(res.isError).toBe(true);
    expect(said(res)).not.toMatch(/No computers on this account yet/);
    await close();
  });

  it('does not report a create with no id as selected', async () => {
    // The bind was conditional on `c.id` and the sentence was not, so a
    // response without one left the session pointing at whatever it held
    // before while claiming the new machine was selected.
    answer({ name: 'desk', status: 'running' });
    const { call, close } = await connect();
    const res = await call('create_computer', { name: 'desk' });
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/no id/i);
    await close();
  });

  it('does not tell the model to poll a pid it was never given', async () => {
    // "Started as pid undefined. Read its output with exec_poll" — an
    // instruction that cannot be followed, reported as a success, over a
    // command that is still running in the guest.
    answer({ started: true });
    const { call, close } = await connect();
    const res = await call('exec', { command: 'sleep 60', background: true });
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/no pid/i);
    await close();
  });

  it('does not render a null exit code as the word null', async () => {
    // `!== undefined` admits null, which is the natural JSON encoding of "no
    // exit code yet" for a command that was killed or timed out.
    answer({ running: false, exit_code: null, timed_out: true });
    const { call, close } = await connect();
    const res = await call('exec', { command: 'true' });
    expect(said(res)).not.toMatch(/exit null/);
    await close();
  });

  it('keeps the parameters off an image mimeType', async () => {
    // The raw Content-Type went through as MCP image content's mimeType, which
    // takes a media type — a client matching on `image/png` renders nothing
    // for `image/png; charset=binary`.
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'image/png; charset=binary' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('screenshot');
    const img = res.content.find((c) => c.type === 'image');
    expect(img && 'mimeType' in img ? img.mimeType : undefined).toBe('image/png');
    await close();
  });

  it('refuses a screenshot too large to put in a context', async () => {
    // read_file enforced this bound and screenshot walked straight past it, so
    // the cap sat on the smaller of the two paths that produce an image.
    let pulls = 0;
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            if (pulls > 200) return controller.close();
            controller.enqueue(new Uint8Array(64 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'image/png' } },
      )) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('screenshot');
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    expect(said(res)).toMatch(/width/);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(200);
    await close();
  });
});

describe('a wait that never reached what it waited for', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('says isError on a build that failed', async () => {
    // Reported with `said`, so a caller reading isError could not tell a build
    // that will never resolve from a guest that answered. The file's own
    // `cancelled` helper had said why that was wrong since the beginning.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'vm-1', status: 'build-failed', build: { source: 'x' } }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('wait_for_computer', { until: 'running', timeout_s: 5 });
    expect(res.isError).toBe(true);
    await close();
  });

  it('says isError when the deadline passes', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'vm-1', status: 'starting' }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('wait_for_computer', { until: 'running', timeout_s: 5 });
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/Gave up/);
    await close();
    // The floor on timeout_s is 5s and the loop sleeps 2s between polls, so
    // this one genuinely takes longer than the default per-test budget.
  }, 15_000);
});

describe('a desktop link request that produced no link', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('says isError rather than reporting the absence as a success', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'vm-1', status: 'stopped' }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('get_desktop_url');
    expect(res.isError).toBe(true);
    await close();
  });
});

describe('an event stream with no boundary in it', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('is given up on rather than buffered forever', async () => {
    // The trim only runs when the separator matches, so a stream that never
    // sends a blank line was appended to until the process ran out of memory.
    const chunk = new TextEncoder().encode('data: '.concat('x'.repeat(1024 * 1024)));
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch;
    const api = new Api('com_test', BASE);
    await expect(async () => {
      for await (const _ of api.sse('POST', 'computers/vm-1/agent')) {
        // The stream never yields an event; the bound is what ends this.
      }
    }).rejects.toThrow(/no event boundary/);
  });

  it('still strips exactly the one leading space the spec strips', async () => {
    // `trimStart()` took every leading space and tab. Whitespace inside a data
    // field is payload the moment an event carries text rather than JSON.
    globalThis.fetch = (async () =>
      new Response('event: step\ndata:   two spaces kept\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch;
    const api = new Api('com_test', BASE);
    const seen = [];
    for await (const ev of api.sse('POST', 'computers/vm-1/agent')) seen.push(ev);
    expect(seen).toEqual([{ event: 'step', data: '  two spaces kept' }]);
  });
});

// --- round four -----------------------------------------------------------

describe('a Content-Disposition with a language tag', () => {
  it('reads the filename out of one', () => {
    // RFC 5987 writes the value as charset, language, then text, and the
    // language is ordinarily empty — so a regex demanding the two apostrophes
    // be adjacent matched only that ordinary case. `UTF-8'en'report.pdf` is as
    // legal as `UTF-8''report.pdf` and was read by neither branch, which is
    // the same unnamed download the last round set out to fix.
    expect(filenameFrom("attachment; filename*=UTF-8'en'report.pdf")).toBe('report.pdf');
    expect(filenameFrom("attachment; filename*=ISO-8859-1'de'a%20b.txt")).toBe('a b.txt');
    // And the empty-language form still works, since that is what the platform
    // actually sends.
    expect(filenameFrom("attachment; filename*=UTF-8''hello%20world.txt")).toBe('hello world.txt');
  });
});

describe('a listing the platform answered with no body at all', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  /** A 200 with nothing in it — what a gateway answers when it has nothing. */
  const empty = () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
  };

  it('does not read it as an empty account', async () => {
    // `items ?? []` covered the null and object shapes and left this one: an
    // absent body decodes to undefined, skips a guard written as
    // `items !== undefined && !Array.isArray(items)`, and comes out as "No
    // computers on this account yet" — the duplicate-create that guard exists
    // to prevent, reached through the one door it did not close.
    empty();
    const { call, close } = await connect();
    const res = await call('list_computers');
    expect(res.isError).toBe(true);
    expect(said(res)).not.toMatch(/No computers on this account yet/);
    await close();
  });

  it('does not read it as a computer with no snapshots', async () => {
    // Same decode, one file over, and one consequence milder: nothing is
    // created off it, but "0 snapshot(s)" is still a confident statement about
    // an inventory that never arrived.
    empty();
    const { call, close } = await connect();
    const res = await call('list_snapshots', { computer_id: 'vm-1' });
    expect(res.isError).toBe(true);
    expect(said(res)).not.toMatch(/^0 snapshot/m);
    await close();
  });
});

describe('a fourth adversarial review', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('says isError when read_file refuses an oversized image', async () => {
    // The image branch answered with a plain `text()`. Nothing was delivered —
    // the file never entered the conversation — but without `isError` a caller
    // reading it to decide whether the read worked saw a refusal and a file as
    // the same answer. `screenshot` used `refused` for the identical condition.
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1), {
        headers: { 'Content-Type': 'image/png' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/tmp/big image&.png' });
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/inline limit/);
    expect(said(res)).toContain("convert '/tmp/big image&.png'");
    await close();
  });

  it('does not hand back a non-image as a screenshot', async () => {
    // A captive portal or a misconfigured proxy answering 200 with an HTML page
    // was passed straight through to `image()`, which typed it `text/html` and
    // called it a picture. The model got something that would not decode and
    // nothing saying why.
    globalThis.fetch = (async () =>
      new Response('<html>sign in to continue</html>', {
        headers: { 'Content-Type': 'text/html' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('screenshot');
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    expect(said(res)).toMatch(/text\/html/);
    await close();
  });

  it('does not hand back an empty image as a screenshot', async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(), {
        headers: { 'Content-Type': 'image/png' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('screenshot');
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    expect(said(res)).toMatch(/empty/i);
    await close();
  });

  it('does not print what a build came from as the reason it failed', async () => {
    // `Build failed: ${c.build?.source}` put the image the machine was built
    // from in the grammatical position of a cause, so the model was told a
    // template name when it asked what went wrong.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'vm-1',
          status: 'build-failed',
          build: { source: 'ubuntu-22.04' },
          start_error: 'no capacity in region',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('wait_for_computer', { computer_id: 'vm-1', timeout_s: 5 });
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/no capacity in region/);
    expect(said(res)).not.toMatch(/Build failed: ubuntu-22\.04/);
    await close();
  });

  it('binds the id the platform echoed back, not the one that was typed', async () => {
    // `use_computer` stored the caller's string. `P.segment` trims before the
    // call, so " vm-1 " reached the API as vm-1 and worked — but `unbind`
    // compares with `===`, so deleting vm-1 left the session pointed at a
    // machine that no longer exists.
    const platform = installFakePlatform();
    const { call, close } = await connect({ computerId: undefined });
    const bound = await call('use_computer', { computer_id: ' vm-1 ' });
    expect(bound.isError, 'the binding call itself failed').toBeFalsy();
    const gone = await call('delete_computer', { computer_id: 'vm-1', confirm: true });
    expect(gone.isError, 'the delete itself failed').toBeFalsy();
    // The binding has to be gone with it. Left in place, the next call drives a
    // machine that no longer exists.
    const res = await call('screenshot');
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/use_computer|no computer/i);
    await close();
    platform.restore();
  });
});

describe('flags that are a yes-or-no', () => {
  it('does not let a boolean flag eat the next argument', () => {
    // Every flag consumed the following token, so `--http false` set `http` to
    // the string "false" — truthy — and started the server the user had just
    // said they did not want. `--no-lifecycle false` withheld the lifecycle
    // tools for the same reason.
    expect(parse(['--http', 'false'])).toEqual({ http: true });
    expect(parse(['--no-lifecycle', '0'])).toEqual({ 'no-lifecycle': true });
    expect(parse(['--http', '--port', '3000'])).toEqual({ http: true, port: '3000' });
  });

  it('reads an explicit --flag=false as false', () => {
    expect(parse(['--http=false'])).toEqual({ http: false });
    expect(parse(['--http=off'])).toEqual({ http: false });
    expect(parse(['--http=true'])).toEqual({ http: true });
  });

  it('still lets a value flag take its value', () => {
    expect(parse(['--port', '3000'])).toEqual({ port: '3000' });
    expect(parse(['--key', 'com_a'])).toEqual({ key: 'com_a' });
  });

  it('answers the short forms every CLI is expected to answer', () => {
    // `parse` skipped anything without a `--`, so `-h` fell through to a normal
    // startup and exited 2 with "No API key" — the one message least like the
    // help that was asked for.
    expect(parse(['-h'])).toEqual({ help: true });
    expect(parse(['-v'])).toEqual({ version: true });
  });
});

describe('a call nobody is waiting for any more', () => {
  it('does not report a cancellation as the platform being unreachable', async () => {
    // Every fetch failure was wrapped as `could not reach <base>`, including an
    // abort. So a client that hung up — which its own 60s request timeout makes
    // routine — was told the platform was down, a failure it retries, about a
    // call it had itself stopped caring about.
    const real = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      // What undici raises for an aborted request: no mention of the signal, no
      // status, nothing the old wrap could have told apart from a DNS failure.
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      void init;
      throw err;
    }) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const api = new Api('com_test', BASE, controller.signal);
    await expect(api.json('GET', 'computers')).rejects.toMatchObject({
      name: 'CancelledError',
    });
    await expect(api.json('GET', 'computers')).rejects.toThrow(/cancelled/i);
    await expect(api.json('GET', 'computers')).rejects.not.toThrow(/could not reach/);
    globalThis.fetch = real;
  });

  it('still calls a real connectivity failure what it is', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const api = new Api('com_test', BASE);
    await expect(api.json('GET', 'computers')).rejects.toThrow(/could not reach/);
    globalThis.fetch = real;
  });

  it('does not report a stalled guest probe as a platform outage', async () => {
    // The status read checked the signal before judging the error and the guest
    // probe below it did not — it asked `isTransient` alone, and a cancelled
    // fetch is not transient, so it threw. Half the loop knew and half did not.
    // Here the status read answers `running` and the probe never comes back, so
    // the probe is what the wait's own deadline lands on.
    const real = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname.endsWith('/exec')) {
        return new Promise((_resolve, reject) => {
          const fail = () => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (init?.signal?.aborted) return fail();
          init?.signal?.addEventListener('abort', fail, { once: true });
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'vm-1', status: 'running' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('wait_for_computer', {
      computer_id: 'vm-1',
      until: 'guest',
      timeout_s: 5,
    });
    expect(res.isError).toBe(true);
    // The give-up message, naming what was in flight — not the connectivity
    // failure the old catch turned this into.
    expect(said(res)).toMatch(/Gave up after 5s/);
    expect(said(res)).not.toMatch(/could not reach/);
    await close();
    globalThis.fetch = real;
  }, 30_000);
});

describe('a wait that means the deadline it was given', () => {
  it('bounds the request in flight, not only the next one', async () => {
    // timeout_s gated the top of the loop and nothing else, so a single poll
    // that never answered held a wait told to give up in five seconds for as
    // long as the connection stayed open — up to undici's own five-minute
    // header timeout, on a tool whose entire contract is coming back when it
    // said it would.
    const real = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      void input;
      // Never answers, and resolves only when the request is aborted.
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const fail = () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal?.aborted) return fail();
        signal?.addEventListener('abort', fail, { once: true });
      });
    }) as typeof fetch;
    const { call, close } = await connect();
    const started = Date.now();
    const res = await call('wait_for_computer', { computer_id: 'vm-1', timeout_s: 5 });
    const elapsed = Date.now() - started;
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/Gave up after 5s/);
    // Comfortably inside undici's 300s header timeout, which is what bounded
    // this before.
    expect(elapsed).toBeLessThan(20_000);
    await close();
    globalThis.fetch = real;
  }, 30_000);
});

describe('a base URL that carries a query', () => {
  it('joins the path onto the path, not into the search string', async () => {
    // `${base}/${path}` put the route inside the query: a base of
    // `https://h/api/v1?tenant=x` produced `https://h/api/v1?tenant=x/computers`
    // — a request to /api/v1 carrying a nonsense parameter, not to /computers.
    const real = globalThis.fetch;
    let seen = '';
    globalThis.fetch = ((input: string | URL | Request) => {
      seen = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(
        new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
      );
    }) as typeof fetch;
    await new Api('com_test', 'https://h/api/v1?tenant=x').json('GET', 'computers');
    globalThis.fetch = real;
    const url = new URL(seen);
    expect(url.pathname).toBe('/api/v1/computers');
    // The base's own parameters are part of how it was addressed, so they stay.
    expect(url.searchParams.get('tenant')).toBe('x');
  });

  it('refuses a base URL whose scheme is not the one the message promises', () => {
    expect(() => new Api('com_test', 'file:///etc/passwd')).toThrow(/http\(s\)/);
    expect(() => new Api('com_test', 'ftp://h/api')).toThrow(/http\(s\)/);
    expect(() => new Api('com_test', 'https://h/api')).not.toThrow();
  });
});

describe('ids that differ only in whitespace', () => {
  it('unbinds a startup computer that a model names without the padding', async () => {
    // MANDALA_COMPUTER_ID was stored exactly as the environment gave it, and a
    // .env file or a --env-file leaves a newline on it. `P.segment` trims before
    // the call, so the padded id drove the right machine; `unbind` compares with
    // `===`, so no id a model could type ever cleared it, and the session went
    // on driving a computer that had been deleted.
    const platform = installFakePlatform();
    const { call, close } = await connect({ computerId: ' vm-1\n' });
    const gone = await call('delete_computer', { computer_id: 'vm-1', confirm: true });
    expect(gone.isError, 'the delete itself failed').toBeFalsy();
    const res = await call('screenshot');
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/use_computer|no computer/i);
    await close();
    platform.restore();
  });

  it('treats a startup id that is only whitespace as no id at all', async () => {
    const platform = installFakePlatform();
    const { call, close } = await connect({ computerId: '  ' });
    const res = await call('screenshot');
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/use_computer|no computer/i);
    await close();
    platform.restore();
  });

  it('keeps the screen size when a call names the bound computer with padding', async () => {
    // noteResolution compared the same way, so naming the bound machine with a
    // space around it dropped the resolution instead of recording it — and the
    // resolution is the coordinate space every click is measured in.
    const platform = installFakePlatform();
    const { call, close } = await connect({ computerId: 'vm-1' });
    await call('get_computer', { computer_id: ' vm-1 ' });
    // The screenshot prints the bound machine's geometry, and only ever the
    // bound machine's — so this is where a dropped resolution shows.
    const shot = await call('screenshot');
    expect(shot.isError).toBeFalsy();
    expect(JSON.stringify(shot.content)).toMatch(/Screen is 1280x800x24/);
    await close();
    platform.restore();
  });
});

describe('the tools an operator turned off', () => {
  it('withholds clone_snapshot with the rest of the lifecycle', async () => {
    // clone_snapshot mints a billable computer and binds it, exactly as
    // create_computer and clone_computer do — but it was registered above the
    // gate, so MANDALA_NO_LIFECYCLE withheld every way of making a computer
    // except this one.
    const { client, close } = await connect({ lifecycle: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('clone_snapshot');
    expect(names).not.toContain('create_computer');
    expect(names).not.toContain('clone_computer');
    expect(names).not.toContain('delete_computer');
    expect(names).not.toContain('delete_snapshot');
    // The reads either side of it are untouched.
    expect(names).toContain('list_snapshots');
    expect(names).toContain('restore_snapshot');
    await close();
  });

  it('offers it when the lifecycle is on', async () => {
    const { client, close } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('clone_snapshot');
    await close();
  });
});

describe('annotations a client acts on', () => {
  it('does not call a consuming cursor read-only', async () => {
    // exec_poll advances a cursor in the guest: the bytes it returns are bytes
    // no later poll can return. readOnlyHint invites a client to call it without
    // asking and to retry one that timed out, and a retried poll silently drops
    // whatever the first attempt had already consumed.
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    const poll = tools.find((t) => t.name === 'exec_poll');
    expect(poll?.annotations?.readOnlyHint).toBeFalsy();
    // The genuinely read-only neighbours keep the hint.
    expect(tools.find((t) => t.name === 'list_computers')?.annotations?.readOnlyHint).toBe(true);
    await close();
  });
});

describe('flags and the environment they override', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads --flag= as an empty value rather than as not given', () => {
    // `flag || undefined` folded an explicit empty back into "not given", so the
    // environment answered — the opposite of the usage text's promise that flags
    // override it.
    expect(str('', 'key')).toBe('');
    expect(str(undefined, 'key')).toBeUndefined();
    expect(str('com_a', 'key')).toBe('com_a');
  });

  it('trims a value that came through a shell with a newline on it', () => {
    expect(str(' com_a\n', 'key')).toBe('com_a');
  });

  it('prints the version for --v as well as -v and --version', () => {
    // `v` is in BOOLEAN, so `--v` set a flag nothing read and the server started
    // instead of printing a number. `--h` was already handled and `--v` was not,
    // which made the pair inconsistent in the direction nobody checks.
    expect(parse(['--v'])).toEqual({ v: true });
    expect(wantsVersion(parse(['--v']))).toBe(true);
    expect(wantsVersion(parse(['-v']))).toBe(true);
    expect(wantsVersion(parse(['--version']))).toBe(true);
    expect(wantsVersion(parse(['--http']))).toBe(false);
    expect(wantsHelp(parse(['--h']))).toBe(true);
    expect(wantsHelp(parse(['-h']))).toBe(true);
  });
});

describe('a file too large to put in a conversation', () => {
  it('names the way past the truncation it just applied', async () => {
    // The note said how much it had kept and stopped there. read_file has no
    // offset argument and the platform serves whole files, so a reader who hit
    // this had been told exactly what they were missing and nothing at all
    // about how to reach it — and the tool that can reach it, exec, is bounded
    // at 16 MiB rather than at this 256 KiB.
    const real = globalThis.fetch;
    const size = 600 * 1024;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('x'.repeat(size), {
          headers: { 'Content-Type': 'text/plain', 'Content-Length': String(size) },
        }),
      )) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/var/log/big file&.log' });
    const out = said(res);
    expect(out).toMatch(/showed 262144 of 614400 bytes/);
    // The resume offset, computed rather than left to the reader: `tail -c +N`
    // counts from one, so an off-by-one here drops or repeats a byte silently.
    expect(out).toContain("tail -c +262145 '/var/log/big file&.log'");
    // And the way to move the file rather than read it.
    expect(out).toContain("curl -T '/var/log/big file&.log'");
    await close();
    globalThis.fetch = real;
  });

  it('says none of that about a file that fitted', async () => {
    const platform = installFakePlatform();
    const { call, close } = await connect();
    const out = said(await call('read_file', { path: '/home/user/a.txt' }));
    expect(out).toMatch(/hello/);
    expect(out).not.toMatch(/truncated|tail -c/);
    await close();
    platform.restore();
  });
});

describe('wait failures that are worth another poll', () => {
  it.each([409, 429, 502, 503, 504])('retries HTTP %s', (status) => {
    expect(isTransient(errorForStatus(status, `HTTP ${status}`))).toBe(true);
  });

  it('retries a connectivity blip but not a cancellation', () => {
    expect(isTransient(new ConnectivityError('fetch failed'))).toBe(true);
    expect(isTransient(new Error('cancelled'))).toBe(false);
  });

  it('does not put base-URL credentials into a reachability error', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    try {
      const api = new Api(
        'com_test',
        'https://operator:secret@example.test/api/v1?access_token=also-secret',
      );
      await expect(api.json('GET', 'computers')).rejects.toThrow(
        'could not reach https://example.test',
      );
      await expect(api.json('GET', 'computers')).rejects.not.toThrow(
        /secret|operator|access_token/,
      );
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('results that did not reach their requested condition', () => {
  it.each(['suspended', 'stopped'])('marks a %s wait as an error', async (status) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'vm-1', status }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('wait_for_computer', { until: 'guest', timeout_s: 5 });
      expect(res.isError).toBe(true);
      expect(said(res)).toMatch(/start_computer/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it.each(['max_steps', 'refusal', 'future_stop_reason'])(
    'marks an agent %s stop as an error',
    async (stop) => {
      const real = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(`event: done\ndata: ${JSON.stringify({ stop, text: 'not done' })}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        })) as typeof fetch;
      try {
        const { call, close } = await connect({ modelKey: 'sk-test' });
        const res = await call('run_agent', { prompt: 'finish the task' });
        expect(res.isError).toBe(true);
        await close();
      } finally {
        globalThis.fetch = real;
      }
    },
  );
});

describe('absolute guest paths', () => {
  it.each([
    ['exec', { command: 'pwd', cwd: 'tmp' }],
    ['write_file', { path: 'tmp/a', content: 'x' }],
    ['read_file', { path: 'tmp/a' }],
  ])('rejects a relative path for %s before calling the platform', async (tool, args) => {
    const platform = installFakePlatform();
    try {
      const { call, close } = await connect();
      const res = await call(tool, args);
      expect(res.isError).toBe(true);
      expect(platform.calls).toHaveLength(0);
      await close();
    } finally {
      platform.restore();
    }
  });

  it('rejects a negative idle-suspend window', async () => {
    const platform = installFakePlatform();
    try {
      const { call, close } = await connect();
      const res = await call('update_computer', { idle_suspend_min: -1 });
      expect(res.isError).toBe(true);
      expect(platform.calls).toHaveLength(0);
      await close();
    } finally {
      platform.restore();
    }
  });
});

describe('malformed computer listings', () => {
  it('skips null rows without failing the whole valid list', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([null, { id: 'vm-1', name: 'desk', status: 'running' }]), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('list_computers');
      expect(res.isError).toBeFalsy();
      expect(said(res)).toMatch(/ignored 1 malformed computer entry/);
      expect(said(res)).toMatch(/vm-1/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('malformed snapshot listings', () => {
  it('skips null and non-object rows without failing the valid inventory', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([null, 'not-a-snapshot', [], { id: 'snap-1', computer_id: 'vm-1' }]),
        { headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('list_snapshots');
      expect(res.isError).toBeFalsy();
      expect(said(res)).toMatch(/ignored 3 malformed snapshot entries/);
      expect(said(res)).toMatch(/snap-1/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('does not call an all-malformed inventory empty', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([null, 7]), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('list_snapshots');
      expect(res.isError).toBe(true);
      expect(said(res)).toMatch(/no valid snapshots remained/i);
      expect(said(res)).not.toMatch(/^0 snapshot/m);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('a large file download', () => {
  it('cancels the response stream once the inline prefix is known', async () => {
    const real = globalThis.fetch;
    let pulls = 0;
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            if (pulls > 64) return controller.close();
            controller.enqueue(new Uint8Array(64 * 1024).fill(120));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/plain' } },
      )) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('read_file', { path: '/var/log/large.log' });
      expect(res.isError).toBeFalsy();
      expect(said(res)).toMatch(/truncated/);
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(64);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('response-body failures', () => {
  let real: typeof globalThis.fetch;

  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  const aborted = () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  };

  it('classifies aborts after headers the same way as aborted fetches', async () => {
    const response = (status: number) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: aborted,
      }) as unknown as Response;
    const api = new Api('com_test', BASE);

    globalThis.fetch = (async () => response(200)) as typeof fetch;
    await expect(api.json('GET', 'computers')).rejects.toBeInstanceOf(CancelledError);

    globalThis.fetch = (async () => response(409)) as typeof fetch;
    await expect(api.json('GET', 'computers')).rejects.toBeInstanceOf(CancelledError);
  });

  it('classifies binary and streamed body aborts as cancellations', async () => {
    const api = new Api('com_test', BASE);
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'image/png' }),
        arrayBuffer: aborted,
      }) as unknown as Response) as typeof fetch;
    await expect(api.bytes('GET', 'computers/vm-1/screenshot')).rejects.toBeInstanceOf(
      CancelledError,
    );

    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: {
          getReader: () => ({ read: aborted, cancel: async () => undefined }),
        },
      }) as unknown as Response) as typeof fetch;
    const events = async () => {
      for await (const _event of api.sse('POST', 'agent')) {
        // The mocked stream aborts before yielding.
      }
    };
    await expect(events()).rejects.toBeInstanceOf(CancelledError);
  });

  it('cancels a capped reader even when read itself throws', async () => {
    let cancelled = false;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/plain' }),
        body: {
          getReader: () => ({
            read: async () => {
              throw new Error('stream broke');
            },
            cancel: async () => {
              cancelled = true;
            },
          }),
        },
      }) as unknown as Response) as typeof fetch;
    const api = new Api('com_test', BASE);
    await expect(api.bytes('GET', 'files', {}, 10)).rejects.toThrow('stream broke');
    expect(cancelled).toBe(true);
  });
});

describe('truthful recovery results', () => {
  let real: typeof globalThis.fetch;

  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('normalises a padded computer id before filtering snapshots', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { id: 'snap-1', computer_id: 'vm-1' },
          { id: 'snap-2', computer_id: 'vm-2' },
          { id: 'snap-3', unreachable: true },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
    const { call, close } = await connect();
    const out = said(await call('list_snapshots', { computer_id: '  vm-1  ' }));
    expect(out).toContain('snap-1');
    expect(out).toContain('snap-3');
    expect(out).not.toContain('snap-2');
    await close();
  });

  it('does not invent zero holdings or a missing fingerprint', async () => {
    globalThis.fetch = (async () =>
      new Response('{}', { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const { call, close } = await connect();
    const out = said(await call('snapshot_holdings'));
    expect(out).toContain('unknown count');
    expect(out).toContain('unknown total size');
    expect(out).toContain('did not provide a fingerprint');
    expect(out).not.toMatch(/holds 0 snapshot|0\.00 GB/);
    await close();
  });

  it('refuses a clone result that cannot identify the copy', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name: 'copy' }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('clone_computer');
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/no id|list_computers/i);
    await close();
  });

  it('refuses a snapshot clone result that cannot identify the copy', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name: 'copy' }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('clone_snapshot', { snapshot_id: 'snap-1' });
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/no computer id|list_computers/i);
    await close();
  });
});

describe('background process handles', () => {
  it('refuses pids that cannot be represented safely in a path', async () => {
    const platform = installFakePlatform();
    try {
      const { call, close } = await connect();
      for (const pid of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
        expect((await call('exec_poll', { pid })).isError, `poll accepted ${pid}`).toBe(true);
        expect((await call('exec_kill', { pid })).isError, `kill accepted ${pid}`).toBe(true);
      }
      expect(platform.calls).toHaveLength(0);
      await close();
    } finally {
      platform.restore();
    }
  });

  it('defends the path builder against an unsafe pid', () => {
    expect(() => P.execHandle('vm-1', 0)).toThrow(/positive safe integer/i);
    expect(() => P.execHandle('vm-1', 1e21)).toThrow(/positive safe integer/i);
    expect(P.execHandle('vm-1', Number.MAX_SAFE_INTEGER)).toBe(
      `computers/vm-1/exec/${Number.MAX_SAFE_INTEGER}`,
    );
  });
});

describe('a proxy giving up is not reported as a bare status', () => {
  it('names the ceiling, the survivor, and the way out', () => {
    // Cloudflare content-negotiates its error page, and every request from this
    // server asks for JSON, so the 524 arrives with an EMPTY body — which left
    // Api's fallback message as the bare string 'HTTP 524'.
    const err = errorForStatus(524, 'HTTP 524');
    expect(err).toBeInstanceOf(GatewayTimeoutError);
    expect(err.status).toBe(524);
    expect(err.message).toMatch(/proxy/);
    expect(err.message).toMatch(/still running/);
    expect(err.message).toMatch(/background: true/);
  });

  it('keeps a structured message rather than overwriting it', () => {
    // The substitution is for a body that said nothing, not for every 504. A
    // gateway status can be raised by any proxy in the chain, and one that
    // speaks JSON has said something more specific than this file can.
    const err = errorForStatus(504, 'upstream unavailable before dispatch', {
      error: 'upstream unavailable before dispatch',
    });
    expect(err).toBeInstanceOf(GatewayTimeoutError);
    expect(err.message).toBe('upstream unavailable before dispatch');
  });

  it('still substitutes when the body is empty or is a proxy page', () => {
    expect(errorForStatus(524, 'HTTP 524').message).toMatch(/proxy/);
    expect(errorForStatus(524, 'HTTP 524', {}).message).toMatch(/proxy/);
    expect(errorForStatus(524, 'HTTP 524', { error: '' }).message).toMatch(/proxy/);
    expect(errorForStatus(524, 'HTTP 524', { error: 42 }).message).toMatch(/proxy/);
    expect(errorForStatus(524, '<!DOCTYPE html>', '<!DOCTYPE html>').message).toMatch(/proxy/);
  });

  it('does not tell a 520 that its work never happened', () => {
    // Cloudflare returns 520 when the origin DID receive the request and
    // answered unreadably. Filed with the unreachable statuses it inherited
    // "the request never arrived, so nothing was started" — said to a create
    // that may have just made a billable computer.
    const err = errorForStatus(520, 'HTTP 520');
    expect(err).toBeInstanceOf(OriginResponseError);
    expect(err).not.toBeInstanceOf(OriginUnreachableError);
    expect(err.message).not.toMatch(/never arrived/);
    expect(err.message).toMatch(/did arrive/);
    expect(err.message).toMatch(/creates something/);
  });

  it('keeps a 520 body the platform may itself have written', () => {
    // As Api calls it: the message is already lifted from the body's `error`,
    // and the question is only whether this file then replaces it.
    const said = 'the hypervisor closed the connection';
    expect(errorForStatus(520, said, { error: said }).message).toBe(said);
    // And still substitutes when nothing structured came back.
    expect(errorForStatus(520, 'HTTP 520', undefined).message).toMatch(/did arrive/);
  });

  it('still lets a wait loop ride out a 520', () => {
    // Unsafe to replay a create, safe to replay a poll — and this list is read
    // only by the wait tools, which do nothing but poll.
    expect(isTransient(errorForStatus(520, 'HTTP 520'))).toBe(true);
  });

  it('discards the proxy error page rather than truncating it into the message', () => {
    const html = '<!DOCTYPE html><html><body>error code: 524</body></html>';
    expect(errorForStatus(524, html).message).not.toMatch(/DOCTYPE/);
  });

  it('reaches the model as a readable failure, not a status line', () => {
    expect(said(failed(errorForStatus(524, 'HTTP 524')))).toMatch(/proxy.*\(HTTP 524\)/s);
  });

  it('keeps 504 retryable and 524 not', () => {
    // Same class, different answer, and the split is by where each is reachable
    // from: the wait tools poll with short requests, where a 504 is a blip. A
    // 524 is only reached past the ceiling, where retrying reproduces it.
    expect(isTransient(errorForStatus(504, 'HTTP 504'))).toBe(true);
    expect(isTransient(errorForStatus(524, 'HTTP 524'))).toBe(false);
  });

  it('hedges the exec advice, because a 504 reaches tools that have no background', () => {
    // 504 is the retryable half, so a wait loop polls into it and replays the
    // message verbatim in its give-up text. Told flatly to "re-run it with
    // background: true and read the output with exec_poll", the caller of a
    // wait_for_computer goes looking for a parameter that tool does not have
    // and a pid there is none of.
    const said = errorForStatus(504, 'HTTP 504').message;
    expect(said).toMatch(/Most often that is a foreground exec/);
    expect(said).not.toMatch(/Re-run it with/);
  });
});

describe('an edge that never reached the platform is not reported as a bare status', () => {
  // 520 is deliberately absent: it means the platform WAS reached and answered
  // unreadably, so it is neither this nor a gateway timeout. See its own tests.
  it.each([521, 522, 523, 525, 526])('writes a message for HTTP %s', (status) => {
    // The same bug as the 524 above, a few statuses along: these fell through
    // to Api's fallback and left the model reading `HTTP 522`.
    const err = errorForStatus(status, `HTTP ${status}`);
    expect(err).toBeInstanceOf(OriginUnreachableError);
    expect(err.status).toBe(status);
    expect(err.message).not.toMatch(/^HTTP /);
    expect(err.message).toMatch(/could not reach it|TLS handshake/);
  });

  it('says nothing survived, which is the opposite of what a 524 says', () => {
    // Worth pinning as a pair. A 524 means the request arrived and its work
    // carries on; these mean it never arrived. A caller reading either to
    // decide whether to expect a busy guest agent next must get opposite
    // answers, so the two messages must not converge.
    expect(errorForStatus(522, 'HTTP 522').message).toMatch(/nothing is running/);
    expect(errorForStatus(524, 'HTTP 524').message).toMatch(/still running/);
  });

  it('retries an origin that is down but not a handshake that will not agree', () => {
    // An origin restart clears within a wait window. An expired or mismatched
    // certificate fails identically for the whole of one, so polling it just
    // spends the window to arrive at the same place.
    for (const status of [520, 521, 522, 523]) {
      expect(isTransient(errorForStatus(status, `HTTP ${status}`))).toBe(true);
    }
    for (const status of [525, 526]) {
      expect(isTransient(errorForStatus(status, `HTTP ${status}`))).toBe(false);
      expect(errorForStatus(status, `HTTP ${status}`).message).toMatch(/misconfigured/);
    }
  });

  it('discards the proxy error page rather than truncating it into the message', () => {
    const html = '<!DOCTYPE html><html><body>error code: 522</body></html>';
    expect(errorForStatus(522, html).message).not.toMatch(/DOCTYPE/);
  });
});

describe('the public error surface', () => {
  it('exports both non-HTTP errors thrown by Api', () => {
    expect(PublicCancelledError).toBe(CancelledError);
    expect(PublicConnectivityError).toBe(ConnectivityError);
  });

  it('exports the edge errors an embedder would want to branch on', () => {
    // A host application embedding this server catches by class, and the two
    // added last are the ones whose handling differs most: one leaves work
    // running behind it and the other leaves none.
    expect(PublicOriginUnreachableError).toBe(OriginUnreachableError);
  });

  it('does not repeat an empty HTTP error status', () => {
    expect(said(failed(errorForStatus(409, 'HTTP 409')))).toBe('HTTP 409');
    expect(said(failed(errorForStatus(409, 'guest still booting')))).toBe(
      'guest still booting (HTTP 409)',
    );
  });
});
