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
import { Api, filenameFrom } from '../src/api.js';
import { isEntrypoint, parse, port, str } from '../src/cli.js';
import { MAX_INLINE_IMAGE_BYTES, unwrapComputer } from '../src/format.js';
import * as P from '../src/paths.js';
import { windowBody } from '../src/paths.js';
import { SERVER_VERSION } from '../src/server.js';
import { BASE, connect, installFakePlatform } from './harness.js';

/** Everything a tool said, as one string. */
const said = (res: CallToolResult) =>
  res.content.map((c) => ('text' in c ? c.text : '')).join('\n');

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
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1), {
        headers: { 'Content-Type': 'image/png' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('screenshot');
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    expect(said(res)).toMatch(/width/);
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
    const res = await call('read_file', { path: '/big.png' });
    expect(res.isError).toBe(true);
    expect(said(res)).toMatch(/inline limit/);
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
