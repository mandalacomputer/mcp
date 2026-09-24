import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareCoverage,
  type Evidence,
  fetchPublishedOpenApi,
  PUBLIC_OPENAPI_URL,
  parseOperations,
} from '../scripts/check-openapi.mjs';
import { connect } from './harness.js';
import {
  checkInventory,
  collectExercises,
  EXERCISE,
  operationEvidence,
} from './surface-exercise.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/openapi-operations.fixture.json', import.meta.url), 'utf8'),
);
const operation = () => ({ responses: { '200': { description: 'fixture' } } });
const document = (paths: unknown, extra = {}) => ({
  openapi: '3.1.0',
  paths,
  servers: [{ url: 'https://app.mandala.computer/api/v1' }],
  ...extra,
});
const evidence = (method: string, path: string): Evidence => [
  { tool: 'actual_tool', requests: [{ method, path }] },
];
const jsonResponse = (value = document({ '/one': { get: operation() } }), init = {}) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...init });
afterEach(() => vi.useRealTimers());

it('covers the explicitly synthetic offline fixture with successful actual MCP tools', async () => {
  expect(fixture['x-provenance']).toContain('never publication evidence');
  const observed = operationEvidence(await collectExercises());
  const summary = compareCoverage(parseOperations(fixture), observed);
  expect(summary.operations).toBeGreaterThan(0);
  expect(summary.tools).toBe(Object.keys(EXERCISE).length);
  const changed = structuredClone(fixture);
  changed.paths['/future-public-operation'] = { post: operation() };
  expect(() => compareCoverage(parseOperations(changed), observed)).toThrow(
    'POST /api/v1/future-public-operation',
  );
  const directory = observed.find((entry) => entry.tool === 'list_directory')!;
  expect(() =>
    compareCoverage(
      parseOperations(fixture),
      observed.filter((entry) => entry !== directory),
    ),
  ).toThrow('GET /api/v1/computers/{id}/files/list');
  expect(() =>
    compareCoverage(
      parseOperations(fixture),
      observed.map((entry) => (entry === directory ? { ...entry, requests: [] } : entry)),
    ),
  ).toThrow('Zero request coverage for tools: list_directory');
});

it('reports a published operation listed as not yet sent, and fails every other gap', async () => {
  const observed = operationEvidence(await collectExercises());
  const changed = structuredClone(fixture);
  changed.paths['/secrets'] = { get: operation(), post: operation() };
  changed.paths['/secrets/{id}'] = { get: operation(), delete: operation() };
  const unsent = ['GET secrets', 'POST secrets', 'GET secrets/:id', 'DELETE secrets/:id'];
  const summary = compareCoverage(parseOperations(changed), observed, { unsent });
  expect(summary.unsent).toEqual([
    'DELETE /api/v1/secrets/{id}',
    'GET /api/v1/secrets',
    'GET /api/v1/secrets/{id}',
    'POST /api/v1/secrets',
  ]);
  // Only what is listed: a route beside it is still a failure.
  expect(() =>
    compareCoverage(parseOperations(changed), observed, { unsent: unsent.slice(1) }),
  ).toThrow('GET /api/v1/secrets');
  expect(() => compareCoverage(parseOperations(changed), observed)).toThrow(
    'Missing published operations',
  );
});

it('lets no exemption cover a trailing-slash twin, and fails one the publication lacks', async () => {
  const observed = operationEvidence(await collectExercises());
  const twin = structuredClone(fixture);
  twin.paths['/secrets'] = { get: operation() };
  twin.paths['/secrets/'] = { get: operation() };
  expect(() =>
    compareCoverage(parseOperations(twin), observed, { unsent: ['GET secrets'] }),
  ).toThrow('GET /api/v1/secrets/');
  // The bare root and its slash twin, published from an origin-level server.
  const root = {
    ...structuredClone(fixture),
    servers: [{ url: 'https://app.mandala.computer' }],
    paths: { '/api/v1': { get: operation() }, '/api/v1/': { get: operation() } },
  };
  const ops = parseOperations(root);
  expect(ops.operations.map((op) => op.path).sort()).toEqual(['/api/v1', '/api/v1/']);
  // Exempting the slash twin (`GET ` + `/`) leaves the bare root a gap.
  expect(() => compareCoverage(ops, observed, { unsent: ['GET '] })).toThrow(
    'Missing published operations:\nGET /api/v1',
  );
  const dropped = structuredClone(fixture);
  dropped.paths['/secrets'] = { get: operation() };
  expect(() =>
    compareCoverage(parseOperations(dropped), observed, {
      unsent: ['GET secrets', 'PUT secrets/:id'],
    }),
  ).toThrow('Not-yet-sent operations absent from the publication:\nPUT /secrets/{}');
});

it('requires exact registered/exercise inventory in both directions', () => {
  expect(() => checkInventory(['one', 'two'], { one: [{}] })).toThrow('missing tools [two]');
  expect(() => checkInventory(['one'], { one: [{}], two: [{}] })).toThrow(
    'unregistered tools [two]',
  );
});

it.each(['error', 'protocol', 'no-request'] as const)(
  'fails and cleans up a real-tool exercise with %s',
  async (kind) => {
    const realFetch = globalThis.fetch;
    const closed = vi.fn();
    await expect(
      collectExercises(EXERCISE, async (cfg) => {
        const conn = await connect(cfg);
        return {
          ...conn,
          close: async () => {
            await conn.close();
            closed();
          },
          call: async (name, args) => {
            if (name !== 'retain_execution_output') return conn.call(name, args);
            if (kind === 'protocol') throw new Error('SECRET should not appear in errors');
            return {
              content: [{ type: 'text', text: 'fixture' }],
              ...(kind === 'error' ? { isError: true } : {}),
            };
          },
        };
      }),
    ).rejects.toThrow(
      kind === 'no-request' ? /Zero request coverage/ : /Tool retain_execution_output/,
    );
    expect(globalThis.fetch).toBe(realFetch);
    expect(closed).toHaveBeenCalledTimes(2);
  },
);

it('requires a request from a later variant even when the earlier variant dispatched', async () => {
  const realFetch = globalThis.fetch;
  let earlierDispatched = 0;
  let suppressed = 0;
  let activeConnections = 0;
  const verdict = await collectExercises(EXERCISE, async (cfg) => {
    const connection = await connect(cfg);
    activeConnections++;
    return {
      ...connection,
      close: async () => {
        await connection.close();
        activeConnections--;
      },
      call: async (name, args) => {
        if (name === 'run_agent_chat' && args?.model === 'claude-test') {
          suppressed++;
          return { content: [{ type: 'text', text: 'No request made' }] };
        }
        const result = await connection.call(name, args);
        if (name === 'run_agent_chat' && !result.isError) earlierDispatched++;
        return result;
      },
    };
  }).then(
    () => 'accepted without a request',
    (error: unknown) => (error instanceof Error ? error.message : 'unknown failure'),
  );
  expect(verdict).toBe('Zero request coverage for tool run_agent_chat variant 2');
  expect(earlierDispatched).toBe(1);
  expect(suppressed).toBe(1);
  expect(activeConnections).toBe(0);
  expect(globalThis.fetch).toBe(realFetch);
});

describe('independent OpenAPI parser and literal matcher', () => {
  it('supports parameter renaming and metadata keys without adding operations', () => {
    const contract = parseOperations(
      document({
        '/computers/{computer_id}': {
          summary: 'one',
          parameters: [],
          servers: [{ url: '/api/v1' }],
          'x-note': {},
          get: operation(),
        },
      }),
    );
    expect(contract.operations).toHaveLength(1);
    expect(compareCoverage(contract, evidence('GET', '/api/v1/computers/a%2Fb')).operations).toBe(
      1,
    );
  });
  it('enforces method, literal path and encoded slash boundaries', () => {
    const contract = parseOperations(document({ '/one/{id}': { post: operation() } }));
    expect(() => compareCoverage(contract, evidence('GET', '/api/v1/one/a'))).toThrow(
      'Missing published',
    );
    expect(() => compareCoverage(contract, evidence('POST', '/api/v1/other/a'))).toThrow(
      'Missing published',
    );
    expect(() => compareCoverage(contract, evidence('POST', '/api/v1/one/a/b'))).toThrow(
      'Missing published',
    );
    expect(compareCoverage(contract, evidence('POST', '/api/v1/one/a%2Fb')).operations).toBe(1);
  });
  it('uses literal precedence without crediting the parameterized path too', () => {
    const contract = parseOperations(
      document({
        '/one/literal': { get: operation() },
        '/one/{id}': { get: operation(), post: operation() },
      }),
    );
    expect(() => compareCoverage(contract, evidence('GET', '/api/v1/one/literal'))).toThrow(
      'GET /api/v1/one/{id}',
    );
    expect(() =>
      compareCoverage(contract, [
        {
          tool: 'one',
          requests: [
            { method: 'GET', path: '/api/v1/one/literal' },
            { method: 'GET', path: '/api/v1/one/id' },
            { method: 'POST', path: '/api/v1/one/literal' },
          ],
        },
      ]),
    ).toThrow('POST /api/v1/one/{id}');
  });
  it('rejects ambiguous dynamic matches instead of covering both', () => {
    const contract = parseOperations(
      document({ '/{first}/literal': { get: operation() }, '/one/{last}': { get: operation() } }),
    );
    expect(() => compareCoverage(contract, evidence('GET', '/api/v1/one/literal'))).toThrow(
      'Ambiguous',
    );
    expect(() =>
      parseOperations(
        document({ '/one/{a}': { get: operation() }, '/one/{b}': { get: operation() } }),
      ),
    ).toThrow('Ambiguous');
  });
  it('honors operation > path > root server inheritance', () => {
    const contract = parseOperations(
      document(
        {
          '/one': {
            servers: [{ url: '/api/v10' }],
            get: { ...operation(), servers: [{ url: '/api/v1' }] },
            post: operation(),
          },
          '/two': { servers: [{ url: '/api/v1' }], get: operation() },
          '/three': { get: operation() },
        },
        { servers: [{ url: '/api/v1' }] },
      ),
    );
    expect(contract.operations.map((op) => op.path)).toEqual([
      '/api/v1/one',
      '/api/v1/two',
      '/api/v1/three',
    ]);
    expect(contract.excluded).toEqual(['POST /api/v10/one']);
    expect(() =>
      parseOperations(
        document({ '/one': { get: operation() } }, { servers: [{ url: '/api/v10' }] }),
      ),
    ).toThrow('No in-scope');
    expect(
      parseOperations(document({ '/api/v1/one': { get: operation() } }, { servers: undefined }))
        .operations,
    ).toHaveLength(1);
  });
  it.each([undefined, [{ url: '/' }]])(
    'accepts fully prefixed paths with absent or root servers: %j',
    (servers) => {
      const contract = parseOperations(
        document({ '/api/v1/one': { get: operation() } }, { servers }),
      );
      expect(contract.operations.map((op) => op.path)).toEqual(['/api/v1/one']);
      expect(compareCoverage(contract, evidence('GET', '/api/v1/one')).operations).toBe(1);
    },
  );
  it('does not erase an operation server override with an already-prefixed path', () => {
    const contract = parseOperations(
      document({
        '/keep': { get: operation() },
        '/api/v1/one': { get: { ...operation(), servers: [{ url: '/api/v10' }] } },
      }),
    );
    expect(contract.excluded).toEqual(['GET /api/v10/api/v1/one']);
    expect(contract.operations.map((op) => op.path)).toEqual(['/api/v1/keep']);
  });
  it('appends the OpenAPI path to the effective server base even when prefixes repeat', () => {
    const contract = parseOperations(document({ '/api/v1/one': { get: operation() } }));
    expect(contract.operations.map((op) => op.path)).toEqual(['/api/v1/api/v1/one']);
    expect(() => compareCoverage(contract, evidence('GET', '/api/v1/one'))).toThrow(
      'GET /api/v1/api/v1/one',
    );
    expect(compareCoverage(contract, evidence('GET', '/api/v1/api/v1/one')).operations).toBe(1);
  });
  it('keeps root and trailing-slash operations distinct', () => {
    const contract = parseOperations(
      document({ '/': { get: operation() }, '/one/': { post: operation() } }),
    );
    expect(
      compareCoverage(contract, [
        {
          tool: 'one',
          requests: [
            { method: 'GET', path: '/api/v1/' },
            { method: 'POST', path: '/api/v1/one/' },
          ],
        },
      ]).operations,
    ).toBe(2);
    expect(() => compareCoverage(contract, evidence('POST', '/api/v1/one'))).toThrow(
      'Missing published',
    );
  });
  it.each(['head', 'options'])('requires actual evidence for published %s', (method) => {
    const contract = parseOperations(
      document({ '/one': { get: operation(), [method]: operation() } }),
    );
    expect(() => compareCoverage(contract, evidence('GET', '/api/v1/one'))).toThrow(
      `${method.toUpperCase()} /api/v1/one`,
    );
  });
  it.each([
    null,
    {},
    { openapi: '2.0', paths: {} },
    document([]),
    document({}),
    document({ '/one': null }),
    document({ '/one': { $ref: '#/components/pathItems/One' } }),
    document({ '/one': { get: null } }),
    document({ '/one': { get: [] } }),
    document({ '/one': { get: {} } }),
    document({ '/one': { get: { responses: { '200': null } } } }),
    document({ '/one': { get: operation() } }, { servers: [] }),
    document(
      { '/one': { get: operation() } },
      {
        servers: [
          { url: 'https://{tenant}.test/api/v1', variables: { tenant: { default: 'app' } } },
        ],
      },
    ),
    document({ '/one': { get: operation() } }, { servers: [{ $ref: '#/server' }] }),
    document({ '/one': { servers: 'wrong', get: operation() } }),
    document({
      '/one': { get: { ...operation(), servers: [{ url: 'https://user:secret@test/api/v1' }] } },
    }),
    document({ '/one': { get: { $ref: '#/op' } } }),
  ])('fails malformed/unsupported/empty document %#', (value) => {
    expect(() => parseOperations(value)).toThrow();
  });
  it('refuses empty request comparisons', () => {
    const contract = parseOperations(document({ '/one': { get: operation() } }));
    expect(() => compareCoverage(contract, [])).toThrow('No tool request');
    expect(() => compareCoverage(contract, [{ tool: 'registered', requests: [] }])).toThrow(
      'Zero request',
    );
  });
});

describe('bounded anonymous public fetch, mocked without sockets', () => {
  it('sends one anonymous fixed-URL request and reports a contract digest', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse());
    const result = await fetchPublishedOpenApi({ fetchImpl });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      PUBLIC_OPENAPI_URL,
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      }),
    );
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it.each([206, 301, 302, 403, 404, 429, 500])(
    'fails HTTP %i once without retry',
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ secret: 'NEVER-PRINT' } as never, { status }));
      await expect(fetchPublishedOpenApi({ fetchImpl })).rejects.toThrow(`HTTP ${status}`);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
  it.each([
    () => new Response('<html>challenge</html>', { headers: { 'Content-Type': 'text/html' } }),
    () =>
      new Response('<html>challenge</html>', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    () => jsonResponse({} as never),
    () => new Response(null, { status: 204, headers: { 'Content-Type': 'application/json' } }),
  ])('fails challenge/invalid/empty content %# without dumping the body', async (response) => {
    await expect(
      fetchPublishedOpenApi({ fetchImpl: vi.fn().mockResolvedValue(response()) }),
    ).rejects.toThrow(/Published OpenAPI/);
  });
  it('refuses followed redirects even from a fetch implementation ignoring redirect:error', async () => {
    const response = jsonResponse();
    Object.defineProperty(response, 'redirected', { value: true });
    await expect(
      fetchPublishedOpenApi({ fetchImpl: vi.fn().mockResolvedValue(response) }),
    ).rejects.toThrow('redirect rejected');
  });
  it.each([false, true])('enforces the byte ceiling with declared length=%s', async (declared) => {
    const response = new Response(' '.repeat(100), {
      headers: {
        'Content-Type': 'application/json',
        ...(declared ? { 'Content-Length': '100' } : {}),
      },
    });
    await expect(
      fetchPublishedOpenApi({ fetchImpl: vi.fn().mockResolvedValue(response), maxBytes: 50 }),
    ).rejects.toThrow('body size limit');
  });
  it.each(['headers', 'body'])(
    'the overall deadline bounds stalled %s and cancels owned resources',
    async (phase) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Type': 'application/json' },
      });
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(() =>
          phase === 'headers' ? new Promise(() => {}) : Promise.resolve(response),
        );
      const pending = fetchPublishedOpenApi({ fetchImpl, timeoutMs: 5 });
      const rejected = expect(pending).rejects.toThrow('deadline exceeded');
      await vi.advanceTimersByTimeAsync(6);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
      if (phase === 'body') expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it('normalizes a fetch exception without leaking its raw message', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('SECRET-RAW-REQUEST'));
    await expect(fetchPublishedOpenApi({ fetchImpl })).rejects.toThrow(
      'Published OpenAPI fetch failed:',
    );
  });
});

it('selects the strict entry point in a separate CI job, without fixture fallback', () => {
  const entry = readFileSync(new URL('./openapi-public.check.ts', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../vitest.openapi.config.ts', import.meta.url), 'utf8');
  const workflow = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  ).split('  published-openapi:')[1];
  expect(config).toContain("include: ['test/openapi-public.check.ts']");
  expect(entry).toContain('await fetchPublishedOpenApi()');
  expect(entry).not.toMatch(/fixture|process\.env|\.skip|catch\s*\(/);
  expect(workflow).toContain('npx vitest run --config vitest.openapi.config.ts');
  expect(workflow).toContain('contents: read');
  expect(workflow).not.toMatch(/continue-on-error|\n\s+if:|secrets\./);
});
