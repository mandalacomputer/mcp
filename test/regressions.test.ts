import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer as createSocketServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Api,
  filenameFrom,
  PLATFORM_BODY_TIMEOUT_MS,
  PLATFORM_HEADERS_TIMEOUT_MS,
  platformFetch,
} from '../src/api.js';
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
  type APIError,
  CancelledError,
  ConflictError,
  ConnectivityError,
  ConnectivityInterruptedError,
  errorForStatus,
  GatewayTimeoutError,
  isTransient,
  isTransientForPoll,
  MandalaError,
  OriginResponseError,
  OriginTLSError,
  OriginUnreachableError,
  platformSaid,
  RangeNotSatisfiableError,
  RateLimitError,
  UnavailableError,
} from '../src/errors.js';
import { failed, MAX_INLINE_IMAGE_BYTES, unwrapComputer } from '../src/format.js';
import { hostSpellings, isLoopbackHost } from '../src/http.js';
import {
  CancelledError as PublicCancelledError,
  ConnectivityError as PublicConnectivityError,
  ConnectivityInterruptedError as PublicConnectivityInterruptedError,
  GatewayTimeoutError as PublicGatewayTimeoutError,
  OriginResponseError as PublicOriginResponseError,
  OriginTLSError as PublicOriginTLSError,
  OriginUnreachableError as PublicOriginUnreachableError,
  RangeNotSatisfiableError as PublicRangeNotSatisfiableError,
  RateLimitError as PublicRateLimitError,
} from '../src/index.js';
import * as P from '../src/paths.js';
import { windowBody } from '../src/paths.js';
import { SERVER_VERSION } from '../src/server.js';
import { Session } from '../src/session.js';
import { BASE, connect, download, FakeSocket, fakeEvents, installFakePlatform } from './harness.js';

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
      expect(PLATFORM_BODY_TIMEOUT_MS).toBe(0);
      expect(dispatcher).toBeTruthy();
    } finally {
      globalThis.fetch = real;
    }
  });

  /**
   * Two undicis, and the Agent above belongs to only one of them.
   *
   * The dispatcher is an Agent from the `undici` PACKAGE; Node's built-in fetch
   * is a different COPY of undici, the one bundled with the runtime. Handing
   * one's Agent to the other's fetch works only while the two agree on an
   * internal handler interface, and they have stopped: Node 26 bundles undici
   * 8.9, whose fetch rejects an undici 6 Agent with `invalid onError method`.
   * The Api class wraps that as "could not reach app.mandala.computer", so on
   * Node 26 every call this server made reported the platform as down before a
   * packet was sent — and no test could see it, because every test in this repo
   * stands its own function in `globalThis.fetch` and never reaches the built-in
   * one at all.
   *
   * No version bump reaches it either: npm's newest undici is 7.x against the
   * runtime's 8.x, and a dependency chosen to match Node 26 would mismatch the
   * Node 20 `engines` still admits. So the pin is the shape of the fix rather
   * than a request — the untouched global is NOT what a platform request goes
   * through, and a replaced one is.
   */
  it('does not hand the undici package’s Agent to the runtime’s own fetch', () => {
    const real = globalThis.fetch;
    try {
      // Nothing has replaced it: the request goes through undici's own fetch,
      // which is the only one that understands the Agent it is given.
      expect(platformFetch()).not.toBe(globalThis.fetch);
      // And a replacement is honoured — which is what every stub in this file
      // relies on, and what an embedder installing an instrumented fetch means.
      const stub = (async () => new Response('{}')) as typeof fetch;
      globalThis.fetch = stub;
      expect(platformFetch()).toBe(stub);
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

  it('refuses hex and scientific notation rather than binding the coerced port', () => {
    // `Number('0x12')` is 18 and `Number('1e3')` is 1000; both used to pass
    // Number.isInteger and the 0–65535 range (adversarial review, OPL-4314).
    expect(() => port('0x12')).toThrow(/not a port number/);
    expect(() => port('1e3')).toThrow(/not a port number/);
    expect(port('3000')).toBe(3000);
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

  it('is the one the Claude Code plugin declares', () => {
    // A fourth copy (OPL-3914). The plugin manifest starts `npx -y
    // mandala-computer-mcp`, so what it installs is always the latest publish
    // and its own number is documentation of which server the skill was written
    // against — which is only true if it moves with the rest.
    //
    // Under plugin/ and not at the root, because a marketplace entry's `source`
    // is the directory Claude Code copies into its plugin cache — and copying
    // the root copies this whole repository, node_modules and dist included,
    // into a plugin that starts the server from npm and reads none of it.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    const plugin = JSON.parse(
      readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    ) as { version: string; mcpServers: Record<string, { command: string; args: string[] }> };
    expect(plugin.version).toBe(pkg.version);
    // And it starts the package this repository publishes, not a path.
    expect(plugin.mcpServers.mandala.command).toBe('npx');
    expect(plugin.mcpServers.mandala.args).toEqual(['-y', 'mandala-computer-mcp']);
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

  it('takes the name from a filename parameter, not from one that merely ends in it', () => {
    // Unanchored, the pattern matched the tail of any longer parameter name, so
    // a header carrying `x-filename=` — from a proxy, or an origin that is not
    // the platform — supplied the name a download is written under.
    expect(filenameFrom('inline; x-filename=q.txt')).toBeUndefined();
    expect(filenameFrom('attachment; myfilename=b.txt')).toBeUndefined();
    // The real parameter is still read when both are there, whichever is first.
    expect(filenameFrom('attachment; x-filename=q.txt; filename="real.txt"')).toBe('real.txt');
    expect(filenameFrom("inline; xfilename*=UTF-8''q.txt; filename=real.txt")).toBe('real.txt');
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
    // tools for the same reason. A leftover token is now a refusal, not a
    // silent skip that still starts HTTP.
    expect(() => parse(['--http', 'false'])).toThrow(/unexpected argument false/);
    expect(() => parse(['--no-lifecycle', '0'])).toThrow(/unexpected argument 0/);
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

  it('takes an empty value token as the value it is', () => {
    // A truthiness test skipped `""` rather than consuming it, so the flag was
    // set to the boolean `true` and the empty token came round again as a stray
    // argument: `--key ""` died with `unexpected argument .`, naming nothing the
    // user could act on, while `--key=` is the empty value `str()` documents.
    // Both spellings are the same flag and now answer the same.
    expect(parse(['--key', ''])).toEqual({ key: '' });
    expect(parse(['--key='])).toEqual({ key: '' });
    // The leftover-token refusal a boolean flag depends on is untouched: those
    // are handled a branch above this one.
    expect(() => parse(['--http', 'false'])).toThrow(/unexpected argument false/);
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
    // Shaped like a refused socket, which is what a real one looks like: the
    // rejection is a `TypeError: fetch failed` and the phase is only legible on
    // its cause. Without one this is now read as a possible dispatch (OPL-3855),
    // so the cause is what keeps this about the cancellation confusion it was
    // written for rather than about the new split.
    globalThis.fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
          code: 'ECONNREFUSED',
          syscall: 'connect',
        }),
      });
    }) as typeof fetch;
    const api = new Api('com_test', BASE);
    await expect(api.json('GET', 'computers')).rejects.toThrow(/could not reach/);
    await expect(api.json('GET', 'computers')).rejects.toBeInstanceOf(ConnectivityError);
    await expect(api.json('GET', 'computers')).rejects.not.toBeInstanceOf(
      ConnectivityInterruptedError,
    );
    globalThis.fetch = real;
  });

  it('does not call an unrecognised transport failure a connect failure', async () => {
    // The fail-closed half. A rejection this client cannot place — no cause, or
    // one it has no rule for — must be read as possibly dispatched, because the
    // caller who pays for a wrong answer here is an embedder replaying a create.
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    try {
      const api = new Api('com_test', BASE);
      await expect(api.json('GET', 'computers')).rejects.toBeInstanceOf(
        ConnectivityInterruptedError,
      );
      const err = await api.json('GET', 'computers').catch((e: unknown) => e);
      expect(isTransient(err)).toBe(false);
      expect(isTransientForPoll(err)).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
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
    // The note said how much it had kept and stopped there. read_file had no
    // offset argument and the platform served whole files, so a reader who hit
    // this had been told exactly what they were missing and nothing at all
    // about how to reach it. Now the way past it is this tool itself, and the
    // note has to say so with the offset already worked out — a reader that
    // adds 256 KiB by hand is wrong the moment a window comes back short.
    const real = globalThis.fetch;
    const size = 600 * 1024;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      Promise.resolve(
        download('x'.repeat(size), new Headers(init?.headers ?? {}).get('range') ?? undefined),
      )) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/var/log/big file&.log' });
    const out = said(res);
    expect(out).toMatch(/showed 262144 of 614400 bytes/);
    expect(out).toContain('read_file again with offset: 262144');
    // The exec workaround is gone from this note. It cost a shell in the guest
    // and an off-by-one on tail's one-based count to read the next 256 KiB.
    expect(out).not.toContain('tail -c');
    // And the way to move the file rather than read it, which is still the
    // right answer for a file you want whole.
    expect(out).toContain("curl -T '/var/log/big file&.log'");
    await close();
    globalThis.fetch = real;
  });

  it('says none of that about a file that fitted', async () => {
    const platform = installFakePlatform();
    const { call, close } = await connect();
    const out = said(await call('read_file', { path: '/home/user/a.txt' }));
    expect(out).toMatch(/hello/);
    expect(out).not.toMatch(/truncated|offset:/);
    await close();
    platform.restore();
  });
});

describe('wait failures that are worth another poll', () => {
  it.each([409, 429, 503])('retries HTTP %s for anyone', (status) => {
    expect(isTransient(errorForStatus(status, `HTTP ${status}`))).toBe(true);
  });

  it.each([502, 504, 520, 521, 522, 523])(
    'polls through HTTP %s but does not publish it',
    (status) => {
      // The OPL-3724 split, per status. Both predicates used to be allow-lists
      // and 502/504 were on both, which said an embedder could safely replay a
      // create through a failure whose outcome nobody knows. The wait tools still
      // ride every one of these out — they only ever replay a read.
      const err = errorForStatus(status, `HTTP ${status}`);
      expect(isTransientForPoll(err)).toBe(true);
      expect(isTransient(err)).toBe(false);
    },
  );

  it('polls through a status nobody has mapped, and fails fast on a bad request', () => {
    // Why the poll predicate is a deny-list. Under the old allow-list every
    // status the edge invents next was fatal to a wait until somebody noticed
    // and added a number; a 5xx is a moment and a wait exists to outlast one.
    // The line is REQUEST versus MOMENT, and a 4xx is the request — written as
    // a range so an unmapped one lands on the right side too.
    expect(isTransientForPoll(errorForStatus(500, 'HTTP 500'))).toBe(true);
    expect(isTransientForPoll(errorForStatus(507, 'HTTP 507'))).toBe(true);
    expect(isTransientForPoll(errorForStatus(400, 'HTTP 400'))).toBe(false);
    expect(isTransientForPoll(errorForStatus(405, 'HTTP 405'))).toBe(false);
    expect(isTransientForPoll(errorForStatus(418, 'HTTP 418'))).toBe(false);
    // 408 is the third 4xx that describes a moment: RFC 9110 defines it as a
    // request the client may repeat unchanged, and the edge in front of this
    // surface emits it.
    expect(isTransientForPoll(errorForStatus(408, 'HTTP 408'))).toBe(true);
    // And a 3xx goes with the 4xx, which is why the test is `>= 500` rather
    // than "not a 4xx". Api does not follow redirects and treats every non-2xx
    // as an error, so a MANDALA_BASE_URL missing its trailing path answers 301
    // — polled to the deadline under a 4xx-only rule, ending in a give-up that
    // named nothing about the redirect.
    for (const status of [301, 302, 303, 307, 308]) {
      expect(isTransientForPoll(errorForStatus(status, `HTTP ${status}`))).toBe(false);
    }
    // And 5xx has an UPPER bound too. The HTTP parser under fetch accepts any
    // three digits, so a broken origin can answer 700 — which `>= 500` alone
    // called a passing moment and polled until the caller's deadline.
    for (const status of [600, 700, 999]) {
      expect(isTransientForPoll(errorForStatus(status, `HTTP ${status}`))).toBe(false);
    }
  });

  it.each([
    // header, expected retryAfterMs
    ['12', 12_000],
    ['0', 0],
    // The one that mattered. 2147484 seconds is under a month and a perfectly
    // ordinary thing for a platform to ask for, and 2147484000ms does not fit
    // the 32-bit signed int Node stores a timer in — so setTimeout warns and
    // fires at 1ms. Honouring the header verbatim was therefore the way to
    // retry a month-long rate limit immediately, and keep doing it until the
    // caller's deadline (Codex adversarial review).
    ['2147484', 2_147_483_647],
    ['99999999999', 2_147_483_647],
  ])('caps Retry-After: %s so a timer cannot wrap to 1ms', async (header, expected) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":"slow down"}', {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': header },
      })) as typeof fetch;
    try {
      const err = await new Api('com_test', BASE).json('GET', 'computers').catch((e) => e);
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(expected);
      // And whatever it is, a sleep can hold it: the cap is exactly the largest
      // delay setTimeout takes without wrapping.
      expect((err as RateLimitError).retryAfterMs).toBeLessThanOrEqual(2_147_483_647);
    } finally {
      globalThis.fetch = real;
    }
  });

  it.each(['0x10', '1e3'])(
    'does not honour Retry-After: %s, which the header grammar does not spell',
    async (header) => {
      // delta-seconds is digits, and everything else is an HTTP-date. `Number()`
      // took `1e3` for 1000 seconds, so three characters from a broken or
      // hostile intermediary put a poll loop to sleep for sixteen minutes.
      // Nothing readable means nothing: the loop keeps its own interval.
      const real = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response('{"error":"slow down"}', {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': header },
        })) as typeof fetch;
      try {
        const err = await new Api('com_test', BASE).json('GET', 'computers').catch((e) => e);
        expect(err).toBeInstanceOf(RateLimitError);
        expect((err as RateLimitError).retryAfterMs).toBeUndefined();
      } finally {
        globalThis.fetch = real;
      }
    },
  );

  it('does not poll through anything that is not a failed request', () => {
    // The floor a deny-list needs, and it is narrower than "our error": only an
    // APIError or a ConnectivityError describes an exchange that did not work.
    //
    // A TypeError from a bug in this server is not a hypervisor being slow. A
    // caller who hung up is not either. And a bare MandalaError is the case
    // that actually bit — Api raises them for a response that arrived and made
    // no sense, and a poll loop raises them as verdicts about a poll that
    // SUCCEEDED ("this move is no longer listed"). Polling through a verdict is
    // an infinite loop with a deadline on it; the TypeScript SDK's suite caught
    // exactly that when this predicate was ported there with MandalaError as
    // its floor, in three tests that stopped terminating.
    expect(isTransientForPoll(new TypeError('cannot read properties of undefined'))).toBe(false);
    expect(isTransientForPoll(new CancelledError('the caller gave up'))).toBe(false);
    expect(isTransientForPoll(new MandalaError('that move is no longer listed'))).toBe(false);
    // What the floor lets through, so it is not merely an allow-list wearing a
    // deny-list's shape.
    expect(isTransientForPoll(new ConnectivityError('fetch failed'))).toBe(true);
    expect(isTransientForPoll(errorForStatus(503, 'HTTP 503'))).toBe(true);
  });

  it('retries a connectivity blip but not a cancellation', () => {
    expect(isTransient(new ConnectivityError('fetch failed'))).toBe(true);
    expect(isTransient(new Error('cancelled'))).toBe(false);
  });

  it('does not put base-URL credentials into a reachability error', async () => {
    // Both classes, because the split gave this message a second spelling and a
    // secret leaks just as well from either (OPL-3855). Each names the origin
    // and only the origin — `URL.origin` drops userinfo and the query, which is
    // what makes that true.
    const real = globalThis.fetch;
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
    });
    const reset = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    try {
      for (const [cause, expected] of [
        [refused, 'could not reach https://example.test'],
        [reset, 'GET /computers to https://example.test'],
      ] as const) {
        globalThis.fetch = (async () => {
          throw Object.assign(new TypeError('fetch failed'), { cause });
        }) as typeof fetch;
        const api = new Api(
          'com_test',
          'https://operator:secret@example.test/api/v1?access_token=also-secret',
        );
        await expect(api.json('GET', 'computers')).rejects.toThrow(expected);
        await expect(api.json('GET', 'computers')).rejects.not.toThrow(
          /secret|operator|access_token/,
        );
      }
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

  it('classifies aborts after headers as transport failures unless the caller signal fired', async () => {
    const response = (status: number) =>
      new Response(
        new ReadableStream({
          pull(controller) {
            aborted().catch((err) => controller.error(err));
          },
        }),
        { status, headers: { 'Content-Type': 'application/json' } },
      );
    const api = new Api('com_test', BASE);

    globalThis.fetch = (async () => response(200)) as typeof fetch;
    await expect(api.json('GET', 'computers')).rejects.toBeInstanceOf(ConnectivityError);

    globalThis.fetch = (async () => response(409)) as typeof fetch;
    await expect(api.json('GET', 'computers')).rejects.toMatchObject({ status: 409 });
  });

  it('classifies binary and streamed body aborts as transport failures', async () => {
    const api = new Api('com_test', BASE);
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'image/png' }),
        arrayBuffer: aborted,
      }) as unknown as Response) as typeof fetch;
    await expect(api.bytes('GET', 'computers/vm-1/screenshot')).rejects.toBeInstanceOf(
      ConnectivityError,
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
    await expect(events()).rejects.toBeInstanceOf(ConnectivityError);
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

describe('bounded JSON and error bodies', () => {
  let real: typeof globalThis.fetch;

  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  const endless = (status: number, onCancel: () => void) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024).fill(120));
        },
        cancel: onCancel,
      }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );

  it('stops a successful response that exceeds the JSON ceiling', async () => {
    let cancelled = false;
    globalThis.fetch = (async () => endless(200, () => (cancelled = true))) as typeof fetch;

    await expect(new Api('com_test', BASE).json('GET', 'computers')).rejects.toThrow(
      /more than .* bytes of JSON/,
    );
    expect(cancelled).toBe(true);
  });

  it('keeps only a bounded prefix of an oversized error response', async () => {
    let cancelled = false;
    globalThis.fetch = (async () => endless(400, () => (cancelled = true))) as typeof fetch;

    await expect(new Api('com_test', BASE).json('GET', 'computers')).rejects.toMatchObject({
      status: 400,
    });
    expect(cancelled).toBe(true);
  });
});

describe('a selection concurrent with deletion', () => {
  it('cannot rebind the session to the computer after delete unbound it', async () => {
    const real = globalThis.fetch;
    let releaseSelection!: () => void;
    let selectionStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const started = new Promise<void>((resolve) => {
      selectionStarted = resolve;
    });
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.pathname}`);
      if (method === 'GET' && url.pathname.endsWith('/computers/vm-2')) {
        selectionStarted();
        await held;
        return new Response(
          JSON.stringify({ id: 'vm-2', status: 'running', resolution: '1280x800x24' }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'DELETE' && url.pathname.endsWith('/computers/vm-2')) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith('/screenshot')) {
        return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    }) as typeof fetch;

    try {
      const { call, close } = await connect({ computerId: 'vm-1' });
      const selecting = call('use_computer', { computer_id: 'vm-2' });
      await started;
      expect(
        (await call('delete_computer', { computer_id: 'vm-2', confirm: true })).isError,
      ).toBeFalsy();
      releaseSelection();
      expect((await selecting).isError).toBe(true);
      expect((await call('screenshot')).isError).toBeFalsy();
      expect(calls.at(-1)).toMatch(/\/computers\/vm-1\/screenshot$/);
      await close();
    } finally {
      releaseSelection();
      globalThis.fetch = real;
    }
  });
});

describe('non-deadline response cancellation during a wait', () => {
  it('does not call a transport abort a cancellation', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 4_800));
            const err = new Error('response stream was cancelled early');
            err.name = 'AbortError';
            controller.error(err);
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    try {
      const { call, close } = await connect();
      const res = await call('wait_for_computer', { timeout_s: 5 });
      expect(res.isError).toBe(true);
      expect(said(res)).toMatch(/Gave up after 5s/);
      expect(said(res)).not.toContain('was cancelled while reading the platform response');
      await close();
    } finally {
      globalThis.fetch = real;
    }
  }, 15_000);
});

describe('press_key validation', () => {
  it('rejects empty and whitespace-only key names before calling the platform', async () => {
    const platform = installFakePlatform();
    try {
      const { call, close } = await connect();
      expect((await call('press_key', { keys: [''] })).isError).toBe(true);
      expect((await call('press_key', { keys: ['  '] })).isError).toBe(true);
      expect(platform.calls).toHaveLength(0);
      await close();
    } finally {
      platform.restore();
    }
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
    expect(err.message).toMatch(/outlived the request/);
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

  it('still lets a wait loop ride out a 520, and does not tell an embedder to', () => {
    // Unsafe to replay a create, safe to replay a poll — so the two questions
    // are two predicates. The wait tools ask the one that knows it only ever
    // reads; isTransient is exported, so it answers for a caller who may be
    // retrying a create and would get two billable computers for the trouble.
    expect(isTransientForPoll(errorForStatus(520, 'HTTP 520'))).toBe(true);
    expect(isTransient(errorForStatus(520, 'HTTP 520'))).toBe(false);
  });

  it('keeps the proxy error page on the error even though it never shows it', () => {
    // The page is the wrong thing to put in front of a model and the right
    // thing to still have: the Ray ID support asks for is in that HTML and
    // nowhere else, and substituting the message was dropping it.
    const page = '<html><body>error code: 522 Ray ID: 8f2a1c</body></html>';
    const err = errorForStatus(522, page, page);
    expect(err.message).not.toMatch(/Ray ID/);
    expect(String(err.body)).toMatch(/8f2a1c/);
  });

  it('keeps the whole page, not the 500 characters the message was cut to', async () => {
    // The test above calls errorForStatus directly with a page short enough to
    // survive any truncation, so it cannot see this: Api slices the page to 500
    // for the message, and stashing that slice instead of the text kept only
    // the opening tags. A real Cloudflare 52x page runs to several KB with the
    // Ray ID in the footer, which is to say past the cut, which is to say the
    // one field the stash exists for was the one field it dropped.
    const page =
      `<!DOCTYPE html><html><head><title>522: Connection timed out</title></head><body>` +
      `<!-- ${'padding '.repeat(200)} -->` +
      `<div class="footer">Ray ID: 8f2a1c9d4e7b0000</div></body></html>`;
    expect(page.indexOf('8f2a1c9d4e7b0000')).toBeGreaterThan(500);
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(page, {
        status: 522,
        headers: { 'Content-Type': 'text/html' },
      })) as typeof fetch;
    try {
      const err = await new Api('com_test', BASE).json('GET', 'computers').then(
        () => null,
        (e: unknown) => e as APIError,
      );
      expect(err).toBeInstanceOf(OriginUnreachableError);
      expect(err?.message).not.toMatch(/Ray ID/);
      expect(String(err?.body)).toMatch(/8f2a1c9d4e7b0000/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('discards the proxy error page rather than truncating it into the message', () => {
    const html = '<!DOCTYPE html><html><body>error code: 524</body></html>';
    expect(errorForStatus(524, html).message).not.toMatch(/DOCTYPE/);
  });

  it('reaches the model as a readable failure, not a status line', () => {
    expect(said(failed(errorForStatus(524, 'HTTP 524')))).toMatch(/proxy.*\(HTTP 524\)/s);
  });

  it('keeps 504 pollable and 524 not', () => {
    // Same class, different answer, and the split is by where each is reachable
    // from: the wait tools poll with short requests, where a 504 is a blip. A
    // 524 is only reached past the ceiling, where retrying reproduces it.
    //
    // The one place a STATUS still decides a retry, and it has to be: a type
    // cannot separate two statuses that share it. Everything else moved to
    // classes in OPL-3724.
    expect(isTransientForPoll(errorForStatus(504, 'HTTP 504'))).toBe(true);
    expect(isTransientForPoll(errorForStatus(524, 'HTTP 524'))).toBe(false);
    // Neither is published. A gateway timeout is the case where the platform
    // has most likely acted already, so an embedder must not replay one blind.
    expect(isTransient(errorForStatus(504, 'HTTP 504'))).toBe(false);
    expect(isTransient(errorForStatus(524, 'HTTP 524'))).toBe(false);
  });

  it('keeps the ceiling on the status that has one, not on the class', () => {
    // 504 and 524 share a class and cannot share this wording. The two-minute
    // ceiling, "a larger timeout_s buys no time" and "background: true is what
    // runs something slower" are facts about a 524. A 504 comes from any hop at
    // no fixed deadline — an exec with timeout_s: 30 can take one after three
    // seconds — so every one of those sentences is false there. Hedging on "if
    // this was an exec" was the first attempt and did not fix it: the wrong
    // half was the status, not the route.
    const timedOut = errorForStatus(504, 'HTTP 504').message;
    for (const ceiling of ['two minutes', 'timeout_s', 'background: true', 'exec_poll']) {
      expect(timedOut).not.toMatch(ceiling);
    }
    // And it must not contradict the retry policy the same file acts on: this
    // wording tells the reader to try again, and the wait tools do.
    expect(isTransientForPoll(errorForStatus(504, 'HTTP 504'))).toBe(true);
    expect(timedOut).toMatch(/the same call again is the move/);

    // 524 keeps all of it, still hedged on the route, because a screenshot or a
    // listing can meet the same ceiling and neither takes a timeout_s.
    const ceiling = errorForStatus(524, 'HTTP 524').message;
    expect(ceiling).toMatch(/about two minutes/);
    expect(ceiling).not.toMatch(/Re-run it with/);
    const hedge = ceiling.indexOf('if this one was');
    expect(hedge).toBeGreaterThan(-1);
    for (const advice of ['timeout_s', 'background: true', 'exec_poll', 'guest agent as busy']) {
      expect(ceiling.indexOf(advice)).toBeGreaterThan(hedge);
    }
    // Both halves still say the thing the whole class exists to say.
    for (const said of [timedOut, ceiling]) {
      expect(said).toMatch(/Nothing was cancelled/);
    }
  });
});

describe('an edge that never reached the platform is not reported as a bare status', () => {
  // 520 is deliberately absent: it means the platform WAS reached and answered
  // unreadably, so it is neither this nor a gateway timeout. See its own tests.
  it.each([521, 522, 523])('writes a message for HTTP %s', (status) => {
    // The same bug as the 524 above, a few statuses along: these fell through
    // to Api's fallback and left the model reading `HTTP 522`.
    const err = errorForStatus(status, `HTTP ${status}`);
    expect(err).toBeInstanceOf(OriginUnreachableError);
    expect(err.status).toBe(status);
    expect(err.message).not.toMatch(/^HTTP /);
    expect(err.message).toMatch(/could not reach it/);
  });

  it.each([525, 526])('gives HTTP %s its own class, not the unreachable one', (status) => {
    // Same retry answer isTransient already gave by number, now visible in the
    // type: an unreachable origin is a passing outage, a certificate is not.
    const err = errorForStatus(status, `HTTP ${status}`);
    expect(err).toBeInstanceOf(OriginTLSError);
    expect(err).not.toBeInstanceOf(OriginUnreachableError);
    expect(err.message).toMatch(/TLS handshake/);
    expect(isTransient(err)).toBe(false);
  });

  it('says nothing survived, which is the opposite of what a 524 says', () => {
    // Worth pinning as a pair. A 524 means the request arrived and its work
    // carries on; these mean it never arrived. A caller reading either to
    // decide whether to expect a busy guest agent next must get opposite
    // answers, so the two messages must not converge.
    expect(errorForStatus(522, 'HTTP 522').message).toMatch(/nothing was started/);
    expect(errorForStatus(524, 'HTTP 524').message).toMatch(/carries on without it/);
  });

  it('retries an origin that is down but not a handshake that will not agree', () => {
    // An origin restart clears within a wait window. An expired or mismatched
    // certificate fails identically for the whole of one, so polling it just
    // spends the window to arrive at the same place.
    for (const status of [520, 521, 522, 523]) {
      expect(isTransientForPoll(errorForStatus(status, `HTTP ${status}`))).toBe(true);
    }
    for (const status of [525, 526]) {
      expect(isTransientForPoll(errorForStatus(status, `HTTP ${status}`))).toBe(false);
      expect(errorForStatus(status, `HTTP ${status}`).message).toMatch(/misconfigured/);
    }
  });

  it('does not discard a message an operator’s own gateway wrote', () => {
    // platformNamed does not ask whether the PLATFORM spoke — it asks whether
    // anything did, because a hop in front of a self-hosted MANDALA_BASE_URL is
    // one this server has never seen and cannot outrank. 521-526 substituted
    // unconditionally on the reading that a 522 provably is not the platform:
    // true, and the wrong test. A gateway that names its own fault knows more
    // about that deployment than the generic outage prose here does.
    const said = 'backend pool empty; scale the worker group';
    for (const status of [521, 522, 523, 525, 526]) {
      expect(errorForStatus(status, said, { error: said }).message).toBe(said);
      // Still substituted when nothing structured came back, which is the case
      // the substitution was written for.
      expect(errorForStatus(status, `HTTP ${status}`).message).not.toBe(`HTTP ${status}`);
    }
  });

  it('writes a message for a 502, the other status a proxy invents', () => {
    // Left out of the mapping while its neighbours were added, so it fell
    // through to a bare APIError — the model read `HTTP 502` or 500 characters
    // of nginx's HTML, which is the failure this whole range exists to remove.
    // It polls through isTransientForPoll, so the wait tools reach it and
    // replay whichever of those two it was into their give-up text.
    const err = errorForStatus(502, 'HTTP 502');
    expect(err).toBeInstanceOf(OriginResponseError);
    expect(err.message).not.toBe('HTTP 502');
    // And it must claim neither of the two things it cannot know. A 520 knows
    // the request arrived; a 502 is that failure and the unreachable one at
    // once, indistinguishable from here.
    expect(err.message).not.toMatch(/did arrive/);
    expect(err.message).not.toMatch(/nothing was started/);
    expect(err.message).toMatch(/unknown/);
    expect(err.message).toMatch(/check/);
    expect(isTransientForPoll(err)).toBe(true);
  });

  it('keeps the exported retry policy off every status whose outcome is unknown', () => {
    // The published contract, which an embedder wraps around calls this server
    // knows nothing about. Every one of these means the request may or may not
    // have been carried out, so `if (isTransient(err)) retry()` around a create
    // is how one computer becomes two.
    //
    // 502 and 504 were on this list until OPL-3724 and are the reason it was
    // rewritten: the docstring beside them already conceded that both can
    // arrive after the platform has acted, which is the same hazard the 52x
    // range was kept out for. A status that is not safe for the riskiest caller
    // of an exported predicate does not belong in it.
    for (const status of [502, 504, 520, 521, 522, 523, 524, 525, 526]) {
      expect(isTransient(errorForStatus(status, `HTTP ${status}`))).toBe(false);
    }
    // What survives is answered by TYPE, with no status numbers at all — the
    // same four classes the TypeScript and Python SDKs now name, so one
    // question has one answer in three clients.
    for (const status of [409, 429, 503]) {
      expect(isTransient(errorForStatus(status, `HTTP ${status}`))).toBe(true);
    }
    expect(isTransient(new ConnectivityError('fetch failed'))).toBe(true);
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
    // A host application embedding this server catches by class, and these are
    // the ones whose handling differs most: a gateway timeout leaves work
    // running behind it, an unreachable origin leaves none, and the other two
    // say where the exchange broke. Every class this branch adds to the public
    // surface is pinned, so dropping any one export line fails here rather
    // than silently narrowing what an embedder can catch.
    expect(PublicGatewayTimeoutError).toBe(GatewayTimeoutError);
    expect(PublicOriginResponseError).toBe(OriginResponseError);
    expect(PublicOriginTLSError).toBe(OriginTLSError);
    expect(PublicOriginUnreachableError).toBe(OriginUnreachableError);
  });

  it('exports every class its own retry predicate names', () => {
    // isTransient is exported and answers by TYPE alone since OPL-3724, so an
    // embedder who wants to know WHY it said yes has to be able to catch the
    // four classes it asks about. RateLimitError was the gap: 429 used to be a
    // number inside the predicate and had no class at all, so `retryAfterMs`
    // could not reach a caller and the platform's own "wait this long" was
    // thrown away by everyone but the poll loops.
    expect(isTransient(new ConflictError('the guest agent is not answering yet', 409))).toBe(true);
    expect(isTransient(new RateLimitError('slow down', 429))).toBe(true);
    expect(isTransient(new UnavailableError('a hypervisor is out of reach', 503))).toBe(true);
    expect(isTransient(new ConnectivityError('fetch failed'))).toBe(true);
    expect(PublicRateLimitError).toBe(RateLimitError);
    expect(new RateLimitError('slow down', 429, undefined, 30_000).retryAfterMs).toBe(30_000);
  });

  it('exports the one error that carries a number rather than only a message', () => {
    // A 416 answers with the file's real length on its Content-Range, and
    // RangeNotSatisfiableError is where that number survives the trip. An
    // embedder paging a guest file catches this to find out how long the file
    // it guessed about actually is; caught as a bare APIError, the length is
    // gone and the only way on is another guess.
    expect(PublicRangeNotSatisfiableError).toBe(RangeNotSatisfiableError);
    expect(new RangeNotSatisfiableError('outside the file', 416, undefined, 4096).size).toBe(4096);
  });

  it('does not repeat an empty HTTP error status', () => {
    expect(said(failed(errorForStatus(409, 'HTTP 409')))).toBe('HTTP 409');
    expect(said(failed(errorForStatus(409, 'guest still booting')))).toBe(
      'guest still booting (HTTP 409)',
    );
  });
});

describe('a snapshot with a reason attached to it', () => {
  let platform: ReturnType<typeof installFakePlatform>;

  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const captures = () => platform.calls.filter((c) => c.method === 'POST');

  it('sends the name the caller gave it', async () => {
    const { call, close } = await connect();
    await call('create_snapshot', { name: 'before the upgrade', memory: true });
    await close();
    expect(captures()).toHaveLength(1);
    expect(captures()[0].body).toEqual({ name: 'before the upgrade', memory: true });
  });

  it('omits a name nobody gave, rather than sending an empty one', async () => {
    // The platform reads an ABSENT name as "generate one from the computer and
    // the time" and an empty string as a name — so a `name: ''` on the wire is
    // the one way to end up with a snapshot that has no name at all, which is
    // worse than the generated one it replaced. Whitespace is the same input
    // wearing a disguise.
    const { call, close } = await connect();
    await call('create_snapshot', {});
    await call('create_snapshot', { name: '   ' });
    await close();
    expect(captures()).toHaveLength(2);
    for (const c of captures()) expect(c.body).toEqual({ memory: false });
  });

  it('says what the snapshot ended up called', async () => {
    // Including when the caller named nothing: the generated name is what
    // list_snapshots will show, and a caller who is never told it has to go
    // looking for the capture it just took.
    const { call, close } = await connect();
    expect(said(await call('create_snapshot', {}))).toContain('as "s"');
    await close();
  });

  it('does not invent a name when the platform sends none back', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'snap-9' }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const out = said(await call('create_snapshot', { name: 'clean install' }));
      expect(out).toContain('Snapshotted');
      expect(out).not.toContain(' as "');
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('builds the body from named arguments, not a positional flag', () => {
    // snapshotBody took a bare boolean until OPL-3747. The shape is pinned so
    // a second boolean cannot be appended to it later and be read the wrong way
    // round at the one call site.
    expect(P.snapshotBody({ memory: false })).toEqual({ memory: false });
    expect(P.snapshotBody({ memory: true, name: '  spaced  ' })).toEqual({
      memory: true,
      name: 'spaced',
    });
  });
});

describe('a guest that will not shut down', () => {
  let platform: ReturnType<typeof installFakePlatform>;

  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const stops = () => platform.calls.filter((c) => c.path.endsWith('/stop'));

  it('asks for the forced stop the caller asked for', async () => {
    const { call, close } = await connect();
    await call('stop_computer', { force: true });
    await close();
    expect(stops()).toHaveLength(1);
    // A string, not `1` and not `true`: the platform's schema for this one is
    // `enum: ['true']`, so anything else is a parameter it does not recognise.
    expect(stops()[0].query.get('force')).toBe('true');
  });

  it('omits force on a polite stop rather than sending it false', async () => {
    // `force=false` would be a value outside the platform's enum, which is a
    // 400 at best and an ignored parameter at worst — and the polite stop is
    // the one a caller gets by not asking for anything.
    const { call, close } = await connect();
    await call('stop_computer', {});
    await call('stop_computer', { force: false });
    await close();
    expect(stops()).toHaveLength(2);
    for (const s of stops()) expect(s.query.get('force')).toBeNull();
  });

  it('says the power was pulled, and says it only when it was', async () => {
    // The two stops are indistinguishable in the computer they leave behind:
    // both stopped, both with their disk. Only the answer can say which one
    // threw away what was in RAM.
    const { call, close } = await connect();
    expect(said(await call('stop_computer', { force: true }))).toContain('power was pulled');
    expect(said(await call('stop_computer', {}))).not.toContain('power was pulled');
    await close();
  });

  it('reads the Ack a power action answers as the ok it is', async () => {
    // OPL-3914, found by the first agent to drive this server from the skill.
    // The platform answers every power action with its Ack — `{ok: true}` and
    // no computer — and this server described that as a computer record:
    // `suspend: (unnamed) · (no id) · unknown`, which the agent read as a
    // suspend that had not taken. The id is the one we sent, and the fake
    // platform now answers the real shape, so the record path is only reached
    // if the platform ever changes its mind.
    const { call, close } = await connect();
    for (const tool of [
      'start_computer',
      'stop_computer',
      'suspend_computer',
      'restart_computer',
    ]) {
      const text = said(await call(tool, {}));
      expect(text, tool).toContain('ok — vm-1');
      expect(text, tool).not.toContain('unnamed');
      expect(text, tool).not.toContain('no id');
      expect(text, tool).not.toContain('unknown');
    }
    // A start is the one where "ok" and "usable" are furthest apart.
    expect(said(await call('start_computer', {}))).toContain('until="guest"');
    expect(said(await call('suspend_computer', {}))).not.toContain('until="guest"');
    await close();
  });

  it('still describes a computer record, and still strips its credentials, on either branch', async () => {
    // The fake platform answers the documented Ack, which means the record
    // path in `power` — and the credential sweep in behaviour.test.ts, which
    // runs the four power tools against that same fake — would otherwise be
    // exercised by nothing. So the record is answered here, once with an id and
    // once without: the second is the shape the Ack test is inferred from, and
    // a body with no id is not a body with no `vnc`.
    const { call, close } = await connect();
    const fake = globalThis.fetch;
    const answer = (record: Record<string, unknown>) => {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        if (url.pathname.endsWith('/suspend'))
          return new Response(JSON.stringify(record), {
            headers: { 'Content-Type': 'application/json' },
          });
        return fake(input as never, init);
      }) as typeof fetch;
    };
    const vnc = { url: 'wss://app.test/vnc?token=SECRET-CONTROL' };
    try {
      answer({ id: 'vm-1', name: 'desk', status: 'suspended', vnc });
      const record = await call('suspend_computer', {});
      expect(said(record)).toContain('suspend: desk · vm-1 · suspended');
      expect(JSON.stringify(record)).not.toContain('SECRET-CONTROL');

      answer({ ok: true, vnc });
      const ack = await call('suspend_computer', {});
      expect(said(ack)).toContain('suspend: ok — vm-1');
      expect(JSON.stringify(ack)).not.toContain('SECRET-CONTROL');
    } finally {
      globalThis.fetch = fake;
      await close();
    }
  });

  it('offers force on stop and on no other power tool', async () => {
    // start, suspend and restart are different operations with different
    // outcomes; the reason this GAP mattered is that a model with no `force`
    // reaches for one of them, or for delete_computer, instead.
    const { client, close } = await connect();
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    await close();
    expect(Object.keys(tools.get('stop_computer')?.inputSchema.properties ?? {}).sort()).toEqual([
      'computer_id',
      'force',
    ]);
    for (const other of ['start_computer', 'suspend_computer', 'restart_computer']) {
      expect(Object.keys(tools.get(other)?.inputSchema.properties ?? {})).toEqual(['computer_id']);
    }
  });

  it('warns about the lost work in the description, not only in the schema', async () => {
    const { client, close } = await connect();
    const stop = (await client.listTools()).tools.find((t) => t.name === 'stop_computer');
    await close();
    expect(stop?.description).toContain('force');
    const force = stop?.inputSchema.properties?.force as { description?: string } | undefined;
    expect(force?.description).toMatch(/lost|written to disk/);
  });
});

describe('an environment for a command, rather than a shell prefix', () => {
  let platform: ReturnType<typeof installFakePlatform>;

  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const execs = () => platform.calls.filter((c) => c.path.endsWith('/exec'));

  it('sends the variables the caller named', async () => {
    const { call, close } = await connect();
    await call('exec', { command: 'npm run build', env: { NODE_ENV: 'production' } });
    await close();
    expect(execs()).toHaveLength(1);
    expect(execs()[0].body).toMatchObject({ env: { NODE_ENV: 'production' } });
  });

  it('carries a value the shell would have taken apart', async () => {
    // The whole reason this argument exists. As `FOO=... cmd` every one of
    // these needs the caller to quote it, and the failure is silent: the
    // variable gets the first word, or the rest becomes another argument, or
    // $HOME is expanded by the guest's shell into something the caller never
    // wrote.
    const awkward = {
      MESSAGE: 'two words',
      QUOTED: `it's "fine"`,
      LITERAL: '$HOME and `date`',
      MULTILINE: 'first\nsecond',
    };
    const { call, close } = await connect();
    await call('exec', { command: 'env', env: awkward });
    await close();
    expect((execs()[0].body as Record<string, unknown>).env).toEqual(awkward);
  });

  it('omits an environment nobody gave, rather than sending an empty one', async () => {
    const { call, close } = await connect();
    await call('exec', { command: 'true' });
    await call('exec', { command: 'true', env: {} });
    await close();
    expect(execs()).toHaveLength(2);
    for (const c of execs()) expect(c.body).not.toHaveProperty('env');
  });

  it('refuses a name that is the assignment, before waking the computer', async () => {
    // `{'FOO=bar': ''}` is the prefix-assignment mistake moved into the object,
    // and the platform only notices it after `use` has resumed a suspended
    // guest and billed for the resume. Refused here, nothing is called at all.
    const { call, close } = await connect();
    const res = await call('exec', { command: 'true', env: { 'FOO=bar': '' } });
    expect(res.isError).toBe(true);
    expect(said(res)).toContain("{FOO: 'bar'}");
    expect(execs()).toHaveLength(0);
    await close();
  });

  it.each([
    ['an empty name', { '': 'x' }, /empty name/i],
    ['a NUL in a name', { 'A\0B': 'x' }, /NUL/],
    ['a NUL in a value', { A: 'x\0y' }, /NUL/],
  ])('refuses %s, which the guest agent would silently truncate', async (_what, env, why) => {
    const { call, close } = await connect();
    const res = await call('exec', { command: 'true', env });
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(why);
    expect(execs()).toHaveLength(0);
    await close();
  });

  it('leaves the platform to police how many and how long', () => {
    // The ceilings (64 entries, 4096 bytes an entry) are the platform's policy
    // and are not mirrored here, so a change to them is not a change that has
    // to land in two repositories to take effect.
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`V${i}`, 'x']));
    expect(() => P.execEnv(many)).not.toThrow();
    expect(() => P.execEnv({ BIG: 'x'.repeat(10_000) })).not.toThrow();
  });

  it('drops an empty environment at the body rather than at the tool', () => {
    expect(P.execEnv(undefined)).toBeUndefined();
    expect(P.execEnv({})).toBeUndefined();
    expect(P.execBody({ command: 'true', env: {} })).toEqual({ command: 'true' });
    expect(P.execBody({ command: 'true', env: { A: '1' } })).toEqual({
      command: 'true',
      env: { A: '1' },
    });
  });

  it('is a launch argument, so exec_poll does not take one', async () => {
    // `env` belongs to starting a process. Offering it on the poll would be an
    // argument that changes nothing, on the one tool a model calls repeatedly.
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    await close();
    const poll = tools.find((t) => t.name === 'exec_poll');
    expect(Object.keys(poll?.inputSchema.properties ?? {})).not.toContain('env');
  });
});

describe('leftover argv', () => {
  it('refuses a positional instead of starting the stdio server', () => {
    expect(() => parse(['help'])).toThrow(/unexpected argument help/);
    expect(() => parse(['--http', 'please'])).toThrow(/unexpected argument please/);
  });
});

describe('read_file raster images and text', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('does not return SVG as MCP image content', async () => {
    globalThis.fetch = (async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml', 'Content-Length': '47' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/tmp/icon.svg' });
    await close();
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    expect(said(res)).toContain('<svg');
  });

  it('keeps a file of real U+FFFD characters as text', async () => {
    const body = 'one \uFFFD two \uFFFD three';
    globalThis.fetch = (async () =>
      new Response(Buffer.from(body, 'utf8'), {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(Buffer.byteLength(body)),
        },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/tmp/replacements.txt' });
    await close();
    expect(said(res)).toContain(body);
    expect(said(res)).not.toMatch(/Base64:/);
  });

  it('does not render an empty window as bytes N--1', async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(), {
        status: 206,
        headers: {
          'Content-Type': 'text/plain',
          'Accept-Ranges': 'bytes',
          'Content-Range': 'bytes 5-5/100',
          'Content-Length': '0',
        },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/tmp/log.txt', offset: 5 });
    await close();
    expect(said(res)).toContain('empty window at offset 5 of 100');
    expect(said(res)).not.toMatch(/bytes 5--1/);
  });

  it('applies the text cap to SVG instead of the 8 MiB image window', async () => {
    const body = `<svg>${'x'.repeat(300 * 1024)}</svg>`;
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml',
          'Content-Length': String(Buffer.byteLength(body)),
        },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/tmp/big.svg' });
    await close();
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    expect(said(res)).toContain(`bytes 0-${256 * 1024 - 1}`);
    expect(said(res)).toMatch(/truncated: showed 262144 of 307211/);
    expect(said(res).length).toBeLessThan(MAX_INLINE_IMAGE_BYTES);
  });

  it('does not treat an invalid 0xff 0xfe suffix as truncated UTF-8', async () => {
    const body = Buffer.concat([Buffer.from('hello'), Buffer.from([0xff, 0xfe])]);
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.length),
        },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/tmp/blob.bin' });
    await close();
    expect(said(res)).toMatch(/Base64:/);
    expect(said(res)).toContain(body.toString('base64'));
  });
});

describe('selection generations under eviction pressure', () => {
  it('does not evict a generation an in-flight use_computer still holds', () => {
    const session = new Session({ apiKey: 'com_test', baseUrl: BASE });
    const snapped = session.beginSelection('vm-target');
    expect(snapped).toBe(0);
    session.unbind('vm-target');
    for (let i = 0; i < 300; i++) session.unbind(`vm-other-${i}`);
    expect(session.bindIfCurrent('vm-target', '1280x800x24', snapped)).toBe(false);
    session.endSelection('vm-target');
  });
});

describe('a connection failure after the request was sent (OPL-3855)', () => {
  // The hazard, as one sentence: `computers.create()` reaches the platform, the
  // platform builds the computer, and the socket dies while the response is
  // being read. Every client wrapped that in the class whose name says the
  // request never left, so `isTransient` said yes, an embedder replayed the
  // create, and the account paid for two computers.
  //
  // Real sockets rather than a stubbed fetch, deliberately. What is under test
  // is whether undici's cause chain can be read to tell the two phases apart —
  // a stub that throws a hand-made error would only test the classifier against
  // errors this file invented, which is the half that was never in doubt.

  /** A TCP server that behaves however the test needs, and the base URL for it. */
  const serving = async (
    handler: (socket: Socket) => void,
    scheme: 'http' | 'https' = 'http',
  ): Promise<{ url: string; close: () => Promise<void> }> => {
    const server = createSocketServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `${scheme}://127.0.0.1:${port}/api/v1`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  };

  const failureFrom = async (url: string): Promise<unknown> => {
    try {
      await new Api('com_test', url).json('GET', 'computers');
      throw new Error('expected the request to fail');
    } catch (err) {
      return err;
    }
  };

  it('says the request never left only when it can prove that', async () => {
    // A closed port and a name that does not resolve. Nothing was written, so
    // replaying even a create is safe and the public predicate may say so.
    //
    // Port 2 rather than an ephemeral one bound and closed here: the OS is free
    // to hand a just-released ephemeral port to another listener, and this suite
    // runs files concurrently with test/http.test.ts binding dozens of them — a
    // collision would dispatch the request and fail below, pointing at the
    // classifier rather than at the port. Not port 1, which fetch refuses
    // outright as a bad port, so it never reaches a connect to be refused.
    for (const url of ['http://127.0.0.1:2/api/v1', 'http://no-such-host-xyzzy.invalid/api/v1']) {
      const err = await failureFrom(url);
      expect(err).toBeInstanceOf(ConnectivityError);
      expect(err).not.toBeInstanceOf(ConnectivityInterruptedError);
      expect(isTransient(err)).toBe(true);
      expect(isTransientForPoll(err)).toBe(true);
    }
  });

  it('does not read a TLS alert after the handshake as a connect failure', async () => {
    // The prefix that used to be here — `ERR_SSL_` — is how Node spells every
    // OpenSSL reason, fatal alerts included, and an alert can arrive on any
    // record. A TLS-terminating proxy that dies while the response is being
    // read answers one of these with the request long since on the wire, so the
    // prefix put a possibly-dispatched failure into the class that says nothing
    // was sent. That is the bug this whole file is about, reintroduced by the
    // first fix for it.
    const real = globalThis.fetch;
    try {
      for (const code of [
        'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
        'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
        'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
        // Node's own prefix is no safer, which is why neither survived:
        // renegotiation is by definition mid-connection.
        'ERR_TLS_RENEGOTIATION_DISABLED',
      ]) {
        globalThis.fetch = (async () => {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error(code), { code }),
          });
        }) as typeof fetch;
        const err = await new Api('com_test', BASE)
          .json('GET', 'computers')
          .catch((e: unknown) => e);
        expect(err, code).toBeInstanceOf(ConnectivityInterruptedError);
        expect(isTransient(err), code).toBe(false);
      }
      // And the handshake codes that ARE named still answer the other way, so
      // this is a narrowing rather than a surrender.
      for (const code of ['ERR_SSL_WRONG_VERSION_NUMBER', 'CERT_HAS_EXPIRED']) {
        globalThis.fetch = (async () => {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error(code), { code }),
          });
        }) as typeof fetch;
        const err = await new Api('com_test', BASE)
          .json('GET', 'computers')
          .catch((e: unknown) => e);
        expect(err, code).toBeInstanceOf(ConnectivityError);
        expect(err, code).not.toBeInstanceOf(ConnectivityInterruptedError);
        expect(isTransient(err), code).toBe(true);
      }
    } finally {
      globalThis.fetch = real;
    }
  });

  it('treats a handshake failure as a connect failure', async () => {
    // TLS completes before the request exists, so a certificate or protocol
    // mismatch is still "never left" — here, https onto a plaintext port.
    const { url, close } = await serving((socket) => {
      socket.on('data', () => socket.write('not tls at all\r\n'));
    }, 'https');
    try {
      const err = await failureFrom(url);
      expect(err).toBeInstanceOf(ConnectivityError);
      expect(err).not.toBeInstanceOf(ConnectivityInterruptedError);
      expect(isTransient(err)).toBe(true);
    } finally {
      await close();
    }
  });

  it('does not promise a blind replay once the request is on the wire', async () => {
    // Three shapes of the same outcome — the platform got the request and the
    // answer was lost — and the phase is what they share, not the errno.
    const cases: Array<[string, (socket: Socket) => void]> = [
      ['reset with the request sent', (socket) => socket.on('data', () => socket.destroy())],
      [
        'a response that is not HTTP',
        (socket) =>
          socket.on('data', () => {
            socket.write('NOT HTTP AT ALL\r\n\r\n');
            socket.end();
          }),
      ],
      [
        'a body that dies mid-stream',
        (socket) =>
          socket.on('data', () => {
            socket.write(
              'HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Type: application/json\r\n\r\n{"a":',
            );
            setTimeout(() => socket.destroy(), 30);
          }),
      ],
    ];
    for (const [what, handler] of cases) {
      const { url, close } = await serving(handler);
      try {
        const err = await failureFrom(url);
        expect(err, what).toBeInstanceOf(ConnectivityInterruptedError);
        // Still a ConnectivityError, which is what makes the split non-breaking:
        // an existing catch block, and the poll predicate's floor, see no change.
        expect(err, what).toBeInstanceOf(ConnectivityError);
        // The two predicates, disagreeing on purpose. A create must not be
        // replayed blind; a GET the wait loops poll may be read again.
        expect(isTransient(err), what).toBe(false);
        expect(isTransientForPoll(err), what).toBe(true);
        // And the message says which of the two happened, since the old one
        // told every reader the platform had not been reached.
        expect((err as Error).message, what).toMatch(/unknown rather than undone/);
      } finally {
        await close();
      }
    }
  });

  it('is the same class through the public entrypoint', () => {
    // src/index.ts is the library face, and a second copy of a class is a
    // silent `instanceof` that never matches.
    expect(PublicConnectivityInterruptedError).toBe(ConnectivityInterruptedError);
    expect(new PublicConnectivityInterruptedError('lost') instanceof PublicConnectivityError).toBe(
      true,
    );
  });

  it('rides out a body reset it used to die on', () => {
    // The half of this that was not a predicate bug. A socket that dies
    // mid-body surfaces from fetch as `TypeError: terminated`, which the old
    // name-only test in readBody did not match, so it came out as a raw
    // TypeError — neither transient nor pollable. A wait loop ended reporting a
    // machine unreachable over a blip it existed to outlast.
    const terminated = new TypeError('terminated');
    (terminated as { cause?: unknown }).cause = Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    });
    expect(isTransientForPoll(terminated)).toBe(false);
    expect(isTransientForPoll(new ConnectivityInterruptedError('lost'))).toBe(true);
  });
});

describe('the tools our own prose tells a model to call', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  // OPL-3869. `get_desktop_url` spent its whole life telling the agent to move
  // text with `run_command`, and there has never been a tool by that name — the
  // command tool is `exec`. Nothing caught it because a description is a
  // string, and a string that names a tool is indistinguishable from a string
  // that does not until a model tries to call it and gets nothing back.
  //
  // So: every tool-shaped identifier we write, in a description or in an answer,
  // has to be a tool we register. The pattern is anchored on the verbs the
  // registry actually uses, which is what keeps `computer_id`, `allow_partial`
  // and `view_url` out of it while `run_command` lands squarely in.
  // Every snake_case identifier, not a verb allowlist. The allowlist was the
  // second version of this test and it was wrong in the way allowlists are:
  // `execute_command` and `invoke_tool` are exactly the shape of the bug and
  // neither starts with a verb we thought to enumerate. So the net is cast wide
  // and the non-tool wire identifiers we legitimately write are named here,
  // where adding one is a deliberate line in a diff rather than a silence.
  //
  // EVERY ENTRY MUST BE A WIRE IDENTIFIER — a parameter, a response field, a
  // header — and never a tool. That is a rule for the reader, because no test
  // can enforce it: `take_snapshot` sat on this list whitelisting the exact
  // phantom name the commit above had just deleted from `get_desktop_url`, and
  // an attempt to catch that automatically foundered on `view_token` and
  // `clipboard_channel`, which are genuine platform fields this server never
  // spells in its own source either. Absence from `src/` does not separate the
  // two. So: before adding a line here, say which field it is. If you cannot
  // name one, it is a tool that does not exist and the fix is in the prose.
  const IDENTIFIER = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
  const SKILL = new URL('../plugin/skills/mandala-computer/SKILL.md', import.meta.url);
  const NOT_TOOLS = new Set([
    // Parameters and response fields we name in prose, on purpose.
    'computer_id',
    'allow_partial',
    'ram_mb',
    'disk_gb',
    'idle_suspend_min',
    'timeout_s',
    // run_agent's own loop bound, named in its description because a client
    // that cannot hold the request open past its default timeout has to lower
    // it. A parameter, not a tool.
    'max_steps',
    'snapshot_id',
    'template_id',
    'build_id',
    'workspace_id',
    'exit_code',
    'view_url',
    'view_token',
    'embed_url',
    'terminal_url',
    'created_at',
    'started_at',
    'finished_at',
    'build_failed',
    'snapshot_schedule',
    'idle_console',
    'boot_capture',
    'clipboard_channel',
    'cheapest_plan',
    'from_x',
    'from_y',
    // A field on what poll_events and wait_for_event answer with (OPL-3926):
    // how many events are still buffered behind the batch that was returned.
    'more_waiting',
    // A delivery state on what list_webhook_deliveries answers with (OPL-4306):
    // an attempt is running. A state, not a tool.
    'in_flight',
  ]);

  it('names only tools that exist', async () => {
    // WITH a model key, which is not a detail. `run_agent` is registered only
    // when one is present, so a keyless server hides both its own description
    // and its name — and a scan run that way would have called a mention of
    // `run_agent` in somebody else's description a phantom tool. The registry
    // has to be the widest one this server can have.
    const { client, call, close } = await connect({ modelKey: 'sk-test' });
    const registered = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(registered.has('run_agent'), 'the keyed server registers run_agent').toBe(true);

    const prose: { where: string; text: string }[] = [];
    // The server's own instructions, which are prose a model reads BEFORE any
    // tool description and which name eight tools. They were outside the scan
    // entirely — the largest single piece of tool-naming text we ship.
    prose.push({ where: 'server instructions', text: client.getInstructions() ?? '' });
    // The Claude Code skill (OPL-3914), which is prose a model reads before it
    // has even started this server, and which names more tools than the
    // instructions do. It is the text most likely to drift: a tool renamed here
    // is renamed in its description by the same diff, and in the skill by
    // nobody — the skill is a Markdown file the compiler never reads.
    prose.push({
      where: 'plugin/skills/mandala-computer/SKILL.md',
      text: readFileSync(SKILL, 'utf8'),
    });
    for (const t of (await client.listTools()).tools) {
      prose.push({ where: `${t.name} description`, text: t.description ?? '' });
      for (const [arg, schema] of Object.entries(t.inputSchema.properties ?? {})) {
        const d = (schema as { description?: string }).description;
        if (d) prose.push({ where: `${t.name}.${arg} description`, text: d });
      }
    }
    // The answers too, not only the schema. The bug was in an answer — and
    // `get_desktop_url` has TWO of them behind the platform's clipboard field
    // (OPL-3870), so the bridged fixture is asked for as well. The branch it
    // reaches is the one that names no cold-boot recipe; the branch the default
    // computer reaches names five tools, and a scan that saw only one of the
    // two would be blind to whichever it missed.
    for (const args of [{}, { control: true }, { computer_id: 'vm-bridged', control: true }]) {
      prose.push({
        where: `get_desktop_url(${JSON.stringify(args)}) answer`,
        text: said(await call('get_desktop_url', args)),
      });
    }

    const wrong: string[] = [];
    for (const { where, text } of prose) {
      for (const name of text.match(IDENTIFIER) ?? []) {
        if (registered.has(name) || NOT_TOOLS.has(name)) continue;
        wrong.push(`${where} names \`${name}\``);
      }
    }
    expect(wrong, 'text that tells a model to call something we do not register').toEqual([]);
    await close();
  });

  // OPL-3680. The tool half of the skill is guarded above; the environment half
  // was not guarded at all, and it is the half a reader acts on BEFORE any tool
  // exists to be wrong about. A variable renamed in `cli.ts` is renamed in the
  // usage text by the same diff and in this Markdown file by nobody, and the
  // failure that produces is the worst-shaped one this server has: the server
  // starts, the variable is ignored, and every symptom surfaces somewhere else.
  const MANDALA_VAR = /\bMANDALA_[A-Z_]+\b/g;

  it('names only environment variables the CLI reads', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    // What `cli.ts` actually calls `env()` on — not what its own usage text
    // claims, which is prose and can be wrong in exactly the way this test
    // exists to catch.
    const read = new Set([...cli.matchAll(/\benv\('(MANDALA_[A-Z_]+)'\)/g)].map((m) => m[1]));
    expect(read.size, 'the reader found the env() calls it is parsing').toBeGreaterThan(4);
    const named = new Set(readFileSync(SKILL, 'utf8').match(MANDALA_VAR) ?? []);
    expect(named.size, 'the skill still documents the environment').toBeGreaterThan(0);
    expect(
      [...named].filter((v) => !read.has(v)).sort(),
      'the skill tells a user to export something the server never reads',
    ).toEqual([]);
  });

  it('passes every stdio variable it documents through the plugin manifest', () => {
    // The manifest is the only path those variables take under the plugin:
    // Claude Code starts the server with that env block and nothing else, so a
    // variable documented in the skill and absent there is documented and
    // inert. The exemptions are not stdio settings — they configure the --http
    // listener, which the plugin does not start.
    const HTTP_ONLY = new Set(['MANDALA_ALLOWED_HOSTS', 'MANDALA_ALLOWED_ORIGINS']);
    const plugin = JSON.parse(
      readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    ) as { mcpServers: Record<string, { env?: Record<string, string> }> };
    const passed = plugin.mcpServers.mandala.env ?? {};
    const named = [...new Set(readFileSync(SKILL, 'utf8').match(MANDALA_VAR) ?? [])].filter(
      (v) => !HTTP_ONLY.has(v),
    );
    expect(
      named.filter((v) => !Object.hasOwn(passed, v)).sort(),
      'documented in the skill, and the plugin never hands it to the server',
    ).toEqual([]);
    // Each forwarded from the variable of the same name, and defaulting to
    // empty rather than leaving the literal `${…}` an unset variable would
    // otherwise become — every one of these reads an empty value as unset.
    for (const [name, value] of Object.entries(passed)) {
      expect(value, `${name} is forwarded from the shell's own ${name}`).toBe(`\${${name}:-}`);
    }
  });
});

describe('a refusal the platform put a word on', () => {
  // OPL-3898, and the case it was filed for is the clipboard's. A read or a
  // write against a computer that is STOPPED answers 409, and so does a write
  // that lost the X selection for an instant. One is fixed by sending the same
  // request again and the other only by starting the computer, and until the
  // platform added `reason` the two differed by a sentence it is free to
  // reword — so `isTransient` said yes to both and a generic retry loop spun
  // against a stopped machine until somebody's deadline.
  it('is told apart by the word and not by the sentence', () => {
    const stopped = errorForStatus(409, 'this computer is not running, so it has no clipboard', {
      error: 'this computer is not running, so it has no clipboard',
      reason: 'unavailable',
    });
    const taken = errorForStatus(409, 'the desktop did not take the text', {
      error: 'the desktop did not take the text (something else claimed its clipboard); try again',
      reason: 'contention',
    });
    // Both 409s, both ConflictError, and the answer differs — which is the
    // whole point. Before this, the type was all there was to go on.
    expect(stopped).toBeInstanceOf(ConflictError);
    expect(taken).toBeInstanceOf(ConflictError);
    expect((stopped as APIError).reason).toBe('unavailable');
    expect(isTransient(stopped)).toBe(false);
    expect(isTransient(taken)).toBe(true);
  });

  it('is read off a 400 as readily as off a 409', () => {
    // `unavailable` arrives on both: whoever loses the race to the running
    // check hears the same fact the caller a moment earlier heard, answered
    // 400. Reading the word only on ConflictError would have classified the
    // one and not the other, and a status is not what this is a property of.
    const underfoot = errorForStatus(400, 'the computer stopped underfoot', {
      error: 'the computer stopped underfoot',
      reason: 'unavailable',
    });
    const windows = errorForStatus(400, 'the clipboard is not supported on Windows computers', {
      error: 'the clipboard is not supported on Windows computers',
      reason: 'unsupported',
    });
    expect((underfoot as APIError).reason).toBe('unavailable');
    expect((windows as APIError).reason).toBe('unsupported');
    expect(isTransient(underfoot)).toBe(false);
    expect(isTransient(windows)).toBe(false);
  });

  it('leaves a fifth word, and a malformed one, to the answer we had before', () => {
    // The platform states that an unrecognised value means "no classification
    // given" — which is what makes adding a word later safe. Both memberships
    // are tested rather than one being inferred from the other, so a word this
    // version has never heard of falls through to the type instead of reading
    // as permanent and stopping a retry that would have worked.
    const fifth = errorForStatus(409, 'something new', {
      error: 'something new',
      reason: 'wedged',
    });
    expect((fifth as APIError).reason).toBe('wedged');
    expect(isTransient(fifth)).toBe(true);
    // Shape-checked like the move offer, and for its reason: this decides a
    // retry policy, so a `reason` that is not a string has to read as nothing
    // said rather than as a refusal that never clears.
    const wrongType = errorForStatus(409, 'x', { error: 'x', reason: 5 });
    expect((wrongType as APIError).reason).toBeUndefined();
    expect(isTransient(wrongType)).toBe(true);
    const unclassified = errorForStatus(409, 'x', { error: 'x' });
    expect((unclassified as APIError).reason).toBeUndefined();
    expect(isTransient(unclassified)).toBe(true);
  });

  it('is still polled through, because a poll is the one caller it may clear for', () => {
    // The deliberate divergence between the two predicates. `unavailable` is a
    // permanent answer to whoever asked — and a computer coming up passes
    // through it, so the wait loops, which only ever replay a read under a
    // deadline the caller set, keep riding it out. They return a refusal of
    // their own the moment the status they are watching says stopped.
    const stopped = errorForStatus(409, 'this computer is not running', {
      error: 'this computer is not running',
      reason: 'unavailable',
    });
    expect(isTransient(stopped)).toBe(false);
    expect(isTransientForPoll(stopped)).toBe(true);
  });

  it('reaches the model as the sentence it means', async () => {
    // The word is for a program, and the program on the other end of a tool
    // call is a model that sees nothing but text. So the classification is
    // rendered rather than dropped — without this, the model reads the same
    // prose the predicate could not act on and loops on a stopped computer.
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: 'this computer is not running, so it has no clipboard',
          reason: 'unavailable',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('read_clipboard', { computer_id: 'vm-1' });
      expect(res.isError).toBe(true);
      const text = said(res);
      expect(text).toContain('this computer is not running, so it has no clipboard');
      expect(text).toMatch(/does NOT clear by waiting/);
      expect(text).toContain('start_computer');
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('says nothing extra about a refusal the platform did not classify', async () => {
    // Appended rather than substituted, and only where there is a word: most
    // refusals have none and always will, and those have to read exactly as
    // they did before this existed.
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "the guest's desktop is not answering yet" }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('read_clipboard', { computer_id: 'vm-1' });
      expect(said(res)).toBe("the guest's desktop is not answering yet (HTTP 409)");
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("the desktop socket's clipboard, as the platform now reports it", () => {
  // OPL-3870. This answer used to say "there is no capability field, and a
  // failed attempt does not distinguish an absent channel from a browser that
  // refused the paste" — instruction handed to an agent whose honest form was
  // "try it and see". The platform resolves all three terms it could not see
  // — the vdagent channel, whether the image was verified to carry the agent,
  // and the guest's OS — into one boolean on the body this tool already reads.
  const real = globalThis.fetch;
  const computerWith = (vnc: Record<string, unknown>) =>
    (globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'vm-1', status: 'running', os: 'linux', vnc }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch);
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('says the clipboard crosses the socket where the platform says it was provisioned', async () => {
    computerWith({ url: 'wss://app.test/vnc?token=SECRET', clipboard: true });
    const { call, close } = await connect();
    const text = said(await call('get_desktop_url', { control: true }));
    expect(text).toMatch(/CLIPBOARD CROSSES THIS SOCKET/);
    // Provisioning rather than a live check, which is the caveat a caller acts
    // on: root in that guest can stop the agent afterwards and this does not
    // move, so the endpoints stay the fallback.
    expect(text).toMatch(/PROVISIONED/);
    expect(text).toContain('read_clipboard');
    // And no cold-boot recipe, which is advice for the other branch entirely.
    expect(text).not.toMatch(/stop_computer/);
    await close();
  });

  it('says it does not, and which half to go and get, where the platform says false', async () => {
    computerWith({ url: 'wss://app.test/vnc?token=SECRET', clipboard: false });
    const { call, close } = await connect();
    const text = said(await call('get_desktop_url', { control: true }));
    expect(text).toMatch(/DOES NOT CROSS THIS SOCKET/);
    expect(text).toContain('stop_computer');
    expect(text).toContain('write_clipboard');
    await close();
  });

  it('reads an absent field as false rather than as unknown', async () => {
    // The two ways to be wrong are not symmetric. A false about a working
    // bridge costs the model nothing, since the clipboard tools work there
    // too; a true about an absent one is the silently dropped paste the field
    // exists to end. mandala-computer-python defaults it the same way.
    computerWith({ url: 'wss://app.test/vnc?token=SECRET' });
    const { call, close } = await connect();
    const text = said(await call('get_desktop_url', { control: true }));
    expect(text).toMatch(/DOES NOT CROSS THIS SOCKET/);
    // And never the sentence this ticket was raised over.
    expect(text).not.toMatch(/no capability field/i);
    await close();
  });

  it('does not let a non-string URL through as a link', async () => {
    // `vnc` carries a boolean now, so the object is no longer one type. A
    // number where a URL goes has to read as an absent link rather than be
    // handed on as one and printed under a sentence promising full control.
    computerWith({ url: 42, clipboard: true });
    const { call, close } = await connect();
    const res = await call('get_desktop_url', { control: true });
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/no control URL/i);
    await close();
  });
});

describe('a computer whose background slots are all held', () => {
  // OPL-3909. A computer runs at most sixteen background commands (platform
  // OPL-3584), and the seventeenth is refused 409 with no `reason` on it —
  // deliberately, because the slots may be held by servers and the platform
  // will not advise a retry it cannot promise (platform OPL-3898). This client
  // then said nothing about any of it: `background` recommends the flag for
  // exactly the workload that accumulates handles, no description mentioned a
  // ceiling, and `isTransient` fell back to the type answer for a 409 — which
  // is yes. A host application looping on that predicate spun against a full
  // slot table while the model read a sentence with no next step in it.
  //
  // What is pinned here is the seam. The refusal becomes a next step that names
  // the tool which frees a slot; the two predicates are untouched and still
  // answer by type and by the platform's word; and every other conflict on this
  // route reads exactly as it did before, because the match is on prose and
  // prose is what OPL-3724 got this client out of everywhere it decides a
  // program's behaviour.
  const real = globalThis.fetch;
  const conflict = (body: Record<string, unknown>) =>
    (globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch);
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('is answered with the tool that frees a slot, not with another attempt', async () => {
    conflict({ error: 'this computer already has 16 background commands running' });
    const { call, close } = await connect();
    const res = await call('exec', { command: 'npm run dev', background: true });
    await close();

    expect(res.isError).toBe(true);
    const text = said(res);
    // The platform's own sentence survives whole: it is the one that says how
    // many are running and on which computer.
    expect(text).toContain('this computer already has 16 background commands running');
    // And the two things that sentence does not say.
    expect(text).toContain('exec_kill');
    expect(text).toContain('16 are held now');
    // Stopping short of "never retry", which would be false: a build among the
    // sixteen finishes on its own. The answer names both situations.
    expect(text).toMatch(/servers, they do not exit/);
    expect(text).toMatch(/builds or installs/);
  });

  it('reads the cap back off the message rather than writing sixteen into it', async () => {
    // The count is the platform's, so raising the cap there cannot turn this
    // paragraph into a lie about how many are running.
    conflict({ error: 'this computer already has 32 background commands running' });
    const { call, close } = await connect();
    const text = said(await call('exec', { command: 'sleep 600', background: true }));
    await close();
    expect(text).toContain('all 32 are held now');
    expect(text).not.toContain('16');
  });

  it('leaves every other conflict on this route exactly as it was', async () => {
    // The guard against the failure mode of matching prose. A guest agent busy
    // with another call is the ordinary 409 here, it clears on its own, and
    // dressing it up as a full slot table would send the model to kill a
    // command that is not the problem.
    conflict({ error: 'the guest agent is busy with another call' });
    const { call, close } = await connect();
    const text = said(await call('exec', { command: 'true', background: true }));
    await close();
    expect(text).toBe('the guest agent is busy with another call (HTTP 409)');
    expect(text).not.toContain('exec_kill');
  });

  it('defers to the platform if a later version does classify this refusal', async () => {
    // The word is the channel built for deciding this, and it wins. A future
    // platform that says `contention` here knows something this file does not,
    // and two answers arriving at once — one of them guessed off a sentence —
    // is worse than the one that was designed.
    conflict({
      error: 'this computer already has 16 background commands running',
      reason: 'contention',
    });
    const { call, close } = await connect();
    const text = said(await call('exec', { command: 'sleep 600', background: true }));
    await close();
    expect(text).toContain('worth sending again');
    expect(text).not.toContain('exec_kill');
  });

  it('does not read a foreground conflict as a full slot table', async () => {
    // The refusal is only reachable by asking for a slot, so a foreground exec
    // that somehow met this sentence is a platform this client does not
    // understand — and the conservative answer there is the one it gave before.
    conflict({ error: 'this computer already has 16 background commands running' });
    const { call, close } = await connect();
    const text = said(await call('exec', { command: 'true' }));
    await close();
    expect(text).not.toContain('exec_kill');
  });

  it('says the cap in the descriptions a model reads before it calls anything', async () => {
    // The other half of the ticket, and the half that prevents the refusal
    // rather than explaining it. `background` is recommended for servers, which
    // is the workload that fills the table, so the ceiling belongs beside that
    // recommendation and not only in the error.
    const { client, close } = await connect();
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    await close();

    const exec = tools.get('exec');
    expect(exec?.description).toMatch(/sixteen background commands/);
    const background = exec?.inputSchema.properties?.background as { description?: string };
    expect(background.description).toMatch(/sixteen/);
    expect(background.description).toContain('exec_kill');
    // And the two tools that hold the other end of a handle say what a slot is
    // and what returns one.
    expect(tools.get('exec_kill')?.description).toMatch(/sixteen background commands/);
    expect(tools.get('exec_poll')?.description).toMatch(/releases[\s\S]*background slot/);
  });

  it('leaves the exported retry predicates answering by type and by word', () => {
    // The line this change does not cross. `isTransient` is a contract with
    // embedders, mirrored word for word by two other clients, and teaching it
    // this sentence is the OPL-3724 mistake with a wider blast radius. It still
    // says yes, honestly, and the next step lives in the tool that can print
    // the platform's words beside it.
    const full = errorForStatus(409, 'this computer already has 16 background commands running', {
      error: 'this computer already has 16 background commands running',
    });
    expect(full).toBeInstanceOf(ConflictError);
    expect((full as APIError).reason).toBeUndefined();
    expect(isTransient(full)).toBe(true);
    expect(isTransientForPoll(full)).toBe(true);
  });
});

describe('a window action whose outcome came back unknown', () => {
  // OPL-3910. The platform gives `POST /computers/:id/windows/:window` a 504
  // and the sentence that goes with it: if the guest accepts the action and does
  // not report the result before the deadline, the route answers 504 with no
  // `reason` on purpose, because the action may already have happened and an
  // uncertain outcome is not permission to repeat it (platform OPL-3898).
  //
  // Nothing in this server retries this route — `isTransientForPoll` rides a 504
  // out, but only the wait loops ask it, and they replay reads. The exposure is
  // the MODEL: it met a timeout under a message ending "the same call again is
  // the move", written for the reads and creates that wording is true of. For a
  // `move` a second attempt is untidy; for a `close` it is destructive, and
  // there is no undo for a document that was holding unsaved work.
  const real = globalThis.fetch;
  const answering = (status: number, body?: Record<string, unknown>) =>
    (globalThis.fetch = (async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      })) as typeof fetch);
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('is answered with a read, and never with the same call again', async () => {
    answering(504);
    const { call, close } = await connect();
    const res = await call('window_action', {
      window_id: '0x2600003',
      action: 'move',
      x: 10,
      y: 20,
    });
    await close();

    expect(res.isError).toBe(true);
    const text = said(res);
    expect(text).toContain('UNKNOWN');
    expect(text).toContain('may already have been applied');
    expect(text).toContain('list_windows');
    // And not the generic 504 tail, which is the sentence this route cannot
    // afford: it is written for callers whose request is safe to replay.
    expect(text).not.toContain('the same call again is the move');
  });

  it('says the destructive thing about close and not about the rest', async () => {
    answering(504);
    const { call, close } = await connect();
    const closing = said(await call('window_action', { window_id: '0x2600003', action: 'close' }));
    const resizing = said(
      await call('window_action', {
        window_id: '0x2600003',
        action: 'resize',
        width: 640,
        height: 480,
      }),
    );
    await close();

    expect(closing).toContain('no undo');
    expect(closing).toMatch(/window id is not reserved forever/);
    // The others are untidy on a repeat, and saying otherwise would train the
    // model to distrust an answer that is usually harmless.
    expect(resizing).toContain('untidy rather than destructive');
    expect(resizing).not.toContain('no undo');
  });

  it.each([
    'the guest agent accepted the action and did not report back',
    'the guest did not answer in time; the window action may have completed',
    'gateway timeout',
    'the action might already have run',
    'timed out before dispatch could be confirmed',
    'could not confirm that the request was not dispatched',
  ])(
    'adds the next step when a structured response leaves dispatch possible: %s',
    async (error) => {
      // The platform's own timeout sentence is structured too, so a body cannot
      // by itself mean that this handler has nothing to add. Positive acceptance,
      // a generic gateway timeout, an unfamiliar rewording and a sentence that
      // merely contains "before dispatch", or quotes non-dispatch as something
      // unconfirmed, are all unsafe to replay. Only a complete explicit
      // assertion of non-dispatch can settle the outcome. The second sentence
      // is the current platform's exact wire message.
      answering(504, { error });
      const { call, close } = await connect();
      const text = said(await call('window_action', { window_id: '0x2600003', action: 'close' }));
      await close();

      expect(text).toContain(error);
      expect(text).toContain('UNKNOWN');
      expect(text).toContain('list_windows');
    },
  );

  it.each([
    'upstream unavailable before dispatch',
    'the window action was not dispatched',
    'the request has not been dispatched',
  ])('leaves an explicit non-dispatch response authoritative: %s', async (error) => {
    // A gateway that rejected the request before dispatch knows the outcome is
    // not unknown. Prefixing this sentence and then forbidding a retry would
    // make the tool contradict the one hop that can settle that question.
    answering(504, { error });
    const { call, close } = await connect();
    const text = said(await call('window_action', { window_id: '0x2600003', action: 'close' }));
    await close();

    expect(text).toBe(`${error} (HTTP 504)`);
    expect(text).not.toContain('UNKNOWN');
    expect(text).not.toContain('list_windows');
    expect(text).not.toContain('Do not send this call again');
  });

  it('covers the ceiling as well as the deadline, because both leave it unknown', async () => {
    // A 524 is the same event reached from the proxy's two-minute ceiling
    // instead of from the guest's silence, and it carries the stronger form of
    // the same fact: the platform very likely has the request and is working on
    // it. Repeating a close through one is the worse version of the same bug.
    answering(524);
    const { call, close } = await connect();
    const text = said(await call('window_action', { window_id: '0x2600003', action: 'close' }));
    await close();

    expect(text).toContain('HTTP 524');
    expect(text).toContain('list_windows');
    // The 524 tail is about foreground exec and a timeout_s this route does not
    // take, so it goes with the rest of the substituted prose.
    expect(text).not.toContain('timeout_s');
  });

  it('leaves every other failure on this route exactly as it was', async () => {
    answering(409, { error: 'the guest agent is busy with another call' });
    const { call, close } = await connect();
    const text = said(await call('window_action', { window_id: '0x2600003', action: 'focus' }));
    await close();
    expect(text).toBe('the guest agent is busy with another call (HTTP 409)');
    expect(text).not.toContain('list_windows');
  });

  it('says it in the description too, where a model reads it before it calls', async () => {
    // The error arrives once and is read once; the description is what shapes
    // the call that does not need to fail first.
    const { client, close } = await connect();
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    await close();
    const d = tools.get('window_action')?.description ?? '';
    expect(d).toMatch(/504/);
    expect(d).toContain('list_windows');
    expect(d).toMatch(/not permission to repeat it/);
  });

  it('asks the body, not the message, whether a hop said anything', () => {
    // What `platformSaid` is for. By the time the error exists the message may
    // have been written by this file, so asking it to vouch for itself would
    // answer yes to prose the tool is trying to replace.
    const bare = errorForStatus(504, 'HTTP 504', undefined);
    expect(bare).toBeInstanceOf(GatewayTimeoutError);
    expect(bare.message).not.toBe('HTTP 504');
    expect(platformSaid(bare.body)).toBeUndefined();
    const named = errorForStatus(504, 'upstream gave up', { error: 'upstream gave up' });
    expect(platformSaid(named.body)).toBe('upstream gave up');
    // Shape-checked like every other body read here: a non-string reads as
    // nothing said rather than being printed as a sentence.
    expect(platformSaid({ error: 5 })).toBeUndefined();
    expect(platformSaid({ error: '' })).toBeUndefined();
    expect(platformSaid('a string body')).toBeUndefined();
  });

  it('leaves the exported retry predicates untouched', () => {
    // The seam, again. A 504 is not transient for an embedder wrapping a create
    // and still is for a wait loop replaying a read — this ticket changes one
    // tool's answer and neither predicate.
    const timeout = errorForStatus(504, 'HTTP 504', undefined);
    expect(isTransient(timeout)).toBe(false);
    expect(isTransientForPoll(timeout)).toBe(true);
  });
});

// --- grok bug hunt, OPL-4218 ---------------------------------------------
//
// One block per confirmed finding, in the order the ticket lists them. What is
// pinned here is the answer a caller gets, not the shape of the fix — several
// of these are one line, and a line is exactly the kind of thing a later
// refactor puts back the way it was.

describe('run_agent under a client that is counting the seconds', () => {
  const stream =
    'event: step\ndata: {"n":1,"detail":"clicked"}\n\n' +
    'event: step\ndata: {"n":2,"detail":"typed"}\n\n' +
    'event: done\ndata: {"stop":"end_turn","text":"Done"}\n\n';

  it('sends notifications/progress, which is the only frame that holds a request open', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch;
    try {
      const { client, close } = await connect({ modelKey: 'sk-test' });
      const seen: { progress: number; total?: number }[] = [];
      const res = (await client.callTool(
        { name: 'run_agent', arguments: { prompt: 'finish' } },
        undefined,
        {
          onprogress: (p) => seen.push({ progress: p.progress, total: p.total }),
        },
      )) as CallToolResult;
      expect(res.isError).toBeFalsy();
      // One per step, increasing, against the total the caller asked for —
      // which is what the SDK's ProgressSchema requires and what a client
      // showing a bar needs.
      expect(seen.map((p) => p.progress)).toEqual([1, 2]);
      expect(seen.every((p) => p.total === 20)).toBe(true);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('says in its own description that a run outlasts a default timeout', async () => {
    const { client, close } = await connect({ modelKey: 'sk-test' });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'run_agent');
    expect(tool?.description).toMatch(/resetTimeoutOnProgress/);
    expect(tool?.description).toMatch(/MINUTES/);
    await close();
  });

  it('stops at a well-formed done rather than waiting for a close that may not come', async () => {
    const real = globalThis.fetch;
    let cancelled = false;
    // A stream that sends `done` and then never ends — the shape a proxy that
    // holds the connection open produces. Before the break, the tool sat here
    // with the answer already in hand until the client gave up on it.
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(stream));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch;
    try {
      const { call, close } = await connect({ modelKey: 'sk-test' });
      const res = await call('run_agent', { prompt: 'finish' });
      expect(res.isError).toBeFalsy();
      expect(said(res)).toMatch(/finished/);
      expect(said(res)).toMatch(/clicked/);
      // The break is what lets the body be released rather than read to an EOF
      // that was never coming.
      expect(cancelled).toBe(true);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('still steps over a null done, which is not a result', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        'event: done\ndata: null\n\n' +
          'event: step\ndata: {"n":1,"detail":"clicked"}\n\n' +
          'event: done\ndata: {"stop":"end_turn","text":"Done"}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch;
    try {
      const { call, close } = await connect({ modelKey: 'sk-test' });
      const res = await call('run_agent', { prompt: 'finish' });
      expect(res.isError).toBeFalsy();
      expect(said(res)).toMatch(/clicked/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('deleting a computer that is already gone', () => {
  it('unbinds the session on a 404 rather than leaving it driving a ghost', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
        return new Response(JSON.stringify({ error: 'no such computer' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Everything else answers as the live fixture would, so the tools that
      // run after the delete have a platform to talk to.
      return new Response(JSON.stringify({ id: 'vm-1', status: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('delete_computer', { computer_id: 'vm-1', confirm: true });
      // Not an error: the state the caller asked for is the state that holds.
      expect(res.isError).toBeFalsy();
      // It names both readings of a 404 rather than asserting a deletion: the
      // id may simply not be one on this account.
      expect(said(res)).toMatch(/Nothing was deleted/i);
      expect(said(res)).toMatch(/already destroyed/i);
      expect(said(res)).toMatch(/not one on this account/i);
      // And the binding is gone with it — the next call has nothing to drive
      // and says so, rather than acting on a destroyed machine.
      const after = await call('screenshot', {});
      expect(said(after)).toMatch(/No computer selected/i);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('a snapshot filter that is only whitespace', () => {
  it('is refused rather than silently listing the whole account', async () => {
    const fake = installFakePlatform();
    try {
      const { call, close } = await connect();
      const res = await call('list_snapshots', { computer_id: '   ' });
      expect(res.isError).toBe(true);
      expect(said(res)).toMatch(/blank/i);
      // The refusal has to name the failure it prevents, because the wrong
      // answer here looked exactly like a correct one.
      expect(said(res)).toMatch(/every snapshot on the account/i);
      await close();
    } finally {
      fake.restore();
    }
  });

  it('still trims a real id, which has always named the same computer', async () => {
    const fake = installFakePlatform();
    try {
      const { call, close } = await connect();
      const res = await call('list_snapshots', { computer_id: '  vm-1  ' });
      expect(res.isError).toBeFalsy();
      await close();
    } finally {
      fake.restore();
    }
  });
});

describe('write_file and half a character', () => {
  it('refuses an unpaired surrogate instead of writing U+FFFD and reporting success', async () => {
    const fake = installFakePlatform();
    try {
      const { call, close } = await connect();
      const res = await call('write_file', {
        path: '/tmp/a.txt',
        content: 'hello \ud800 there',
        encoding: 'utf8',
      });
      expect(res.isError).toBe(true);
      expect(said(res)).toMatch(/unpaired surrogate/i);
      expect(said(res)).toMatch(/Nothing was written/i);
      // Nothing reached the platform — the point is that the file is untouched.
      expect(fake.calls.some((c) => c.method === 'PUT')).toBe(false);
      await close();
    } finally {
      fake.restore();
    }
  });

  it('leaves a whole character alone, emoji included', async () => {
    const fake = installFakePlatform();
    try {
      const { call, close } = await connect();
      const res = await call('write_file', {
        path: '/tmp/a.txt',
        content: 'hello 😀 there',
        encoding: 'utf8',
      });
      expect(res.isError).toBeFalsy();
      await close();
    } finally {
      fake.restore();
    }
  });

  it('shares one scan with the clipboard, which has always refused it', () => {
    expect(P.hasUnpairedSurrogate('\ud800')).toBe(true);
    expect(P.hasUnpairedSurrogate('\udc00')).toBe(true);
    expect(P.hasUnpairedSurrogate('a\ud800b')).toBe(true);
    expect(P.hasUnpairedSurrogate('😀')).toBe(false);
    expect(P.hasUnpairedSurrogate('plain')).toBe(false);
    expect(() => P.clipboardBody('\ud800')).toThrow(/unpaired surrogate/i);
  });
});

describe('a moves table with a malformed row in it', () => {
  it('says how many it could not read, rather than dropping them silently', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname.endsWith('/moves')) {
        return new Response(
          JSON.stringify({
            moves: [null, { computer_id: 'vm-1', state: 'done', live: false }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ id: 'vm-1', status: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('list_moves', {});
      expect(said(res)).toMatch(/ignored 1 malformed move entry/i);
      expect(said(res)).toMatch(/vm-1/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('refuses rather than calling a listing of nothing but bad rows an empty account', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname.endsWith('/moves')) {
        return new Response(JSON.stringify({ moves: [null, 'nonsense'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'vm-1', status: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('list_moves', {});
      // "No moves on this account" is an affirmative claim, and an unreadable
      // listing does not establish it.
      expect(res.isError).toBe(true);
      expect(said(res)).not.toMatch(/No moves on this account/);
      expect(said(res)).toMatch(/may still be running/i);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('drops the row rather than throwing past the refusal that says the move is still running', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname.endsWith('/moves')) {
        return new Response(
          JSON.stringify({
            moves: [null, 'nonsense', { computer_id: 'vm-1', state: 'done', live: false }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ id: 'vm-1', status: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('list_moves', {});
      // A TypeError here used to escape as a generic failure. The readable row
      // is still readable, and it is the answer.
      expect(said(res)).toMatch(/vm-1/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('the Host allowlist an operator actually writes', () => {
  it('matches with and without the bound port, because the SDK compares the whole header', () => {
    // The case that 403'd every direct client: a bare name, a non-default port.
    expect(hostSpellings('mcp.example.com', 3000)).toEqual([
      'mcp.example.com',
      'mcp.example.com:3000',
    ]);
  });

  it('leaves an entry that already names a port exactly as written', () => {
    // That operator has said which port their callers send, and it need not be
    // the one bound here — a proxy in front is the ordinary reason.
    expect(hostSpellings('mcp.example.com:443', 3000)).toEqual(['mcp.example.com:443']);
    expect(hostSpellings('[::1]:3000', 9999)).toEqual(['[::1]:3000']);
  });

  it('brackets a bare IPv6 address rather than appending a port to it', () => {
    // `::1` + `:3000` is `::1:3000`, a string no client can ever send — and
    // leaving `::1` alone would be a list entry matching nothing, which is the
    // same 403 this function exists to prevent. Bracketing is the expansion.
    expect(hostSpellings('::1', 3000)).toEqual(['[::1]', '[::1]:3000']);
  });
});

describe('what counts as a loopback bind', () => {
  it('takes the whole of 127.0.0.0/8 and the names for it', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '::1', '[::1]']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it('takes IPv4-mapped loopback, which is a local bind by any other spelling', () => {
    // The hole: a v6 socket carrying a v4 loopback address read as "not
    // loopback", so no default Host allowlist and rebinding protection off.
    for (const h of ['::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '::ffff:127.0.0.1%lo']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it('takes every compression of IPv6 loopback, not only the canonical ::1', () => {
    // Node accepts these, reports the bound address as ::1, and leaves
    // cfg.host as the operator's spelling. A string match on ::1 alone
    // skipped the default Host allowlist (adversarial review, OPL-4314).
    for (const h of [
      '0:0:0:0:0:0:0:1',
      '::0:1',
      '0::1',
      '[0:0:0:0:0:0:0:1]',
      '0:0:0:0:0:0:0:1%lo',
    ]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it('still refuses the binds that mean every interface', () => {
    // Unchanged on purpose: these are an operator saying they want this
    // reachable from elsewhere, and a default allowlist would 403 everything.
    for (const h of ['0.0.0.0', '::', 'example.com', '10.0.0.1', '::ffff:10.0.0.1']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe('screenshots and the types image content may carry', () => {
  it('refuses an SVG, which read_file has always refused', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', {
        headers: { 'Content-Type': 'image/svg+xml' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('screenshot', {});
      expect(res.isError).toBe(true);
      expect(res.content.some((item) => item.type === 'image')).toBe(false);
      expect(said(res)).toMatch(/image\/svg\+xml/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('still hands over a raster capture', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('screenshot', {});
      expect(res.isError).toBeFalsy();
      expect(res.content.some((item) => item.type === 'image')).toBe(true);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('a build whose response carries no ref', () => {
  it('omits the clause rather than saying it started for undefined', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'bld-1' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('build_template', { document: '{"apiVersion":"mandala/v1"}' });
      expect(said(res)).toMatch(/Build bld-1 started\./);
      expect(said(res)).not.toMatch(/undefined/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('instructions under MANDALA_NO_LIFECYCLE', () => {
  it('stops naming create_computer once it is no longer registered', async () => {
    const withLifecycle = await connect({ lifecycle: true });
    expect(withLifecycle.client.getInstructions()).toMatch(/create_computer/);
    await withLifecycle.close();

    const without = await connect({ lifecycle: false });
    const text = without.client.getInstructions() ?? '';
    const names = new Set((await without.client.listTools()).tools.map((t) => t.name));
    expect(names.has('create_computer')).toBe(false);
    // A tool a model can see is a tool it will try, and the instructions are
    // the first thing it sees.
    expect(text).not.toMatch(/create_computer/);
    expect(text).toMatch(/use_computer binds/);
    await without.close();
  });
});

describe('a done frame that is not a result', () => {
  it('does not end the run on a record with no stop, discarding the real one behind it', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        'event: step\ndata: {"n":1,"detail":"clicked"}\n\n' +
          // A record, so the old break fired here and reported "ended: unknown"
          // for a run that had in fact succeeded one frame later.
          'event: done\ndata: {}\n\n' +
          'event: done\ndata: {"stop":"end_turn","text":"Done"}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch;
    try {
      const { call, close } = await connect({ modelKey: 'sk-test' });
      const res = await call('run_agent', { prompt: 'finish' });
      expect(res.isError).toBeFalsy();
      expect(said(res)).toMatch(/finished/);
      expect(said(res)).not.toMatch(/ended: unknown/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('does not hand back a result that is not a string as [object Object]', async () => {
    // The file type-checks `done.stop` three lines earlier and put `done.text`
    // through a bare `String()`. A content-block array — a plausible shape for
    // an agent result — then rendered the run's whole output as
    // `[object Object]`, in the sentence that carries it.
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        'event: done\ndata: {"stop":"end_turn","text":[{"type":"text","text":"Done"}]}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch;
    try {
      const { call, close } = await connect({ modelKey: 'sk-test' });
      const res = await call('run_agent', { prompt: 'finish' });
      expect(res.isError).toBeFalsy();
      expect(said(res)).not.toMatch(/\[object Object\]/);
      // Unfamiliar but readable beats confident and empty.
      expect(said(res)).toContain('"Done"');
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('a Host allowlist written as an IPv6 address', () => {
  it('brackets it into the spellings a client can actually send', () => {
    // `::1` is not a legal Host header and `::1:3000` is not a thing at all, so
    // an unbracketed entry would sit in the list matching nothing.
    expect(hostSpellings('::1', 3000)).toEqual(['[::1]', '[::1]:3000']);
    expect(hostSpellings('::ffff:127.0.0.1', 3000)).toEqual([
      '[::ffff:127.0.0.1]',
      '[::ffff:127.0.0.1]:3000',
    ]);
  });

  it('gives a bracketed entry with no port its ported spelling too', () => {
    expect(hostSpellings('[::1]', 3000)).toEqual(['[::1]', '[::1]:3000']);
  });
});

// --- second adversarial hunt (OPL-4244) -----------------------------------

describe('an event stream that stopped with events still in it', () => {
  it('hands over what was buffered instead of dropping it with the subscription', async () => {
    // The designed weather for this: listening is not using, so a computer
    // nobody touches suspends underneath its own open stream. The gate that
    // reports the stop used to run ahead of every read, so a process.exited
    // that had already arrived went into `drop` unread and the caller got a
    // bare refusal.
    const platform = installFakePlatform();
    const events = fakeEvents();
    const { call, close } = await connect({ webSocket: events.factory });
    try {
      await call('poll_events', {});
      events.last().send({
        type: 'process.exited',
        cursor: 'cur-1',
        data: { pid: 4242, exit_code: 0 },
      });
      await new Promise((r) => setTimeout(r, 20));

      // The computer suspends, so the reconnect settles rather than retrying.
      const real = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/computers/vm-1')) {
          return new Response(JSON.stringify({ id: 'vm-1', status: 'suspended' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return real(input as never, init);
      }) as typeof fetch;
      events.last().close();
      await new Promise((r) => setTimeout(r, 1600));
      globalThis.fetch = real;

      const res = await call('poll_events', {});
      // Still a refusal — the stream really has stopped and the cause needs
      // fixing — but the event is in the answer rather than lost with the ring.
      expect(res.isError).toBe(true);
      expect(said(res)).toMatch(/suspended/);
      expect(said(res)).toMatch(/had already arrived before it stopped/);
      expect(said(res)).toMatch(/process\.exited/);
      expect(said(res)).toMatch(/4242/);
    } finally {
      await close();
      platform.restore();
    }
  }, 20000);
});

describe('a stopped stream holding more than one batch', () => {
  it('keeps the buffer until it is drained rather than dropping the rest with it', async () => {
    // The drain fixed the first-batch loss and, dropping on the first call,
    // moved the rest of it: the read is bounded by the caller's `limit` while
    // the ring holds up to MAX_BUFFERED, so 5 unread events with limit 2 became
    // 2 delivered and 3 discarded — under a sentence calling them the last this
    // stream has and a more_waiting that said otherwise.
    const platform = installFakePlatform();
    const events = fakeEvents();
    const { call, close } = await connect({ webSocket: events.factory });
    try {
      await call('poll_events', {});
      for (let i = 1; i <= 5; i++) {
        events.last().send({ type: 'process.exited', cursor: `cur-${i}`, data: { pid: i } });
      }
      await new Promise((r) => setTimeout(r, 20));

      const real = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/computers/vm-1')) {
          return new Response(JSON.stringify({ id: 'vm-1', status: 'suspended' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return real(input as never, init);
      }) as typeof fetch;
      events.last().close();
      await new Promise((r) => setTimeout(r, 1600));
      globalThis.fetch = real;

      // First call: two of the five, and it must not claim they are the last.
      const first = await call('poll_events', { limit: 2 });
      expect(first.isError).toBe(true);
      expect(said(first)).toMatch(/still held here/);
      expect(said(first)).not.toMatch(/the last this stream has/);
      expect(said(first)).toMatch(/"pid": 1/);
      expect(said(first)).toMatch(/"pid": 2/);

      // The rest survive, rather than having gone with the subscription.
      const second = await call('poll_events', { limit: 2 });
      expect(said(second)).toMatch(/"pid": 3/);
      expect(said(second)).toMatch(/"pid": 4/);
      const third = await call('poll_events', { limit: 2 });
      expect(said(third)).toMatch(/"pid": 5/);
      // Now the ring is empty, so this one is the last and says so.
      expect(said(third)).toMatch(/the last this stream has/);
    } finally {
      await close();
      platform.restore();
    }
  }, 20000);
});

describe('wait_for_event and the deadline it was given', () => {
  it('bounds the attach with timeout_s rather than spending ATTACH_MS in front of it', async () => {
    // A socket that opens and never sends `hello`. The attach used to be its
    // own 20-second budget, armed BEFORE timeout_s — so timeout_s: 1 answered
    // after twenty seconds, and timeout_s: 55 could run past the sixty most
    // MCP clients allow a request, which is what MAX_WAIT_S exists to prevent.
    const platform = installFakePlatform();
    const factory = (url: string) => {
      const socket = new FakeSocket(url);
      setTimeout(() => socket.open(), 0);
      return socket;
    };
    const { call, close } = await connect({ webSocket: factory });
    try {
      const started = Date.now();
      const res = await call('wait_for_event', { timeout_s: 2 });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(10_000);
      expect(res.isError).toBe(true);
      expect(said(res)).toMatch(/Could not open the event stream/);
      // And it says what it actually spent, not a constant it no longer used.
      expect(said(res)).not.toMatch(/in 20s/);
    } finally {
      await close();
      platform.restore();
    }
  }, 30000);

  it('leaves a subscription that is still connecting alone rather than dropping it', async () => {
    // `#url()` treats `starting` as weather and keeps backing off. Dropping the
    // subscription here threw that progress away on every call, so the
    // create-then-wait flow the README advertises never got further.
    const platform = installFakePlatform();
    const events = fakeEvents(null);
    const { call, close } = await connect({ webSocket: events.factory });
    try {
      const res = await call('wait_for_event', { timeout_s: 1 });
      expect(res.isError).toBe(true);
      expect(said(res)).toMatch(/still coming up/);
      // The socket the first call opened is still the live one: nothing was
      // torn down and reopened underneath it.
      const opened = events.sockets.length;
      await call('wait_for_event', { timeout_s: 1 });
      expect(events.sockets.length).toBe(opened);
      expect(events.last().closed).toBe(false);
    } finally {
      await close();
      platform.restore();
    }
  }, 30000);
});

describe('an origin-only base URL', () => {
  it('joins the path with one slash rather than two', () => {
    // `pathname.replace(/\/+$/, '')` leaves `''`, which the WHATWG setter puts
    // straight back as `/` — so the join wrote `https://host//computers`, a
    // different path to any router that normalises and a 404 to one that does
    // not. Invisible on the default base, which carries `/api/v1`.
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      for (const base of ['https://gateway.example.com', 'https://gateway.example.com/']) {
        calls.length = 0;
        void new Api('com_test', base).json('GET', 'computers');
        expect(calls[0]).toBe('https://gateway.example.com/computers');
      }
    } finally {
      globalThis.fetch = real;
    }
  });

  it('still carries a base that has a path of its own', () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      void new Api('com_test', 'https://app.mandala.computer/api/v1').json('GET', 'computers');
      expect(calls[0]).toBe('https://app.mandala.computer/api/v1/computers');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('text typed at the keyboard', () => {
  it('refuses an unpaired surrogate rather than typing U+FFFD and reporting success', async () => {
    // The third path that carries a caller's own characters into the guest.
    // clipboardBody and write_file have refused this since they were written:
    // Go's encoding/json decodes a lone surrogate to U+FFFD, so the desktop is
    // typed a replacement character where the caller's text was.
    const platform = installFakePlatform();
    const { call, close } = await connect();
    try {
      const res = await call('type_text', { text: 'hello \ud800 there' });
      expect(res.isError).toBe(true);
      expect(said(res)).toMatch(/unpaired surrogate/);
      expect(said(res)).toMatch(/Nothing was typed/);
      expect(platform.calls.some((c) => c.path.endsWith('/input'))).toBe(false);
    } finally {
      await close();
      platform.restore();
    }
  });

  it('still types a whole astral character', () => {
    expect(P.typeBody('a 😀 b')).toEqual({ action: 'type', text: 'a 😀 b' });
  });

  it('counts an astral character once rather than twice', async () => {
    // `.length` is UTF-16 code units, so an emoji was announced as two
    // characters typed — a number nothing acts on but a model may repeat to
    // whoever asked. The neighbours here already count in units that mean
    // something: hasUnpairedSurrogate in code points, clipboardBody in bytes.
    const platform = installFakePlatform();
    const { call, close } = await connect();
    try {
      const res = await call('type_text', { text: 'ok 👍' });
      expect(res.isError).toBeFalsy();
      expect(said(res)).toContain('Typed 4 character(s)');
    } finally {
      await close();
      platform.restore();
    }
  });
});

describe('an environment entry with half a character in it', () => {
  it("is refused rather than run with U+FFFD where the caller's text was", () => {
    // The fourth path a caller's own characters take into the guest, and the
    // one nothing was checking: `env` is a bare record of strings on the tool,
    // so a model emitting half of a truncated emoji reaches Go's encoding/json,
    // which decodes the escaped lone unit to U+FFFD. The process then runs with
    // an environment value that is not the one asked for, and the exec is
    // reported as an ordinary success.
    expect(() => P.execEnv({ TOKEN: 'abc\ud83d' })).toThrow(/unpaired surrogate/);
    expect(() => P.execEnv({ '\udc00NAME': 'x' })).toThrow(/unpaired surrogate/);
    // A whole character is text, not corruption, and still goes.
    expect(P.execEnv({ GREETING: 'hi 😀' })).toEqual({ GREETING: 'hi 😀' });
  });
});

describe('a command with a NUL in it', () => {
  it('is refused rather than truncated at the guest and reported as a success', () => {
    // The platform refuses a NUL in `cwd` and in every file path —
    // validGuestPath rejects the whole control range — and checks `command`
    // only for emptiness. So a NUL there truncates the command at the guest's
    // argv boundary: a shorter command runs and its exit code is reported as an
    // ordinary success. execEnv has refused the same byte since it was written.
    expect(() => P.execBody({ command: 'echo hello\0rm -rf /' })).toThrow(/NUL/);
    expect(P.execBody({ command: 'echo hello' })).toEqual({ command: 'echo hello' });
  });

  it('refuses half a character in the command for the same reason it refuses a NUL', () => {
    // The comment above that NUL refusal calls it "the same shape as the
    // surrogate refusals", and the surrogate half of the shape was the one
    // `command` did not have. A model emitting a command cut through the middle
    // of an emoji reaches Go's encoding/json, which decodes the escaped lone
    // unit to U+FFFD: a command other than the one asked for runs, and its exit
    // code comes back as an ordinary success. `cwd` corrupts the same way and
    // names a directory that is not there.
    expect(() => P.execBody({ command: 'echo "hi \ud83d"' })).toThrow(/unpaired surrogate/);
    expect(() => P.execBody({ command: 'ls', cwd: '/home/\udc00user' })).toThrow(
      /unpaired surrogate/,
    );
    // open_url builds the command itself, so the refusal it gets must name what
    // it actually passed. `z.string().url()` lets half a character through, and
    // "cut the command on a character boundary" names a parameter that tool
    // does not take and a string its caller never saw.
    expect(() => P.openUrlCommand('https://example.com/\ud83d')).toThrow(
      /url must not contain an unpaired surrogate/,
    );
    // A whole character is text, not corruption, and still goes.
    expect(P.execBody({ command: 'echo "hi 😀"' })).toEqual({ command: 'echo "hi 😀"' });
  });
});

describe('the two event tools and what their annotations claim', () => {
  it('does not call a consuming read read-only', async () => {
    // exec_poll deliberately carries no readOnlyHint because a poll advances a
    // cursor, and a client that treats the hint as licence to retry drops
    // whatever the first attempt consumed. `sub.read()` is the same mechanics
    // with a ring in this session instead of a cursor in the guest.
    const platform = installFakePlatform();
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      for (const name of ['poll_events', 'wait_for_event']) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, name).toBeDefined();
        expect(tool?.annotations?.readOnlyHint, name).toBeFalsy();
      }
    } finally {
      await close();
      platform.restore();
    }
  });
});

describe('delete_snapshot answering 404', () => {
  it('does not report the retry it invites as a failure', async () => {
    // idempotentHint invites a client to retry a lost 2xx, and every non-OK
    // throws — so that invited retry came back isError saying the delete had
    // FAILED, about bytes the first attempt had already destroyed.
    // delete_computer carries the same hint and handles 404 for this reason.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? 'GET') === 'DELETE' && url.pathname.includes('/snapshots/')) {
        return new Response(JSON.stringify({ error: 'no such snapshot' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('delete_snapshot', { snapshot_id: 'snap-1', confirm: true });
      expect(res.isError).toBeFalsy();
      // And it does not claim a deletion either: a 404 is equally the answer
      // for an id that was never on this account.
      expect(said(res)).toMatch(/Nothing was deleted/);
      expect(said(res)).toMatch(/list_snapshots/);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('a server with the lifecycle tools withheld', () => {
  it('names no tool it did not register, in a description or in an answer', async () => {
    // The instructions were parameterised on `lifecycle` because a tool a model
    // can see is a tool it will try — and a name in a surviving neighbour's
    // description is the same idea by a different route. The phantom-tool scan
    // only ever ran with lifecycle ON, where every name was legal.
    const platform = installFakePlatform();
    const { client, call, close } = await connect({ lifecycle: false });
    try {
      const { tools } = await client.listTools();
      const registered = new Set(tools.map((t) => t.name));
      const withheld = [
        'create_computer',
        'clone_computer',
        'clone_snapshot',
        'delete_computer',
        'delete_snapshot',
      ];
      for (const gone of withheld) expect(registered.has(gone), gone).toBe(false);

      for (const tool of tools) {
        const prose = `${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`;
        for (const gone of withheld) {
          expect(prose.includes(gone), `${tool.name} names ${gone}`).toBe(false);
        }
      }

      // And at run time, which is where an empty account used to be handed
      // `create_computer` in a sentence.
      const real = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/api/v1/computers')) {
          return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
        }
        return real(input as never, init);
      }) as typeof fetch;
      const empty = await call('list_computers', {});
      globalThis.fetch = real;
      expect(said(empty)).not.toMatch(/create_computer/);

      const holdings = await call('snapshot_holdings', {});
      expect(said(holdings)).not.toMatch(/delete_computer/);
    } finally {
      await close();
      platform.restore();
    }
  });

  it('still names them when the lifecycle tools are there', async () => {
    const platform = installFakePlatform();
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const sizes = tools.find((t) => t.name === 'list_sizes');
      expect(sizes?.description).toMatch(/create_computer/);
      await close();
    } finally {
      platform.restore();
    }
  });
});

describe('an explicit empty --port', () => {
  it('is refused rather than falling through to PORT', () => {
    // `str()` was fixed so `--key=` and `--base-url=` do not defer to the
    // environment the usage text promises they override. `port()` still used
    // `given || fromEnv`, so the clearest way to say "not the environment's
    // port" silently deferred to it.
    const before = process.env.PORT;
    process.env.PORT = '8080';
    try {
      const flags = parse(['--http', '--port=']);
      expect(flags.port).toBe('');
      expect(() => port(flags.port as string)).toThrow(/--port needs a number/);
      // An absent flag still reads the environment, which is the documented order.
      expect(port(undefined)).toBe(8080);
    } finally {
      if (before === undefined) delete process.env.PORT;
      else process.env.PORT = before;
    }
  });
});

describe('a stdio server whose client closed the pipe', () => {
  it('closes the session, and its event sockets, on stdin EOF', async () => {
    // The SDK's StdioServerTransport.start() registers `data` and `error` on
    // stdin and nothing else, so EOF never called close(), never fired the
    // server's onclose, and never ran the events.closeAll() createServer hangs
    // there. What was left behind held a websocket to the platform and the
    // user's API key, and an open socket keeps the event loop alive by itself:
    // measured against the built CLI, a child was still running and still
    // holding its socket ten seconds after its stdin closed.
    const { Readable, Writable } = await import('node:stream');
    const stdin = new Readable({ read() {} });
    const stdout = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
    const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
    const platform = installFakePlatform();
    const events = fakeEvents();
    try {
      const { runStdio } = await import('../src/stdio.js');
      await runStdio({
        apiKey: 'com_test',
        baseUrl: BASE,
        computerId: 'vm-1',
        webSocket: events.factory,
      });
      const send = (msg: unknown) => stdin.push(`${JSON.stringify(msg)}\n`);
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      // poll_events is what opens the socket that outlives the call.
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'poll_events', arguments: {} },
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(events.sockets.length).toBeGreaterThan(0);
      expect(events.last().closed).toBe(false);

      // The client goes away without a shutdown, which is the ordinary case.
      stdin.push(null);
      await new Promise((r) => setTimeout(r, 200));
      expect(events.last().closed).toBe(true);
    } finally {
      platform.restore();
      if (realIn) Object.defineProperty(process, 'stdin', realIn);
      if (realOut) Object.defineProperty(process, 'stdout', realOut);
    }
  }, 20000);
});
