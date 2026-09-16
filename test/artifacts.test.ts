import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, expect, it, vi } from 'vitest';
import { artifactMetadata, artifactOptions } from '../src/artifacts.js';
import { ARTIFACT_BYTES, ARTIFACT_ID, ARTIFACT_MANIFEST, connect } from './harness.js';

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
const nomination = {
  path: '/tmp/nominated',
  expected_size: 3,
  expected_sha256: ARTIFACT_MANIFEST.sha256,
  execution_id: ARTIFACT_MANIFEST.execution_association.execution_id,
};
it.each(['/tmp/ file \\ ', 'C:\\Users\\name\\file ', 'D:/a', '\\\\server\\share\\file', '/tmp/😀'])(
  'nominates caller-supplied version without path normalization or guest preflight: %s',
  async (path) => {
    const c = await setup(() =>
      Response.json(
        { ...ARTIFACT_MANIFEST, account_id: 'PRIVATE', path: 'PRIVATE' },
        { status: 201 },
      ),
    );
    const r = await c.call('publish_artifact', {
      ...nomination,
      path,
      max_bytes: 8,
      retention_seconds: 86400,
    });
    expect(r.isError).toBeFalsy();
    expect(data(r)).toEqual(ARTIFACT_MANIFEST);
    expect(c.calls).toHaveLength(1);
    expect(JSON.parse(c.calls[0].init?.body as string)).toEqual({
      ...nomination,
      path,
      max_bytes: 8,
      retention_seconds: 86400,
    });
    expect(c.calls[0].url.pathname).toBe('/api/v1/computers/vm-1/artifacts');
  },
);
it.each(['relative', '/tmp/\0', '/tmp/\uD800', '/tmp/\uDC00', `/${'a'.repeat(4096)}`])(
  'rejects invalid nomination path before I/O: %s',
  (path) => expect(() => artifactOptions({ ...nomination, path })).toThrow(),
);
it.each([
  { expected_size: true },
  { expected_size: -1 },
  { expected_size: 4, max_bytes: 3 },
  { expected_sha256: 'A'.repeat(64) },
  { max_bytes: null },
  { retention_seconds: 604801 },
  { execution_id: null },
  { extra: 'private' },
])('rejects unsafe nomination values %j', (bad) =>
  expect(() => artifactOptions({ ...nomination, ...bad })).toThrow(),
);
it('leaves a mismatched successful publication unconfirmed with one POST', async () => {
  const c = await setup(() =>
    Response.json({ ...ARTIFACT_MANIFEST, sha256: 'a'.repeat(64) }, { status: 201 }),
  );
  const r = await c.call('publish_artifact', nomination);
  expect(r.isError).toBe(true);
  expect(text(r)).toContain('unconfirmed');
  expect(c.calls).toHaveLength(1);
});
it.each([Buffer.alloc(0), ARTIFACT_BYTES, Buffer.from('\ufeffsame'), Buffer.from([1, 2, 3])])(
  'reads and hashes a complete artifact with exact two-request routing',
  async (bytes) => {
    const metadata = {
      ...ARTIFACT_MANIFEST,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const c = await setup((url) =>
      url.pathname.endsWith('/download')
        ? new Response(bytes, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(bytes.length),
            },
          })
        : Response.json(metadata),
    );
    const r = await c.call('read_artifact', { artifact_id: ARTIFACT_ID });
    expect(r.isError).toBeFalsy();
    const body = data(r);
    expect(body.verified).toBe(true);
    expect(Buffer.from(body.base64 ?? body.text, body.base64 ? 'base64' : 'utf8')).toEqual(bytes);
    expect(c.calls.map((v) => v.url.pathname)).toEqual([
      `/api/v1/computers/vm-1/artifacts/${ARTIFACT_ID}`,
      `/api/v1/computers/vm-1/artifacts/${ARTIFACT_ID}/download`,
    ]);
    expect(c.calls.every((v) => !new Headers(v.init?.headers).has('Range'))).toBe(true);
    expect(r.content.every((v) => v.type === 'text')).toBe(true);
  },
);
it('returns metadata only before an over-cap content request', async () => {
  const c = await setup(() => Response.json({ ...ARTIFACT_MANIFEST, size: 4097 }));
  const r = await c.call('read_artifact', { artifact_id: ARTIFACT_ID });
  expect(r.isError).toBe(true);
  expect(data(r).size).toBe(4097);
  expect(data(r).verified).toBeUndefined();
  expect(c.calls).toHaveLength(1);
  expect(text(r)).toContain('No content was downloaded');
});
it.each(['hash', 'size', 'length', '206', 'content-range', 'encoding', '401', 'missing-length'])(
  'refuses an invalid whole artifact %s with no partial success',
  async (mode) => {
    const c = await setup((url) =>
      !url.pathname.endsWith('/download')
        ? Response.json(ARTIFACT_MANIFEST)
        : mode === '401'
          ? Response.json({ error: 'PRIVATE' }, { status: 401 })
          : new Response(
              mode === 'size'
                ? new Uint8Array(2)
                : mode === 'hash'
                  ? new Uint8Array(3)
                  : ARTIFACT_BYTES,
              {
                status: mode === '206' ? 206 : 200,
                headers: {
                  'Content-Type': 'application/octet-stream',
                  ...(mode === 'missing-length'
                    ? {}
                    : { 'Content-Length': mode === 'length' ? '2' : '3' }),
                  ...(mode === 'content-range' ? { 'Content-Range': 'bytes 0-2/3' } : {}),
                  ...(mode === 'encoding' ? { 'Content-Encoding': 'gzip' } : {}),
                },
              },
            ),
    );
    const r = await c.call('read_artifact', { artifact_id: ARTIFACT_ID });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain('base64');
    expect(text(r)).not.toContain('PRIVATE');
    expect(c.calls).toHaveLength(2);
  },
);
it('keeps the selected computer pinned during metadata and bytes', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  const c = await setup(async (url) => {
    if (url.pathname.endsWith('/download'))
      return new Response(ARTIFACT_BYTES, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' },
      });
    if (url.pathname === '/api/v1/computers/vm-2')
      return Response.json({ id: 'vm-2', status: 'running' });
    entered();
    await gate;
    return Response.json(ARTIFACT_MANIFEST);
  });
  const pending = c.call('read_artifact', { artifact_id: ARTIFACT_ID });
  await started;
  await c.call('use_computer', { computer_id: 'vm-2' });
  release();
  expect((await pending).isError).toBeFalsy();
  expect(c.calls.at(-1)?.url.pathname).toBe(
    `/api/v1/computers/vm-1/artifacts/${ARTIFACT_ID}/download`,
  );
});
it('shares one operation signal across metadata and content and clears it at completion', async () => {
  const signals: AbortSignal[] = [];
  const c = await setup((url, init) => {
    signals.push(init!.signal!);
    return url.pathname.endsWith('/download')
      ? new Response(ARTIFACT_BYTES, {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' },
        })
      : Response.json(ARTIFACT_MANIFEST);
  });
  expect((await c.call('read_artifact', { artifact_id: ARTIFACT_ID })).isError).toBeFalsy();
  expect(signals).toHaveLength(2);
  expect(signals[0]).toBe(signals[1]);
  expect(signals[0].aborted).toBe(true);
});
it('deletes only the nominated artifact and preserves repeated404', async () => {
  let n = 0;
  const c = await setup(() =>
    n++ === 0
      ? new Response(null, { status: 204 })
      : Response.json({ error: 'PRIVATE' }, { status: 404 }),
  );
  expect((await c.call('delete_artifact', { artifact_id: ARTIFACT_ID })).isError).toBeFalsy();
  expect((await c.call('delete_artifact', { artifact_id: ARTIFACT_ID })).isError).toBe(true);
  expect(c.calls.every((v) => v.init?.method === 'DELETE')).toBe(true);
  expect(c.calls).toHaveLength(2);
});
it.each([
  { kind: 'unknown' },
  { artifact_id: 'art_bad' },
  { computer_id: 'other' },
  { execution_association: {} },
  { created_at: '2026-02-30T00:00:00Z' },
  { size: 1.5 },
])('projects only known artifact evidence %j', (bad) =>
  expect(() => artifactMetadata({ ...ARTIFACT_MANIFEST, ...bad }, 'vm-1', ARTIFACT_ID)).toThrow(),
);
it('ends a held download at the same90s operation deadline that included metadata', async () => {
  let metadataEntered!: () => void, release!: () => void, downloadEntered!: () => void;
  const first = new Promise<void>((r) => (metadataEntered = r)),
    gate = new Promise<void>((r) => (release = r)),
    second = new Promise<void>((r) => (downloadEntered = r)),
    cancel = vi.fn();
  const c = await setup(async (url) => {
    if (url.pathname.endsWith('/download')) {
      downloadEntered();
      return new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' },
      });
    }
    metadataEntered();
    await gate;
    return Response.json(ARTIFACT_MANIFEST);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const pending = c.client.callTool(
    { name: 'read_artifact', arguments: { artifact_id: ARTIFACT_ID } },
    undefined,
    { timeout: 180000 },
  );
  await first;
  await vi.advanceTimersByTimeAsync(70000);
  release();
  await second;
  await vi.advanceTimersByTimeAsync(20001);
  const r = (await pending) as CallToolResult;
  expect(r.isError).toBe(true);
  expect(text(r)).toContain('cancelled');
  expect(cancel).toHaveBeenCalled();
  expect(c.calls).toHaveLength(2);
});
it('cancels a real MCP held content reader and releases the registered callback lifetime', async () => {
  let entered!: () => void, stopped!: () => void;
  const began = new Promise<void>((r) => (entered = r)),
    ended = new Promise<void>((r) => (stopped = r));
  const c = await setup((url) => {
    if (!url.pathname.endsWith('/download')) return Response.json(ARTIFACT_MANIFEST);
    entered();
    return new Response(new ReadableStream({ cancel: stopped }), {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' },
    });
  });
  const controller = new AbortController();
  const pending = c.client.callTool(
    { name: 'read_artifact', arguments: { artifact_id: ARTIFACT_ID } },
    undefined,
    { signal: controller.signal },
  );
  await began;
  controller.abort();
  await expect(pending).rejects.toThrow();
  await ended;
  expect(c.calls).toHaveLength(2);
});
