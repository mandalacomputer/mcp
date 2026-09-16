import { expect, it } from 'vitest';
import { connect } from './harness.js';

it('registers the eight explicit retained operations through the real MCP server', async () => {
  const c = await connect();
  try {
    const { tools } = await c.client.listTools();
    for (const name of [
      'retain_execution_output',
      'get_result',
      'read_result_output',
      'delete_result',
      'publish_artifact',
      'get_artifact',
      'read_artifact',
      'delete_artifact',
    ])
      expect(tools.map((t) => t.name)).toContain(name);
  } finally {
    await c.close();
  }
});

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, vi } from 'vitest';
import { said } from '../src/format.js';
import { resultMetadata, resultQuery, retainedCall } from '../src/results.js';
import { RETAINED_ID, RETAINED_MANIFEST } from './harness.js';

const original = globalThis.fetch,
  clients: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  globalThis.fetch = original;
  vi.useRealTimers();
});
const text = (r: CallToolResult) =>
  r.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
const data = (r: CallToolResult) => JSON.parse(text(r).slice(text(r).indexOf('{')));
async function setup(reply: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return reply(url, init);
  });
  const c = await connect();
  clients.push(c);
  return { ...c, calls };
}
it('pins annotations and finite schemas for reads/captures/deletes', async () => {
  const c = await connect();
  clients.push(c);
  const tools = (await c.client.listTools()).tools;
  for (const name of ['get_result', 'read_result_output', 'get_artifact', 'read_artifact'])
    expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  for (const name of ['retain_execution_output', 'publish_artifact'])
    expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  for (const name of ['delete_result', 'delete_artifact'])
    expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
});
it('captures exactly once, projects private fields away and never reads guest endpoints', async () => {
  const c = await setup(() =>
    Response.json({ ...RETAINED_MANIFEST, command: 'PRIVATE', error: 'PRIVATE' }, { status: 201 }),
  );
  const r = await c.call('retain_execution_output', {
    execution_id: RETAINED_MANIFEST.execution_id,
    max_bytes_per_stream: 8,
    retention_seconds: 86400,
  });
  expect(r.isError).toBeFalsy();
  expect(data(r)).toEqual(RETAINED_MANIFEST);
  expect(text(r)).not.toContain('PRIVATE');
  expect(c.calls).toHaveLength(1);
  expect(c.calls[0].init?.method).toBe('POST');
  expect(c.calls[0].url.pathname).toBe(
    `/api/v1/computers/vm-1/executions/${RETAINED_MANIFEST.execution_id}/retained-output`,
  );
});
it.each([201, 200])(
  'a malformed capture response at HTTP%i is unconfirmed, never replayed',
  async (status) => {
    const c = await setup(() =>
      Response.json({ ...RETAINED_MANIFEST, result_id: 'PRIVATE-ID' }, { status }),
    );
    const r = await c.call('retain_execution_output', {
      execution_id: RETAINED_MANIFEST.execution_id,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/unconfirmed/);
    expect(text(r)).not.toContain('PRIVATE');
    expect(c.calls).toHaveLength(1);
  },
);
it.each(['stdout', 'stderr', 'diagnostic'])(
  'reads exact independent %s bytes and offset without metadata preflight',
  async (stream) => {
    const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const c = await setup(
      (url) =>
        new Response(raw, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': '256',
            'X-Result-Offset': url.searchParams.get('offset')!,
            'X-Result-Next-Offset': String(Number(url.searchParams.get('offset')) + 256),
            'X-Result-EOF': 'false',
          },
        }),
    );
    const [a, b] = await Promise.all(
      [0, 800].map((offset) =>
        c.call('read_result_output', { result_id: RETAINED_ID, stream, offset, limit: 256 }),
      ),
    );
    expect(data(a)).toMatchObject({
      offset: 0,
      next_offset: 256,
      bytes: 256,
      base64: raw.toString('base64'),
      eof: false,
    });
    expect(data(b).next_offset).toBe(1056);
    expect(c.calls).toHaveLength(2);
  },
);
it.each([
  Buffer.from('\ufeffhello'),
  Buffer.from([0]),
  Buffer.from([0xff]),
  Buffer.from([0xe2, 0x82]),
  Buffer.from('<script>plain bytes</script>'),
])('presents safe byte data without image/resource rendering', async (raw) => {
  const c = await setup(
    () =>
      new Response(raw, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(raw.length),
          'X-Result-Offset': '0',
          'X-Result-Next-Offset': String(raw.length),
          'X-Result-EOF': 'true',
        },
      }),
  );
  const r = await c.call('read_result_output', {
    result_id: RETAINED_ID,
    stream: 'stdout',
    offset: 0,
  });
  const body = data(r);
  expect(Buffer.from(body.base64 ?? body.text, body.base64 ? 'base64' : 'utf8')).toEqual(raw);
  expect(r.content.every((p) => p.type === 'text')).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(256 * 1024);
});
it.each([
  { 'X-Result-Offset': '1' },
  { 'X-Result-Next-Offset': '2' },
  { 'X-Result-EOF': 'False' },
  { 'X-Result-Offset': '0, 0' },
  { 'X-Result-EOF': 'false' },
])('refuses malformed page evidence %j', async (bad) => {
  const c = await setup(
    () =>
      new Response(null, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '0',
          'X-Result-Offset': '0',
          'X-Result-Next-Offset': '0',
          'X-Result-EOF': 'true',
          ...bad,
        },
      }),
  );
  const r = await c.call('read_result_output', {
    result_id: RETAINED_ID,
    stream: 'stdout',
    offset: 0,
  });
  expect(r.isError).toBe(true);
  expect(c.calls).toHaveLength(1);
});
it('preserves unavailable diagnostic409, deletion204 and repeated404 without fallback', async () => {
  let n = 0;
  const c = await setup((_u, init) =>
    init?.method === 'DELETE' && n++ === 0
      ? new Response(null, { status: 204 })
      : Response.json(
          { code: 'result_stream_unavailable', error: 'PRIVATE' },
          { status: init?.method === 'DELETE' ? 404 : 409 },
        ),
  );
  expect((await c.call('delete_result', { result_id: RETAINED_ID })).isError).toBeFalsy();
  expect((await c.call('delete_result', { result_id: RETAINED_ID })).isError).toBe(true);
  const r = await c.call('read_result_output', {
    result_id: RETAINED_ID,
    stream: 'diagnostic',
    offset: 0,
  });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain('HTTP 409');
  expect(text(r)).not.toContain('PRIVATE');
  expect(c.calls).toHaveLength(3);
});
it.each([
  { version: 2 },
  { kind: 'unknown' },
  { computer_id: 'other' },
  { workspace_id: undefined },
  { execution_id: null },
  { captured_at: '2026-02-30T12:00:00Z' },
  {
    execution_observation: {
      status: 'exited',
      observed_at: '2026-09-16T12:00:00.9Z',
      exit_code: 2147483648,
    },
  },
  { stdout: { ...RETAINED_MANIFEST.stdout, next_source_offset: 1 } },
])('rejects invalid finite metadata %j', (bad) =>
  expect(() => resultMetadata({ ...RETAINED_MANIFEST, ...bad }, 'vm-1', RETAINED_ID)).toThrow(),
);
it('preserves nanosecond chronology and finite synchronous truncation', () => {
  const prefix = {
    ...RETAINED_MANIFEST.stdout,
    source_response_bytes: 1,
    end_reason: 'byte_limit',
    upstream_truncated: true,
  };
  const sync = {
    ...RETAINED_MANIFEST,
    kind: 'synchronous-output',
    execution_id: null,
    source: 'exec_response',
    diagnostic: null,
    stdout: prefix,
    stderr: prefix,
  };
  expect(resultMetadata(sync, 'vm-1')).toMatchObject({
    diagnostic: null,
    stdout: { source_response_bytes: 1, upstream_truncated: true },
  });
  expect(() =>
    resultMetadata(
      {
        ...sync,
        captured_at: '2026-09-16T12:00:00.000000001Z',
        execution_observation: {
          ...sync.execution_observation,
          observed_at: '2026-09-16T12:00:00.000000002Z',
        },
      },
      'vm-1',
    ),
  ).toThrow();
  for (const fraction of ['', ...Array.from({ length: 9 }, (_, i) => `.${'1'.repeat(i + 1)}`)])
    expect(
      resultMetadata(
        { ...RETAINED_MANIFEST, captured_at: `2026-09-16T12:00:01${fraction}Z` },
        'vm-1',
      ).captured_at,
    ).toContain(fraction);
});
it.each([
  [-1, 1],
  [true, 1],
  [0, 1.5],
  [Number.MAX_SAFE_INTEGER, 1],
  [0, 16385],
])('rejects offset/limit before I/O: %j %j', (offset, limit) =>
  expect(() => resultQuery('stdout', offset, limit)).toThrow(),
);
it('bounds escaped complete CallToolResult output before returning it', async () => {
  const r = await retainedCall(new AbortController().signal, false, async () =>
    said('payload', { text: '\0'.repeat(200000) }),
  );
  expect(r.isError).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(256 * 1024);
});
it.each(['get_result', 'delete_result'])(
  'rejects trailing-newline identity before any request (%s)',
  async (name) => {
    const c = await setup(() => Response.json(RETAINED_MANIFEST));
    expect((await c.call(name, { result_id: `${RETAINED_ID}\n` })).isError).toBe(true);
    expect(c.calls).toHaveLength(0);
  },
);
