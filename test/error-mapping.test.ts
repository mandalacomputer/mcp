import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../src/api.js';
import {
  APIError,
  CancelledError,
  ConflictError,
  errorForStatus,
  FileExistsError,
  isTransient,
  MoveRequiredError,
  RangeNotSatisfiableError,
  RateLimitError,
  reasonAdvice,
  reasonKind,
} from '../src/errors.js';
import * as publicApi from '../src/index.js';

const originalFetch = globalThis.fetch;
const api = () => new Api('com_synthetic', 'https://api.example.invalid/api/v1');
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('HTTP error response contract', () => {
  it('maps unsupported methods and preserves header-first diagnostics', async () => {
    const body = { error: 'method not allowed', request_id: 'body-id' };
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), {
        status: 405,
        headers: { 'X-Request-ID': 'header-id', Allow: 'GET, HEAD, POST, OPTIONS' },
      });
    const error = await api()
      .json('PUT', 'computers')
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      name: 'MethodNotAllowedError',
      status: 405,
      message: body.error,
      body,
      requestId: 'header-id',
      allow: 'GET, HEAD, POST, OPTIONS',
    });
    expect(error).toBeInstanceOf(publicApi.MethodNotAllowedError);
    expect(isTransient(error)).toBe(false);
  });
  it('reads nested finite messages/reasons using the actual HTTP status and whole body', async () => {
    const body = {
      error: {
        message: 'authority revoked during the run',
        code: 503,
        reason: 'revoked',
        usage: { total_tokens: 5 },
      },
      request_id: 'outer-id',
    };
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      });
    const error = await api()
      .json('POST', 'chat/completions')
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      name: 'AuthenticationError',
      status: 401,
      message: body.error.message,
      reason: 'revoked',
      requestId: 'outer-id',
      body,
      wwwAuthenticate: 'Bearer error="invalid_token"',
    });
    expect(isTransient(error)).toBe(false);
  });
  it('does not treat terminal HTTP statuses or nested run reasons as replay permission', () => {
    for (const status of [401, 402, 403, 404, 405]) {
      expect(isTransient(errorForStatus(status, 'refused', { reason: 'contention' }))).toBe(false);
    }
    expect(isTransient(errorForStatus(400, 'partial run', { error: { reason: 'starting' } }))).toBe(
      false,
    );
    expect(isTransient(errorForStatus(400, 'starting', { reason: 'starting' }))).toBe(true);
  });
});

async function refusal(
  body: unknown,
  status = 401,
  headers: ConstructorParameters<typeof Headers>[0] = {},
  method = 'GET',
) {
  globalThis.fetch = vi.fn(
    async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
  );
  const error = await api()
    .json(method, 'computers')
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(APIError);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  return error as APIError;
}

describe('optional correlation and authentication fields', () => {
  it.each([
    { body: { request_id: 'body-only' }, headers: {}, id: 'body-only' },
    {
      body: { request_id: 'body-fallback' },
      headers: { 'x-REQUEST-id': ' ' },
      id: 'body-fallback',
    },
    { body: { request_id: ' ' }, headers: {}, id: undefined },
    { body: { request_id: 12 }, headers: {}, id: undefined },
    { body: { request_id: [] }, headers: {}, id: undefined },
    { body: { request_id: {} }, headers: {}, id: undefined },
    { body: { error: { request_id: 'provider-id' } }, headers: {}, id: undefined },
    { body: null, headers: {}, id: undefined },
    { body: [], headers: {}, id: undefined },
    { body: undefined, headers: { 'X-Request-ID': 'head-id' }, id: 'head-id' },
  ])('shape-checks correlation: $body', async ({ body, headers, id }) => {
    const error = await refusal(
      body,
      401,
      headers as Record<string, string>,
      body === undefined ? 'HEAD' : 'GET',
    );
    expect(error.requestId).toBe(id);
    expect(error.allow).toBeUndefined();
    expect(error.wwwAuthenticate).toBeUndefined();
  });
  it.each(['missing', 'invalid', 'revoked', 'unknown-future', 'contention', 'starting'])(
    'preserves reason %s without replay permission',
    async (reason) => {
      const challenge = reason === 'missing' ? 'Bearer' : 'Bearer error="invalid_token"';
      const error = await refusal({ error: 'credential refused', reason }, 401, {
        'WWW-Authenticate': challenge,
      });
      expect(error).toBeInstanceOf(publicApi.AuthenticationError);
      expect(error.reason).toBe(reason);
      expect(error.wwwAuthenticate).toBe(challenge);
      expect(isTransient(error)).toBe(false);
    },
  );
  it.each([
    { reason: 'outer', error: { reason: 'inner' }, expected: 'outer' },
    { reason: 12, error: { reason: 'inner' }, expected: 'inner' },
    { error: { reason: 12 }, expected: undefined },
    { reason: {}, error: [], expected: undefined },
    { reason: '', error: { reason: 'inner' }, expected: '' },
    { error: { message: 'Provider refused' }, expected: undefined },
  ])('keeps reason precedence and shapes: %j', async ({ expected, ...body }) => {
    const error = await refusal(body);
    expect(error.reason).toBe(expected);
    expect(error.wwwAuthenticate).toBeUndefined();
  });
  it('does not accept body Allow or challenge fields', async () => {
    const error = await refusal(
      { error: 'refused', allow: 'DELETE', www_authenticate: 'Basic' },
      405,
    );
    expect(error.allow).toBeUndefined();
    expect(error.wwwAuthenticate).toBeUndefined();
  });
  it.each(['<html>Refused</html>', '{"error":', 'not JSON'])(
    'retains headers with an unreadable body: %s',
    async (body) => {
      globalThis.fetch = async () =>
        new Response(body, {
          status: 405,
          headers: { Allow: 'GET, HEAD, OPTIONS', 'X-Request-ID': 'plain-id' },
        });
      const error = await api()
        .json('HEAD', 'sizes')
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        status: 405,
        name: 'MethodNotAllowedError',
        requestId: 'plain-id',
        allow: 'GET, HEAD, OPTIONS',
        body,
      });
    },
  );
  it.each([401, 405, 429])('keeps HTTP %i when its body fails after headers', async (status) => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          }),
          {
            status,
            headers: {
              'X-Request-ID': 'reset-id',
              Allow: 'GET',
              'Retry-After': '7',
              'WWW-Authenticate': 'Bearer',
            },
          },
        ),
    );
    const error = await api()
      .json('GET', 'computers')
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      status,
      requestId: 'reset-id',
      allow: 'GET',
      wwwAuthenticate: 'Bearer',
      retryAfterMs: 7000,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not copy an earlier response ID into a concurrent or local failure', async () => {
    globalThis.fetch = vi.fn(async (url) =>
      Response.json(
        { error: 'refused', request_id: String(url).endsWith('one') ? 'one-id' : 'two-id' },
        { status: 401 },
      ),
    );
    const client = api();
    const failures = await Promise.all(
      ['one', 'two'].map((path) => client.json('GET', path).catch((error: APIError) => error)),
    );
    expect(failures.map((value) => (value as APIError).requestId)).toEqual(['one-id', 'two-id']);
    globalThis.fetch = async () => {
      throw new TypeError('connection ended');
    };
    const local = await client.json('GET', 'one').catch((error: unknown) => error);
    expect(local).toBeInstanceOf(publicApi.ConnectivityInterruptedError);
    expect(local).not.toHaveProperty('requestId');
  });
});

describe('special constructors and transport branches', () => {
  it.each([400, 405, 429, 409, 416, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526])(
    'preserves metadata through HTTP %i factory paths',
    async (status) => {
      const body = status === 409 ? { move: { required: true, possible: false } } : undefined;
      const error = await refusal(body, status, {
        'X-Request-ID': `id-${status}`,
        'Retry-After': '3',
        Allow: 'GET',
        'WWW-Authenticate': 'Bearer',
        'Content-Range': 'bytes */143',
      });
      expect(error).toMatchObject({
        requestId: `id-${status}`,
        retryAfterMs: 3000,
        allow: 'GET',
        wwwAuthenticate: 'Bearer',
      });
      if (status === 416) expect(error).toMatchObject({ size: 143 });
      if (status === 409) expect(error).toMatchObject({ movePossible: false });
      if (status === 502) expect(error).toBeInstanceOf(publicApi.OriginResponseError);
    },
  );
  it.each([true, false])('preserves direct and factory move constructors: %s', (possible) => {
    const body = { move: { required: true, possible }, request_id: 'body-id' };
    expect(errorForStatus(409, 'move', body, 900, { requestId: 'header-id' })).toMatchObject({
      movePossible: possible,
      retryAfterMs: 900,
      requestId: 'header-id',
    });
    expect(new MoveRequiredError('move', 409, body, possible, 800)).toMatchObject({
      movePossible: possible,
      retryAfterMs: 800,
      requestId: 'body-id',
    });
  });
  it('keeps positional constructor compatibility and direct body fallback', () => {
    const body = { request_id: 'direct-id' };
    expect(new APIError('refused', 400, body, 500)).toMatchObject({
      body,
      retryAfterMs: 500,
      requestId: 'direct-id',
    });
    expect(new RateLimitError('slow', 429, body, 600)).toMatchObject({
      retryAfterMs: 600,
      requestId: 'direct-id',
    });
    expect(
      new RangeNotSatisfiableError('range', 416, body, 150, 700, { requestId: 'header' }),
    ).toMatchObject({ size: 150, retryAfterMs: 700, requestId: 'header' });
    expect(errorForStatus(416, 'range', body, 800, { requestId: 'factory' })).toMatchObject({
      size: undefined,
      retryAfterMs: 800,
      requestId: 'factory',
    });
  });
  it('cancels redirect bodies and retains received headers without following Location', async () => {
    const cancel = vi.fn();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 307,
          headers: { Location: '/elsewhere', 'X-Request-ID': 'redirect-id', Allow: 'POST' },
        }),
    );
    const error = await api()
      .json('POST', 'computers')
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      name: 'RedirectError',
      status: 307,
      requestId: 'redirect-id',
      allow: 'POST',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
  it.each(['no such file in the guest', 'computer not found', 'no such endpoint'])(
    'retains ordinary NotFoundError: %s',
    async (message) => {
      expect(await refusal({ error: message }, 404)).toMatchObject({
        name: 'NotFoundError',
        message,
      });
    },
  );
  it.each([null, [], 17, {}, ' '])(
    'does not coerce a malformed nested message: %j',
    async (message) => {
      const error = await refusal({ error: { message } }, 400);
      expect(error.message).not.toBe('[object Object]');
      expect(error.body).toEqual({ error: { message } });
    },
  );
  it('preserves raw SSE correlation and nested errors without reopening a successful stream', async () => {
    const body = {
      error: { message: 'partial run', code: 429, reason: 'starting' },
      request_id: 'frame-id',
    };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, {
          headers: {
            'Content-Type': 'text/event-stream',
            'X-Request-ID': 'stream-id',
            'Retry-After': '99',
          },
        }),
    );
    const frames = [];
    for await (const frame of api().sse('POST', 'chat/completions')) frames.push(frame);
    expect(frames[0].data).toEqual(body);
    expect(frames.at(-1)?.data).toBe('[DONE]');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
  it.each([401, 405, 429])(
    'keeps bounded HTTP %i diagnostics when the retained error body is oversized',
    async (status) => {
      globalThis.fetch = vi.fn(async (_url, init) => {
        expect(new Headers(init?.headers).has('x-request-id')).toBe(false);
        return new Response('x'.repeat(9000), {
          status,
          headers: { 'X-Request-ID': 'bounded-id', Allow: 'GET', 'Retry-After': '4' },
        });
      });
      const error = await api()
        .boundedJson('GET', 'results/example', 1024, 200)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        status,
        requestId: 'bounded-id',
        allow: 'GET',
        retryAfterMs: 4000,
      });
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    },
  );
  it('preserves cancellation instead of turning it into a diagnostic HTTP error', async () => {
    const controller = new AbortController();
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull() {
            controller.abort();
            throw new DOMException('cancelled', 'AbortError');
          },
        }),
        { status: 401, headers: { 'X-Request-ID': 'cancelled-id' } },
      );
    const error = await api()
      .json('GET', 'computers', { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CancelledError);
    expect(error).not.toHaveProperty('requestId');
  });
});

describe('a create-only upload onto a taken path (OPL-4994)', () => {
  it('arrives as FileExistsError, a ConflictError that is not transient', () => {
    const error = errorForStatus(409, 'a file already exists at /a', {
      error: 'a file already exists at /a',
      reason: 'exists',
    });
    expect(error).toBeInstanceOf(FileExistsError);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ name: 'FileExistsError', status: 409, reason: 'exists' });
    expect(isTransient(error)).toBe(false);
    expect(publicApi.FileExistsError).toBe(FileExistsError);
  });

  it('classifies the word as permanent and says nothing was written', () => {
    expect(reasonKind('exists')).toBe('permanent');
    expect(reasonAdvice('exists')).toContain('nothing was written');
  });

  it('leaves another word on the same status an ordinary ConflictError', () => {
    for (const reason of ['unsupported', 'some-future-word']) {
      const error = errorForStatus(409, 'refused', { error: 'refused', reason });
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).not.toBeInstanceOf(FileExistsError);
    }
  });
});
