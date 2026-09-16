import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareCoverage, parseOperations } from '../scripts/check-openapi.mjs';
import type { ServerConfig } from '../src/server.js';
import { ACCOUNT_QUOTA, connect, fakeEvents, installFakePlatform } from './harness.js';
import {
  checkInventory,
  collectExercises,
  EXERCISE,
  operationEvidence,
} from './surface-exercise.js';

const connections: Awaited<ReturnType<typeof connect>>[] = [];
let platform: ReturnType<typeof installFakePlatform>;
beforeEach(() => {
  platform = installFakePlatform();
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  platform.restore();
  vi.restoreAllMocks();
});
async function open(cfg: Partial<ServerConfig> = {}) {
  const connection = await connect({ computerId: undefined, modelKey: undefined, ...cfg });
  connections.push(connection);
  return connection;
}
const text = (result: CallToolResult) =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
const data = (result: CallToolResult) => JSON.parse(text(result).split('\n\n')[1]);
function respond(value: unknown, status = 200, headers: Record<string, string> = {}) {
  const record = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await record(...args);
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  };
}
function set(value: unknown, path: string, replacement: unknown) {
  const parts = path.split('.');
  let current = value as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) current = current[part] as Record<string, unknown>;
  current[parts.at(-1)!] = replacement;
}
function partial(computers: boolean, snapshots: boolean) {
  const value = structuredClone(ACCOUNT_QUOTA);
  value.complete = { computers, snapshots };
  for (const group of [value.usage, value.remaining]) {
    for (const key of Object.keys(group)) {
      if (key === 'snapshot_storage_bytes' ? !snapshots : !computers) set(group, key, null);
    }
  }
  return value;
}

it('registers get_account with no input and performs one authenticated account read', async () => {
  const events = fakeEvents();
  const connection = await open({ apiKey: 'com_quota', webSocket: events.factory });
  const tool = (await connection.client.listTools()).tools.find(
    (tool) => tool.name === 'get_account',
  );
  expect(tool?.inputSchema).toMatchObject({
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
  expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  const result = await connection.call('get_account');
  expect(result.isError).not.toBe(true);
  expect(data(result)).toEqual(ACCOUNT_QUOTA);
  expect(text(result)).toMatch(/^ADVISORY/);
  expect(text(result).split('\n\n')[0]).toContain('indexed stored bytes only');
  expect(text(result).split('\n\n')[0]).toContain(
    'in-flight capture reservations are not included',
  );
  expect(platform.calls).toEqual([
    {
      method: 'GET',
      path: '/account',
      pathname: '/api/v1/account',
      body: undefined,
      query: new URLSearchParams(),
      headers: expect.objectContaining({ authorization: 'Bearer com_quota' }),
    },
  ]);
  expect(platform.calls[0].headers['x-model-key']).toBeUndefined();
  expect(events.sockets).toHaveLength(0);
});

it.each([
  { account_id: 'another-account' },
  { computer_id: 'another-computer' },
  { allow_partial: true },
])('refuses undeclared input before any request: %j', async (args) => {
  const connection = await open();
  expect((await connection.call('get_account', args)).isError).toBe(true);
  expect(platform.calls).toEqual([]);
});

it('projects only the public fields at every object level', async () => {
  const value = structuredClone(ACCOUNT_QUOTA);
  for (const object of [value, ...Object.values(value).filter((item) => typeof item === 'object')])
    Object.assign(object, { unexpected: 'UNEXPECTED-ACCOUNT-DATA' });
  respond(value);
  const result = await (await open()).call('get_account');
  expect(result.isError).not.toBe(true);
  expect(data(result)).toEqual(ACCOUNT_QUOTA);
  expect(text(result)).not.toContain('UNEXPECTED-ACCOUNT-DATA');
});

it.each([
  [false, true],
  [true, false],
  [false, false],
])(
  'preserves independent unknown groups: computers=%s snapshots=%s',
  async (computers, snapshots) => {
    const value = partial(computers, snapshots);
    respond(value);
    const result = await (await open()).call('get_account');
    expect(result.isError).not.toBe(true);
    expect(data(result)).toEqual(value);
    expect(text(result)).toMatch(/^UNKNOWN /);
    expect(text(result).split('\n\n')[0]).toContain('null is not zero');
    expect(platform.calls).toHaveLength(1);
  },
);

it('preserves complete zero consumption and full numeric headroom', async () => {
  const value = structuredClone(ACCOUNT_QUOTA);
  for (const key of Object.keys(value.usage)) set(value.usage, key, 0);
  value.remaining = {
    kept_computers: 5,
    configured_vcpu: 16,
    configured_disk_gb: 200,
    running_or_reserved_ram_mb: 32768,
    snapshot_storage_bytes: 107374182400,
  };
  respond(value);
  const result = await (await open()).call('get_account');
  expect(result.isError).not.toBe(true);
  expect(data(result)).toEqual(value);
  expect(text(result)).not.toContain('UNKNOWN');
});

it('preserves retained usage above zero no-plan ceilings and clamps only remaining', async () => {
  const value = structuredClone(ACCOUNT_QUOTA);
  value.plan = { id: 'none', label: 'No plan' };
  for (const group of [value.limits, value.per_computer, value.remaining])
    for (const key of Object.keys(group)) set(group, key, 0);
  respond(value);
  const result = await (await open()).call('get_account');
  expect(result.isError).not.toBe(true);
  expect(data(result)).toEqual(value);
  expect(data(result).usage.snapshot_storage_bytes).toBe(1073741825);
  expect(data(result).remaining.snapshot_storage_bytes).toBe(0);
});

describe('complete aggregate consistency', () => {
  const contradictions = [
    {
      name: 'active count exceeds kept count',
      usage: { running_or_reserved_computers: 8 },
      remaining: {},
    },
    {
      name: 'active CPU exceeds configured CPU',
      usage: { running_or_reserved_vcpu: 8 },
      remaining: {},
    },
    {
      name: 'zero active count still has active CPU',
      usage: { running_or_reserved_computers: 0, running_or_reserved_ram_mb: 0 },
      remaining: { running_or_reserved_ram_mb: 32768 },
    },
    {
      name: 'zero active count still has reserved RAM',
      usage: { running_or_reserved_computers: 0, running_or_reserved_vcpu: 0 },
      remaining: {},
    },
    {
      name: 'active count exceeds positive integer RAM reservations',
      usage: { running_or_reserved_computers: 2, running_or_reserved_ram_mb: 1 },
      remaining: { running_or_reserved_ram_mb: 32767 },
    },
    {
      name: 'positive active count has zero reserved RAM',
      usage: { running_or_reserved_vcpu: 0, running_or_reserved_ram_mb: 0 },
      remaining: { running_or_reserved_ram_mb: 32768 },
    },
    {
      name: 'no kept computers still has configured CPU',
      usage: {
        kept_computers: 0,
        configured_disk_gb: 0,
        running_or_reserved_computers: 0,
        running_or_reserved_vcpu: 0,
        running_or_reserved_ram_mb: 0,
      },
      remaining: { kept_computers: 5, configured_disk_gb: 200, running_or_reserved_ram_mb: 32768 },
    },
    {
      name: 'no kept computers still has configured disk',
      usage: {
        kept_computers: 0,
        configured_vcpu: 0,
        running_or_reserved_computers: 0,
        running_or_reserved_vcpu: 0,
        running_or_reserved_ram_mb: 0,
      },
      remaining: { kept_computers: 5, configured_vcpu: 16, running_or_reserved_ram_mb: 32768 },
    },
  ];
  it.each(contradictions)(
    'refuses $name despite correct remaining subtraction',
    async ({ usage, remaining }) => {
      const value = structuredClone(ACCOUNT_QUOTA);
      Object.assign(value.usage, usage);
      Object.assign(value.remaining, remaining);
      respond(value);
      const result = await (await open()).call('get_account');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Malformed metadata response');
      expect(text(result)).not.toMatch(/"remaining"|"usage"/);
      expect(platform.calls).toHaveLength(1);
    },
  );

  it('permits configured holdings with no active computers', async () => {
    const value = structuredClone(ACCOUNT_QUOTA);
    Object.assign(value.usage, {
      running_or_reserved_computers: 0,
      running_or_reserved_vcpu: 0,
      running_or_reserved_ram_mb: 0,
    });
    value.remaining.running_or_reserved_ram_mb = 32768;
    respond(value);
    const result = await (await open()).call('get_account');
    expect(result.isError).not.toBe(true);
    expect(data(result)).toEqual(value);
  });

  it('permits zero CPU and disk quantities with positive integer RAM reservations', async () => {
    const value = structuredClone(ACCOUNT_QUOTA);
    Object.assign(value.usage, {
      configured_vcpu: 0,
      configured_disk_gb: 0,
      running_or_reserved_computers: 2,
      running_or_reserved_vcpu: 0,
      running_or_reserved_ram_mb: 2,
    });
    Object.assign(value.remaining, {
      configured_vcpu: 16,
      configured_disk_gb: 200,
      running_or_reserved_ram_mb: 32766,
    });
    respond(value);
    const result = await (await open()).call('get_account');
    expect(result.isError).not.toBe(true);
    expect(data(result)).toEqual(value);
  });

  it('permits consistent complete aggregates above positive plan ceilings', async () => {
    const value = structuredClone(ACCOUNT_QUOTA);
    value.usage = {
      kept_computers: 8,
      configured_vcpu: 40,
      configured_disk_gb: 400,
      running_or_reserved_computers: 8,
      running_or_reserved_vcpu: 40,
      running_or_reserved_ram_mb: 40000,
      snapshot_storage_bytes: 107374182401,
    };
    value.remaining = {
      kept_computers: 0,
      configured_vcpu: 0,
      configured_disk_gb: 0,
      running_or_reserved_ram_mb: 0,
      snapshot_storage_bytes: 0,
    };
    respond(value);
    const result = await (await open()).call('get_account');
    expect(result.isError).not.toBe(true);
    expect(data(result)).toEqual(value);
  });
});

const malformedFields: [string, unknown][] = [
  ['scope', 'workspace'],
  ['advisory', false],
  ['observed_at', '2026-02-30T12:00:00Z'],
  ['observed_at', '2026-09-16T12:00:00'],
  ['plan.id', ''],
  ['plan.label', null],
  ['complete.computers', 'true'],
  ['complete.snapshots', undefined],
  ['capabilities.windows', 0],
  ['limits.vcpu_pool', -1],
  ['limits.ram_pool_mb', '4096'],
  ['limits.disk_pool_gb', 0.5],
  ['limits.snapshot_storage_bytes', Number.MAX_SAFE_INTEGER + 1],
  ['per_computer.max_vcpu', null],
  ['per_computer.max_ram_mb', undefined],
  ['usage.kept_computers', undefined],
  ['usage.configured_vcpu', null],
  ['usage.configured_disk_gb', '60'],
  ['usage.running_or_reserved_computers', -1],
  ['usage.running_or_reserved_vcpu', 0.5],
  ['usage.running_or_reserved_ram_mb', Infinity],
  ['usage.snapshot_storage_bytes', null],
  ['remaining.kept_computers', undefined],
  ['remaining.configured_vcpu', 100],
  ['remaining.configured_disk_gb', -1],
  ['remaining.running_or_reserved_ram_mb', null],
  ['remaining.snapshot_storage_bytes', 1],
  ['complete.computers', false],
  ['complete.snapshots', false],
];
it.each(malformedFields)(
  'refuses malformed or inconsistent %s=%j without reporting numbers',
  async (path, replacement) => {
    const value = structuredClone(ACCOUNT_QUOTA);
    set(value, path, replacement);
    Object.assign(value, { unexpected: 'UNEXPECTED-ACCOUNT-DATA' });
    respond(value);
    const result = await (await open()).call('get_account');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Malformed metadata response');
    expect(text(result)).not.toMatch(/UNEXPECTED-ACCOUNT-DATA|"remaining"|"usage"/);
    expect(platform.calls).toHaveLength(1);
  },
);

it.each([null, [], {}, { data: ACCOUNT_QUOTA }, 'UNEXPECTED-ACCOUNT-DATA'])(
  'refuses malformed envelopes without converting them to empty accounts: %j',
  async (value) => {
    respond(value);
    const result = await (await open()).call('get_account');
    expect(result.isError).toBe(true);
    expect(text(result)).not.toMatch(/UNEXPECTED-ACCOUNT-DATA|"remaining"|"usage"/);
    expect(platform.calls).toHaveLength(1);
  },
);

it('does not expose raw invalid JSON from the response decoder', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response('UNEXPECTED-ACCOUNT-DATA', {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const result = await (await open()).call('get_account');
  expect(result.isError).toBe(true);
  expect(text(result)).toContain('consumption and remaining quota are unknown');
  expect(text(result)).not.toContain('UNEXPECTED-ACCOUNT-DATA');
  expect(globalThis.fetch).toHaveBeenCalledOnce();
});

it.each([401, 403, 402, 429, 503])(
  'preserves HTTP %i and public refusal text without retry or arbitrary fields',
  async (status) => {
    respond(
      {
        error: 'Public quota refusal',
        reason: 'unavailable',
        unexpected: 'UNEXPECTED-ACCOUNT-DATA',
      },
      status,
      { 'Retry-After': '2' },
    );
    const result = await (await open()).call('get_account');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`Public quota refusal (HTTP ${status})`);
    expect(text(result)).toContain('"retry_after_ms": 2000');
    expect(text(result)).not.toMatch(/UNEXPECTED-ACCOUNT-DATA|"remaining"|"usage"/);
    expect(platform.calls).toHaveLength(1);
  },
);

it.each([null, [], {}, { unexpected: 'UNEXPECTED-ACCOUNT-DATA' }, 'UNEXPECTED-ACCOUNT-DATA'])(
  'keeps the status without echoing an undocumented HTTP error envelope: %j',
  async (value) => {
    respond(value, 503);
    const result = await (await open()).call('get_account');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Account quota request failed (HTTP 503)');
    expect(text(result)).not.toContain('UNEXPECTED-ACCOUNT-DATA');
    expect(platform.calls).toHaveLength(1);
  },
);

it('binds cancellation to the outstanding GET and releases its callback', async () => {
  const events = fakeEvents();
  const release = vi.fn();
  const connection = await open({ webSocket: events.factory, activity: () => release });
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = vi.fn(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal as AbortSignal;
        requestSignal.addEventListener('abort', () => reject(requestSignal?.reason), {
          once: true,
        });
      }),
  );
  const controller = new AbortController();
  const pending = connection.client.callTool({ name: 'get_account', arguments: {} }, undefined, {
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(requestSignal).toBeDefined());
  controller.abort();
  await rejected;
  await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(events.sockets).toHaveLength(0);
});

describe('incoming account operation evidence', () => {
  it('requires its concrete request in the synthetic OpenAPI contract', async () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/openapi-operations.fixture.json', import.meta.url), 'utf8'),
    );
    expect(fixture['x-provenance']).toContain('never publication evidence');
    expect(fixture.paths['/account'].get.responses['200']).toBeDefined();
    const observed = operationEvidence(await collectExercises());
    const account = observed.find((entry) => entry.tool === 'get_account');
    expect(account?.requests).toEqual([{ method: 'GET', path: '/api/v1/account' }]);
    expect(() => compareCoverage(parseOperations(fixture), observed)).not.toThrow();
    expect(() =>
      compareCoverage(
        parseOperations(fixture),
        observed.filter((entry) => entry !== account),
      ),
    ).toThrow('GET /api/v1/account');
    expect(() =>
      compareCoverage(
        parseOperations(fixture),
        observed.map((entry) => (entry === account ? { ...entry, requests: [] } : entry)),
      ),
    ).toThrow('Zero request coverage for tools: get_account');
  });
  it('rejects registration without an exercise or a successful call without an HTTP request', async () => {
    const connection = await open({ modelKey: 'sk-fixture' });
    const names = (await connection.client.listTools()).tools.map((tool) => tool.name);
    const exercise = { ...EXERCISE };
    delete exercise.get_account;
    expect(() => checkInventory(names, exercise)).toThrow('missing tools [get_account]');
    await expect(
      collectExercises(EXERCISE, async (cfg) => {
        const connection = await connect(cfg);
        return {
          ...connection,
          call: async (name, args) =>
            name === 'get_account'
              ? { content: [{ type: 'text' as const, text: 'No request made' }] }
              : connection.call(name, args),
        };
      }),
    ).rejects.toThrow('Zero request coverage for tool get_account variant 1');
  });
});
