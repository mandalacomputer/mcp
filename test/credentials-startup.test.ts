import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { runStdio, type StdioConfig } from '../src/stdio.js';
import { ACCOUNT_QUOTA } from './harness.js';

const COMPUTER = {
  id: 'fixture-computer',
  name: 'fixture',
  status: 'stopped',
  cpu: 2,
  ram_mb: 1024,
  disk_gb: 20,
};

// Only replace the SDK's default stream arguments. Its real JSON-RPC parser,
// server initialization, tool dispatch and writes all run in-process.
const streams = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | { input: PassThrough; output: PassThrough; transport?: StdioServerTransport },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/server/stdio.js')>();
  return {
    ...actual,
    StdioServerTransport: class extends actual.StdioServerTransport {
      constructor() {
        super(streams.current!.input, streams.current!.output);
        streams.current!.transport = this;
      }
    },
  };
});
const corpus = JSON.parse(
  fs.readFileSync(new URL('./fixtures/credentials-v1.json', import.meta.url), 'utf8'),
);
const baseDocument = () =>
  structuredClone(corpus.base_document) as {
    version: number;
    default_profile: string;
    profiles: Record<
      string,
      {
        api_key: string;
        base_url: string;
        account: { id: string; name: string | null };
        scope: unknown;
      }
    >;
  };
const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'credential-test', version: '1' },
};
type Reply = {
  id: number;
  result?: { isError?: boolean; content?: { type: string; text?: string }[] };
  error?: unknown;
};
const text = (reply: Reply) =>
  reply.result?.content?.map((item) => item.text ?? '').join('\n') ?? '';
let home: string;
let filename: string;
const closes: (() => Promise<void>)[] = [];

function save(doc = baseDocument()) {
  fs.writeFileSync(`${filename}.next`, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(`${filename}.next`, filename);
}
function protocol(input: NodeJS.WritableStream, output: NodeJS.ReadableStream) {
  let serial = 0;
  let buffer = '';
  const pending = new Map<number, (reply: Reply) => void>();
  const lines: string[] = [];
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      lines.push(line);
      const reply = JSON.parse(line) as Reply;
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    }
  });
  return {
    lines,
    notify: (method: string) => input.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    request: (method: string, params?: unknown) => {
      const id = ++serial;
      return new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('stdio reply timed out'));
        }, 4000);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}
async function local(cfg?: StdioConfig, argv?: string[]) {
  const pair = {
    input: new PassThrough(),
    output: new PassThrough(),
    transport: undefined as StdioServerTransport | undefined,
  };
  streams.current = pair;
  const wire = protocol(pair.input, pair.output);
  const beforeEnd = new Set(process.stdin.listeners('end'));
  const beforeClose = new Set(process.stdin.listeners('close'));
  if (argv) await main(argv);
  else await runStdio(cfg);
  const cleanup = async () => {
    await pair.transport?.close();
    pair.input.destroy();
    pair.output.destroy();
    for (const fn of process.stdin.listeners('end'))
      if (!beforeEnd.has(fn)) process.stdin.removeListener('end', fn as () => void);
    for (const fn of process.stdin.listeners('close'))
      if (!beforeClose.has(fn)) process.stdin.removeListener('close', fn as () => void);
  };
  closes.push(cleanup);
  expect((await wire.request('initialize', INIT)).error).toBeUndefined();
  wire.notify('notifications/initialized');
  return {
    ...wire,
    call: (name: string, args: Record<string, unknown> = {}) =>
      wire.request('tools/call', { name, arguments: args }),
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-startup-'));
  fs.mkdirSync(path.join(home, '.mandala'), { mode: 0o700 });
  filename = path.join(home, '.mandala', 'credentials.json');
  for (const key of [
    'MANDALA_API_KEY',
    'MANDALA_BASE_URL',
    'MANDALA_PROFILE',
    'MANDALA_MODEL_KEY',
    'MANDALA_COMPUTER_ID',
    'MANDALA_READ_ONLY',
    'MANDALA_TAGS',
    'MANDALA_NO_LIFECYCLE',
  ])
    vi.stubEnv(key, undefined);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  save();
});
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function backend(revoked = false) {
  const calls: { key: string | null; url: string; method: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push({
      key: new Headers(init?.headers).get('authorization'),
      url: String(input),
      method: init?.method ?? 'GET',
    });
    return revoked
      ? Response.json(
          { error: 'Credential revoked', reason: 'revoked', request_id: 'fixture-refusal' },
          { status: 401 },
        )
      : Response.json(
          String(input).endsWith('/account')
            ? ACCOUNT_QUOTA
            : [{ ...COMPUTER, name: 'fixture-identity' }],
        );
  });
  return calls;
}

describe('portable stdio startup', () => {
  it('M01-local-stdio', async () => {
    const calls = backend();
    const wire = await local();
    const response = await wire.call('list_computers');
    expect(response.result?.isError).not.toBe(true);
    expect(text(response)).toContain('fixture-identity');
    expect(calls).toEqual([
      {
        key: `Bearer ${baseDocument().profiles.default.api_key}`,
        url: `${baseDocument().profiles.default.base_url}/computers`,
        method: 'GET',
      },
    ]);
    expect(wire.lines.length).toBeGreaterThanOrEqual(2);
    expect(wire.lines.every((line) => JSON.parse(line).jsonrpc === '2.0')).toBe(true);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain(
      'com_public_fixture_',
    );
  });
  it('O01-offline', async () => {
    const homeLookup = vi.spyOn(os, 'homedir').mockImplementation(() => {
      throw new Error('poison home');
    });
    const storeOpen = vi.spyOn(fs, 'openSync');
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected request'));
    for (const argv of [['--help'], ['--version']]) await main(argv);
    expect(out.mock.calls.flat().join('\n')).toContain('MANDALA_PROFILE');
    expect(homeLookup).not.toHaveBeenCalled();
    expect(storeOpen).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('O02-profile-cli-paths', async () => {
    const calls = backend();
    const wire = await local(undefined, ['--profile', 'Work']);
    for (const tool of ['list_computers', 'get_account'])
      expect((await wire.call(tool)).result?.isError).not.toBe(true);
    expect(calls.length).toBe(2);
    expect(
      calls.every(
        (call) =>
          call.key === `Bearer ${baseDocument().profiles.Work.api_key}` &&
          call.url.startsWith(baseDocument().profiles.Work.base_url),
      ),
    ).toBe(true);
  });
  it('plugin environment interpolation reaches the saved-profile reader', async () => {
    const plugin = JSON.parse(
      fs.readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    ) as { mcpServers: { mandala: { env: Record<string, string> } } };
    const shell: Record<string, string> = { MANDALA_PROFILE: 'Work' };
    // Apply only the manifest's forwarded values; there is no explicit profile
    // argument or ambient API key to hide an omitted or miswired interpolation.
    for (const [name, template] of Object.entries(plugin.mcpServers.mandala.env)) {
      const match = /^\$\{([A-Z_]+):-(.*)\}$/.exec(template);
      expect(match, 'plugin variables use supported shell/default interpolation').not.toBeNull();
      vi.stubEnv(name, shell[match![1]] ?? match![2]);
    }
    const calls = backend();
    const wire = await local(undefined, []);
    expect((await wire.call('get_account')).result?.isError).not.toBe(true);
    expect(calls).toEqual([
      {
        key: `Bearer ${baseDocument().profiles.Work.api_key}`,
        url: `${baseDocument().profiles.Work.base_url}/account`,
        method: 'GET',
      },
    ]);
  });
  it('I01-fixed-instance', async () => {
    const calls = backend();
    const first = await local({ profile: 'Work' });
    await first.call('list_computers');
    const replacement = baseDocument();
    replacement.profiles.Work.api_key = replacement.profiles.work.api_key;
    save(replacement);
    const io = vi.spyOn(fs, 'openSync');
    await first.call('list_computers');
    expect(io).not.toHaveBeenCalled();
    const second = await local({ profile: 'Work' });
    await second.call('list_computers');
    expect(calls.map((call) => call.key)).toEqual([
      `Bearer ${baseDocument().profiles.Work.api_key}`,
      `Bearer ${baseDocument().profiles.Work.api_key}`,
      `Bearer ${replacement.profiles.Work.api_key}`,
    ]);
  });
  it('I02-revoked-no-fallback', async () => {
    const calls = backend(true);
    const wire = await local({ profile: 'Work' });
    const io = vi.spyOn(fs, 'openSync');
    const response = await wire.call('get_account');
    expect(response.result?.isError).toBe(true);
    expect(text(response)).toContain('"status": 401');
    expect(text(response)).toContain('"reason": "revoked"');
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(`Bearer ${baseDocument().profiles.Work.api_key}`);
    expect(calls[0].method).toBe('GET');
    expect(io).not.toHaveBeenCalled();
  });
  it('I03-descriptive-scope-untrusted', async () => {
    const calls = backend();
    const first = await local({ profile: 'Work' });
    const original = await first.call('list_computers');
    const changed = baseDocument();
    changed.profiles.Work.account = { id: 'metadata-only-other-account', name: 'Untrusted' };
    changed.profiles.Work.scope = { type: 'account' };
    save(changed);
    const second = await local({ profile: 'Work' });
    expect(text(await second.call('list_computers'))).toBe(text(original));
    expect(calls[0]).toEqual(calls[1]);
  });
  it('I04-revoked-post-no-replay', async () => {
    const calls = backend(true);
    const wire = await local({ profile: 'Work' });
    const replacement = baseDocument();
    replacement.profiles.Work.api_key = replacement.profiles.work.api_key;
    save(replacement);
    const io = vi.spyOn(fs, 'openSync');
    const response = await wire.call('start_computer', { computer_id: 'fixture-computer' });
    expect(response.result?.isError).toBe(true);
    expect(text(response)).toContain('"status": 401');
    expect(text(response)).toContain('"reason": "revoked"');
    expect(calls).toEqual([
      {
        key: `Bearer ${baseDocument().profiles.Work.api_key}`,
        url: `${baseDocument().profiles.Work.base_url}/computers/fixture-computer/start`,
        method: 'POST',
      },
    ]);
    expect(io).not.toHaveBeenCalled();
  });
  it('retains CLI empty-base precedence and ignores an unused malformed profile', async () => {
    const calls = backend();
    vi.stubEnv('MANDALA_BASE_URL', 'https://environment.test/api/v1');
    const wire = await local(undefined, ['--key', 'fixture-explicit', '--base-url=', '--profile']);
    await wire.call('list_computers');
    expect(calls[0].url).toBe('https://app.mandala.computer/api/v1/computers');
    expect(calls[0].key).toBe('Bearer fixture-explicit');
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('fixture-explicit');
  });
});

describe('native built and packed stdio', () => {
  let temporary: string;
  let entries: string[];
  beforeAll(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-package-'));
    const source = path.resolve(import.meta.dirname, '..');
    const clean = path.join(temporary, 'clean');
    fs.mkdirSync(clean);
    for (const name of [
      'src',
      'package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'README.md',
      'LICENSE',
    ])
      fs.cpSync(path.join(source, name), path.join(clean, name), { recursive: true });
    // Only dependencies are shared. Neither build nor consumer inherits dist.
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(clean, 'node_modules'));
    execFileSync(
      process.execPath,
      [path.join(source, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
      { cwd: clean, stdio: 'pipe' },
    );
    const npm = path.join(path.dirname(process.execPath), 'npm');
    const packed = JSON.parse(
      execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
        cwd: clean,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_cache: path.join(temporary, 'npm-cache'),
          npm_config_offline: 'true',
        },
      }),
    );
    const installed = path.join(temporary, 'consumer/node_modules/mandala-computer-mcp');
    fs.mkdirSync(installed, { recursive: true });
    execFileSync('tar', [
      '-xzf',
      path.join(temporary, packed[0].filename),
      '--strip-components=1',
      '-C',
      installed,
    ]);
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(installed, 'node_modules'));
    const bin = path.join(temporary, 'consumer/node_modules/.bin/mandala-computer-mcp');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.symlinkSync('../mandala-computer-mcp/dist/cli.js', bin);
    entries = [path.join(clean, 'dist/cli.js'), path.join(installed, 'dist/cli.js'), bin];
    expect(fs.existsSync(path.join(installed, 'dist/credentials.js'))).toBe(true);
    expect(fs.existsSync(path.join(installed, 'src'))).toBe(false);
  }, 30_000);
  afterAll(() => {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  });

  for (const [index, name] of ['built', 'packed direct', 'packed npm bin symlink'].entries())
    it(`M01-local-stdio ${name}: initialize, read and stdin EOF`, async () => {
      const identities: string[] = [];
      const backend = createServer((req, res) => {
        identities.push(req.headers.authorization ?? 'missing');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify([{ ...COMPUTER, name: 'packed-fixture-identity' }]));
      });
      await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
      const doc = baseDocument();
      for (const profile of Object.values(doc.profiles))
        profile.base_url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}/api/v1`;
      save(doc);
      const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      for (const key of Object.keys(childEnv))
        if (key.startsWith('MANDALA_') || key === 'NODE_OPTIONS') delete childEnv[key];
      const child = spawn(process.execPath, [entries[index]], {
        cwd: path.join(temporary, 'consumer'),
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (data) => {
        stderr += String(data);
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      const wire = protocol(child.stdin, child.stdout);
      try {
        expect((await wire.request('initialize', INIT)).error).toBeUndefined();
        wire.notify('notifications/initialized');
        const result = await wire.request('tools/call', { name: 'list_computers', arguments: {} });
        expect(result.result?.isError).not.toBe(true);
        expect(text(result)).toContain('packed-fixture-identity');
        expect(identities).toEqual([`Bearer ${doc.profiles.default.api_key}`]);
        expect(stderr).not.toContain('com_public_fixture_');
        expect(wire.lines.every((line) => JSON.parse(line).jsonrpc === '2.0')).toBe(true);
        child.stdin.end();
        const code = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('stdin EOF did not exit')), 4000);
            timer.unref();
          }),
        ]);
        expect(code).toBe(0);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await exited;
        backend.closeAllConnections();
        await new Promise<void>((resolve) => backend.close(() => resolve()));
      }
    }, 15_000);
});
