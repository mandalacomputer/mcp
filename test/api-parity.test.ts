import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { PLATFORM_HEADERS_TIMEOUT_MS } from '../src/api.js';
import { BASE, connect, fakeEvents, installFakePlatform } from './harness.js';

const COMPUTER = {
  id: 'vm-1',
  name: 'desk',
  status: 'running',
  state: 'live',
  resolution: '1280x800x24',
  vnc: { events_url: 'wss://app.test/api/v1/computers/vm-1/events?token=test' },
};

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const originalFetch = globalThis.fetch;
const connections: Awaited<ReturnType<typeof connect>>[] = [];
const open = async (cfg: Parameters<typeof connect>[0] = {}) => {
  const connection = await connect(cfg);
  connections.push(connection);
  return connection;
};
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  globalThis.fetch = originalFetch;
});

describe('template catalogue parity', () => {
  const catalogue = [
    {
      name: 'desktop',
      os: 'linux',
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 30,
      description: 'A desktop image',
      launch: { supported: true, restrictions: ['region'] },
      future_metadata: { preserved: true },
    },
  ];

  it.each([null, '0', '3'])('preserves the body with incomplete header %s', async (header) => {
    const seen: URL[] = [];
    globalThis.fetch = (async (input) => {
      seen.push(new URL(String(input)));
      return response(catalogue, 200, header === null ? {} : { 'X-GC-Incomplete': header });
    }) as typeof fetch;
    const { call, client } = await open();
    const result = await call('list_templates');
    expect(result.isError).toBeFalsy();
    const output = textOf(result);
    if (header === null) expect(output).toBe(JSON.stringify(catalogue, null, 2));
    else {
      expect(output.startsWith('INCOMPLETE')).toBe(true);
      expect(output).toContain('templates');
      expect(output).toContain('retry');
      expect(output.endsWith(JSON.stringify(catalogue, null, 2))).toBe(true);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].pathname).toBe('/api/v1/templates');
    expect(seen[0].search).toBe('');
    const tool = (await client.listTools()).tools.find((t) => t.name === 'list_templates');
    expect(tool?.inputSchema.properties).not.toHaveProperty('allow_partial');
  });

  it('warns when the partial catalogue is empty', async () => {
    globalThis.fetch = (async () => response([], 200, { 'X-GC-Incomplete': '0' })) as typeof fetch;
    const { call } = await open();
    const output = textOf(await call('list_templates'));
    expect(output.startsWith('INCOMPLETE')).toBe(true);
    expect(output.endsWith('[]')).toBe(true);
  });

  it.each(['null', 'empty body'])('still refuses a %s catalogue', async (kind) => {
    globalThis.fetch = (async () =>
      kind === 'null' ? response(null) : new Response(null, { status: 204 })) as typeof fetch;
    const { call } = await open();
    expect((await call('list_templates')).isError).toBe(true);
  });

  it('cancels a catalogue read through the registered tool', async () => {
    const started = deferred<AbortSignal>();
    const finished = deferred<void>();
    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      started.resolve(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const { client } = await open({ activity: () => () => finished.resolve() });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'list_templates', arguments: {} }, undefined, {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    const signal = await started.promise;
    controller.abort();
    await rejected;
    await finished.promise;
    expect(signal.aborted).toBe(true);
  });
});

describe('exec timeout parity through the registered schema', () => {
  it.each([301, 600])('sends the exact supported timeout %s', async (timeout_s) => {
    const platform = installFakePlatform();
    const { call } = await open();
    const result = await call('exec', { command: 'true', timeout_s });
    expect(result.isError).toBeFalsy();
    expect(platform.calls.at(-1)?.body).toMatchObject({ command: 'true', timeout_s });
    expect(PLATFORM_HEADERS_TIMEOUT_MS).toBeGreaterThan(timeout_s * 1000);
  });

  it.each([601, 300.5])('rejects invalid timeout %s without a request', async (timeout_s) => {
    const platform = installFakePlatform();
    const { call } = await open();
    expect((await call('exec', { command: 'true', timeout_s })).isError).toBe(true);
    expect(platform.calls).toHaveLength(0);
  });

  it('keeps the default and background behavior', async () => {
    const platform = installFakePlatform();
    const { call, client } = await open();
    await call('exec', { command: 'true' });
    expect(platform.calls.at(-1)?.body).toEqual({ command: 'true', timeout_s: 30 });
    await call('exec', { command: 'true', timeout_s: 600, background: true });
    expect(platform.calls.at(-1)?.body).toMatchObject({ timeout_s: 600, background: true });
    const schema = (await client.listTools()).tools.find((t) => t.name === 'exec')?.inputSchema;
    expect(schema?.properties?.timeout_s).toMatchObject({ type: 'integer', maximum: 600 });
  });
});

describe('failed computer deletion reconciliation', () => {
  const purgeError = 'VM deleted but snapshot purge failed; retry cleanup';
  const args = {
    computer_id: 'vm-1',
    confirm: true,
    delete_snapshots: true,
    expect: 'fp-shown-to-caller',
  };
  function platformWith(read: (init?: RequestInit) => Response | Promise<Response>, status = 500) {
    const seen: { method: string; url: URL; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      seen.push({ method, url, init });
      if (method === 'DELETE') return response({ error: purgeError }, status);
      if (url.pathname === '/api/v1/computers/vm-1') return read(init);
      return response({ ...COMPUTER, id: 'vm-2' });
    }) as typeof fetch;
    return seen;
  }

  it.each([
    ['404', () => response({ error: 'not found' }, 404)],
    ['matching deleted state', () => response({ id: 'vm-1', state: 'deleted' })],
    ['wrapped deleted state', () => response({ computer: { id: 'vm-1', state: 'deleted' } })],
  ])('unbinds confirmed absence (%s) but preserves the purge error', async (_label, read) => {
    const seen = platformWith(read);
    const { call } = await open({ baseUrl: `${BASE}?workspace=mine`, computerId: ' vm-1\n' });
    const result = await call('delete_computer', args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(purgeError);
    expect(textOf(await call('get_computer'))).toContain('No computer selected');
    expect(seen.map((s) => s.method)).toEqual(['DELETE', 'GET']);
    for (const request of seen) {
      expect(request.url.pathname).toBe('/api/v1/computers/vm-1');
      expect(request.url.searchParams.get('workspace')).toBe('mine');
      expect(new Headers(request.init?.headers).get('Authorization')).toBe('Bearer com_test');
    }
    expect(seen[0].url.searchParams.get('expect')).toBe(args.expect);
    expect(seen[1].url.searchParams.get('snapshots')).toBeNull();
  });

  it.each([
    ['live', { id: 'vm-1', state: 'live', status: 'running' }],
    ['unreachable', { id: 'vm-1', state: 'unreachable' }],
    ['lost', { id: 'vm-1', state: 'lost' }],
    ['deleting', { id: 'vm-1', state: 'deleting' }],
    ['unknown', { id: 'vm-1', state: 'unknown' }],
    ['missing state', { id: 'vm-1' }],
    ['status without authoritative state', { id: 'vm-1', status: 'deleted' }],
    ['different id', { id: 'vm-2', state: 'deleted' }],
    ['missing id', { state: 'deleted' }],
    ['null', null],
    ['array', [{ id: 'vm-1', state: 'deleted' }]],
    ['unreachable deleted record', { id: 'vm-1', state: 'deleted', unreachable: true }],
  ])('keeps selection for an inconclusive %s record', async (_label, body) => {
    const seen = platformWith(() => response(body));
    const { call } = await open();
    const result = await call('delete_computer', args);
    expect(textOf(result)).toContain(purgeError);
    expect(result.isError).toBe(true);
    const afterDelete = seen.length;
    await call('get_computer');
    expect(seen.length).toBe(afterDelete + 1);
    expect(seen.map((s) => s.method)).toEqual(['DELETE', 'GET', 'GET']);
  });

  it.each(['server failure', 'invalid JSON', 'transport failure'])(
    'keeps selection on %s',
    async (kind) => {
      const seen = platformWith(() => {
        if (kind === 'transport failure') throw new TypeError('connection lost');
        if (kind === 'invalid JSON')
          return new Response('broken', { headers: { 'Content-Type': 'application/json' } });
        return response({ error: 'read failed' }, 503);
      });
      const { call } = await open();
      expect(textOf(await call('delete_computer', args))).toContain(purgeError);
      const result = await call('get_computer');
      expect(textOf(result)).not.toContain('No computer selected');
      expect(seen.map((s) => s.method)).toEqual(['DELETE', 'GET', 'GET']);
    },
  );

  it('keeps the existing idempotent 404 behavior without another read', async () => {
    const seen = platformWith(() => response(COMPUTER), 404);
    const { call } = await open();
    const result = await call('delete_computer', args);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Nothing was deleted');
    expect(textOf(await call('get_computer'))).toContain('No computer selected');
    expect(seen.map((s) => s.method)).toEqual(['DELETE']);
  });

  it('drops the deleted computer event subscription', async () => {
    const events = fakeEvents();
    let gone = false;
    platformWith(() => (gone ? response({}, 404) : response(COMPUTER)));
    const { call } = await open({ webSocket: events.factory });
    await call('poll_events');
    expect(events.last().closed).toBe(false);
    gone = true;
    await call('delete_computer', args);
    expect(events.last().closed).toBe(true);
  });

  it('invalidates an earlier selection without disrupting another selected computer', async () => {
    const started = deferred<void>();
    const selection = deferred<Response>();
    let reads = 0;
    const seen = platformWith(() => {
      if (++reads === 1) {
        started.resolve();
        return selection.promise;
      }
      return response({}, 404);
    });
    const { call } = await open();
    const selecting = call('use_computer', { computer_id: 'vm-1' });
    await started.promise;
    await call('use_computer', { computer_id: 'vm-2' });
    expect(textOf(await call('delete_computer', args))).toContain(purgeError);
    selection.resolve(response(COMPUTER));
    expect(textOf(await selecting)).toContain('deleted while it was being selected');
    const current = await call('get_computer');
    expect(current.isError).toBeFalsy();
    expect(seen.at(-1)?.url.pathname).toBe('/api/v1/computers/vm-2');
    expect(seen.filter((s) => s.method === 'DELETE')).toHaveLength(1);
  });

  it('bounds a hung reconciliation and preserves the original error and selection', async () => {
    const seen = platformWith(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const { call } = await open();
    const started = Date.now();
    expect(textOf(await call('delete_computer', args))).toContain(purgeError);
    expect(Date.now() - started).toBeLessThan(7000);
    expect(seen[1].init?.signal?.aborted).toBe(true);
    globalThis.fetch = (async () => response(COMPUTER)) as typeof fetch;
    expect((await call('get_computer')).isError).toBeFalsy();
  }, 10_000);

  it.each(['DELETE', 'GET'])('honors cancellation during %s and keeps selection', async (phase) => {
    const started = deferred<AbortSignal>();
    const finished = deferred<void>();
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method !== phase) return response({ error: purgeError }, 500);
      const signal = init?.signal as AbortSignal;
      started.resolve(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const { client, call } = await open({ activity: () => () => finished.resolve() });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'delete_computer', arguments: args }, undefined, {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    const signal = await started.promise;
    controller.abort();
    await rejected;
    await finished.promise;
    expect(signal.aborted).toBe(true);
    expect(methods).toEqual(phase === 'DELETE' ? ['DELETE'] : ['DELETE', 'GET']);
    globalThis.fetch = (async () => response(COMPUTER)) as typeof fetch;
    expect((await call('get_computer')).isError).toBeFalsy();
  });
});
