import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import * as hosted from '../src/http.js';
import { runHttp } from '../src/http.js';
import { ACCOUNT_QUOTA } from './harness.js';

it('rejects an occupied port without announcing successful startup', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const port = (occupied.address() as AddressInfo).port;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(runHttp({ port, host: '127.0.0.1' })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(log.mock.calls.some(([line]) => String(line).includes(' on http://'))).toBe(false);
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

it('resolves a listening server and closes it successfully', async () => {
  const server = await runHttp({ port: 0, host: '127.0.0.1' });
  expect(server.listening).toBe(true);
  expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  expect(server.listening).toBe(false);
});

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'identity-fixture', version: '1' },
  },
};
const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/credentials-v1.json', import.meta.url), 'utf8'),
);

async function isolatedHosted(store: 'valid' | 'corrupt' | 'unsafe') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hosted-credentials-'));
  const directory = path.join(home, '.mandala');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, 'credentials.json'),
    store === 'corrupt' ? '{' : JSON.stringify(fixture.base_document),
    { mode: store === 'unsafe' ? 0o644 : 0o600 },
  );
  const realFetch = globalThis.fetch;
  const run = hosted.runHttp;
  let server: Server | undefined;
  const seen: string[] = [];
  vi.stubEnv('MANDALA_API_KEY', 'fixture-operator');
  vi.stubEnv('MANDALA_PROFILE', '../operator-invalid-profile');
  vi.stubEnv('MANDALA_BASE_URL', undefined);
  vi.stubEnv('HOME', home);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(hosted, 'runHttp').mockImplementation(async (cfg) => {
    server = await run(cfg);
    return server;
  });
  const lookup = vi.spyOn(os, 'homedir').mockImplementation(() => {
    throw new Error('poison home reached');
  });
  // Instrument store-specific operations; lazy dependency/module-loader reads
  // are unrelated to credential loading and must not produce false positives.
  const io: string[] = [];
  const storeDescriptors = new Set<number>();
  const touch = (value: unknown) => {
    if (String(value).includes(home)) io.push(String(value));
  };
  const lstat = fs.lstatSync;
  const stat = fs.statSync;
  const openFile = fs.openSync;
  const readFile = fs.readFileSync;
  const read = fs.readSync;
  const fstat = fs.fstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    touch(args[0]);
    return lstat(...args);
  }) as typeof fs.lstatSync);
  vi.spyOn(fs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    touch(args[0]);
    return stat(...args);
  }) as typeof fs.statSync);
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    touch(args[0]);
    const fd = openFile(...args);
    if (String(args[0]).includes(home)) storeDescriptors.add(fd);
    return fd;
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation(((
    ...args: Parameters<typeof fs.readFileSync>
  ) => {
    touch(args[0]);
    return readFile(...args);
  }) as typeof fs.readFileSync);
  vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    if (storeDescriptors.has(args[0])) io.push('read');
    return read(...args);
  }) as typeof fs.readSync);
  vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
    if (storeDescriptors.has(args[0])) io.push('fstat');
    return fstat(...args);
  }) as typeof fs.fstatSync);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://hosted-fixture.test/')) return realFetch(input, init);
    const key = new Headers(init?.headers).get('authorization') ?? '';
    seen.push(key);
    if (key !== 'Bearer fixture-callerA' && key !== 'Bearer fixture-callerB')
      return Response.json({ error: 'Credential revoked', reason: 'revoked' }, { status: 401 });
    return Response.json({
      ...ACCOUNT_QUOTA,
      plan: {
        id: key.endsWith('callerA') ? 'callerA' : 'callerB',
        label: 'Fixture account identity',
      },
    });
  });
  try {
    // A missing profile value must be ignored too, before any local validation.
    await main([
      '--http',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--profile',
      '--base-url',
      'https://hosted-fixture.test/api/v1',
    ]);
  } catch (error) {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/mcp`;
  const post = (body: unknown, key?: string, session?: string) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(key === undefined ? {} : { Authorization: key }),
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify(body),
    });
  const open = async (key: string) => {
    const response = await post(INIT, key);
    expect(response.status).toBe(200);
    const session = response.headers.get('mcp-session-id')!;
    await response.text();
    const initialized = await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      key,
      session,
    );
    await initialized.text();
    return session;
  };
  const account = async (key: string, session: string) => {
    const response = await post(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_account', arguments: {} },
      },
      key,
      session,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    const json = body.startsWith('{')
      ? body
      : body
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5)
          .trim();
    return JSON.parse(json) as {
      result: { isError?: boolean; content: { type: string; text?: string }[] };
    };
  };
  return {
    post,
    open,
    account,
    seen,
    close: async () => {
      try {
        expect(lookup).not.toHaveBeenCalled();
        expect(io).toEqual([]);
        expect(seen).not.toContain('Bearer fixture-operator');
        expect(seen).not.toContain(`Bearer ${fixture.base_document.profiles.default.api_key}`);
      } finally {
        server!.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

it('M02-http-no-key', async () => {
  for (const store of ['valid', 'corrupt', 'unsafe'] as const) {
    const http = await isolatedHosted(store);
    try {
      for (const auth of [undefined, 'Basic fixture-callerA', 'Bearer']) {
        const response = await http.post(INIT, auth);
        expect(response.status).toBe(401);
        await response.text();
      }
      expect(http.seen).toEqual([]);
    } finally {
      await http.close();
    }
  }
});

it('M03-http-wrong-key', async () => {
  for (const store of ['valid', 'corrupt', 'unsafe'] as const) {
    const http = await isolatedHosted(store);
    try {
      const key = 'Bearer fixture-wrong';
      const session = await http.open(key);
      const reply = await http.account(key, session);
      expect(reply.result.isError).toBe(true);
      const output = reply.result.content.map((item) => item.text ?? '').join('\n');
      expect(output).toContain('"status": 401');
      expect(output).toContain('"reason": "revoked"');
      expect(http.seen).toEqual([key]);
    } finally {
      await http.close();
    }
  }
});

it('M04-two-callers', async () => {
  for (const store of ['valid', 'corrupt', 'unsafe'] as const) {
    const http = await isolatedHosted(store);
    try {
      for (const name of ['callerA', 'callerB']) {
        const key = `Bearer fixture-${name}`;
        const session = await http.open(key);
        const reply = await http.account(key, session);
        expect(reply.result.isError).not.toBe(true);
        expect(reply.result.content.map((item) => item.text ?? '').join('\n')).toContain(
          `"id": "${name}"`,
        );
      }
      expect(http.seen).toEqual(['Bearer fixture-callerA', 'Bearer fixture-callerB']);
    } finally {
      await http.close();
    }
  }
});
