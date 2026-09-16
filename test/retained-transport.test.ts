import { afterEach, expect, it, vi } from 'vitest';
import { Api } from '../src/api.js';
import { APIError, CancelledError, RedirectError } from '../src/errors.js';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.useRealTimers();
});
const api = () => new Api('com_PRIVATE', 'https://gateway.test/prefix/api/v1?tenant=kept');
const headers = { 'Content-Type': 'application/octet-stream' };
it('keeps scoped URL/auth and exact complete bytes across chunk boundaries', async () => {
  const raw = Uint8Array.from({ length: 256 }, (_, i) => i);
  const sent: { url: URL; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (input, init) => {
    sent.push({ url: new URL(String(input)), init });
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(raw.slice(0, 97));
          c.enqueue(raw.slice(97));
          c.close();
        },
      }),
      { headers: { ...headers, 'Content-Length': '256' } },
    );
  });
  const response = await api().boundedBytes('GET', 'computers/vm-1/results/id/output', 256, 200);
  expect(response.bytes).toEqual(raw);
  expect(sent[0].url.pathname).toBe('/prefix/api/v1/computers/vm-1/results/id/output');
  expect(sent[0].url.searchParams.get('tenant')).toBe('kept');
  expect(sent[0].init).toMatchObject({
    redirect: 'manual',
    headers: { Authorization: 'Bearer com_PRIVATE', 'Accept-Encoding': 'identity' },
  });
});
it.each([
  { status: 206 },
  { extra: { 'Content-Range': 'bytes 0-2/3' } },
  { extra: { 'Content-Encoding': 'gzip' } },
  { extra: { 'Content-Length': '2' } },
  { extra: { 'Content-Length': '4' } },
  { extra: { 'Content-Length': '3, 3' } },
  { extra: { 'Content-Length': '03' } },
])('refuses non-full or inconsistent evidence %j', async ({ status, extra }) => {
  const cancel = vi.fn();
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
            c.close();
          },
          cancel,
        }),
        {
          status: status ?? 200,
          headers: {
            ...headers,
            ...Object.fromEntries(Object.entries(extra ?? {}).filter(([, v]) => v !== undefined)),
          },
        },
      ),
  );
  await expect(api().boundedBytes('GET', 'retained', 3, 200)).rejects.toThrow();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});
it('requires EOF at the exact cap and cancels an oversized response without retaining a prefix', async () => {
  let pulls = 0;
  const cancel = vi.fn();
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulls++;
            c.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel,
        }),
        { headers },
      ),
  );
  await expect(api().boundedBytes('GET', 'retained', 3, 200)).rejects.toThrow('exceeds');
  expect(pulls).toBeLessThanOrEqual(3);
  expect(cancel).toHaveBeenCalled();
});
it('does not wait indefinitely for peer cancellation on refusal', async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(9));
          },
          cancel,
        }),
        { headers },
      ),
  );
  await expect(api().boundedBytes('GET', 'retained', 8, 200)).rejects.toThrow('exceeds');
  expect(cancel).toHaveBeenCalledOnce();
});
it.each(['headers', 'body', 'error', 'redirect'] as const)(
  'cancellation bounds %s and performs no credentialed retry',
  async (phase) => {
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      cancel = vi.fn();
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async () => {
      entered();
      if (phase === 'headers') return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ cancel }), {
        status: phase === 'error' ? 503 : phase === 'redirect' ? 302 : 200,
        headers: { ...headers, Location: 'https://PRIVATE.example/secret' },
      });
    });
    const pending = api().with(controller.signal).boundedBytes('GET', 'retained', 8, 200);
    await started;
    controller.abort(new Error('caller-private-reason'));
    await expect(pending).rejects.toBeInstanceOf(
      phase === 'redirect' ? RedirectError : CancelledError,
    );
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  },
);
it('rejects already aborted work without calling fetch and cancels late headers', async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = vi.fn();
  await expect(
    api().with(controller.signal).boundedJson('GET', 'retained', 8, 200),
  ).rejects.toBeInstanceOf(CancelledError);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  let release!: (r: Response) => void;
  const active = new AbortController();
  globalThis.fetch = vi.fn(() => new Promise<Response>((r) => (release = r)));
  const pending = api().with(active.signal).boundedBytes('GET', 'retained', 8, 200);
  active.abort();
  await expect(pending).rejects.toBeInstanceOf(CancelledError);
  const cancel = vi.fn();
  release(new Response(new ReadableStream({ cancel })));
  await Promise.resolve();
  expect(cancel).toHaveBeenCalled();
});
it('bounds error bodies and preserves status without exposing an unbounded body', async () => {
  const cancel = vi.fn();
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(9000));
          },
          cancel,
        }),
        { status: 409 },
      ),
  );
  try {
    await api().boundedJson('POST', 'retained', 8192, 201);
    throw Error('expected refusal');
  } catch (e) {
    expect(e).toBeInstanceOf(APIError);
    expect(e).toMatchObject({ status: 409 });
  }
  expect(cancel).toHaveBeenCalled();
});
it.each(['bad-json', 'bad-utf8', 'oversize', 'wrong-type'])(
  'refuses bounded JSON %s',
  async (mode) => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          mode === 'bad-utf8'
            ? new Uint8Array([255])
            : mode === 'bad-json'
              ? '{'
              : mode === 'oversize'
                ? ' '.repeat(9)
                : '{}',
          { headers: { 'Content-Type': mode === 'wrong-type' ? 'text/html' : 'application/json' } },
        ),
    );
    await expect(api().boundedJson('GET', 'retained', 8, 200)).rejects.toThrow();
  },
);
it('reports a body reset instead of successful partial bytes', async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1]));
            c.error(new Error('reset'));
          },
        }),
        { headers },
      ),
  );
  await expect(api().boundedBytes('GET', 'retained', 8, 200)).rejects.toThrow();
});
