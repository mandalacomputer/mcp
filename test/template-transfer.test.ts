import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../src/api.js';
import {
  APIError,
  ConflictError,
  errorForStatus,
  isTransient,
  RateLimitError,
} from '../src/errors.js';
import { createBody } from '../src/paths.js';
import { BASE, connect } from './harness.js';

const said = (result: CallToolResult) =>
  result.content.map((item) => ('text' in item ? item.text : '')).join('\n');
const metadata = (result: CallToolResult) =>
  JSON.parse(said(result).split('\n\n').at(-1) ?? 'null');
const token = ' opaque-token ';
const original = {
  template: 'example/devbox@1.0.0',
  name: 'desk',
  cpu: 2,
  ram_mb: 2048,
  disk_gb: 30,
  resolution: '1280x800',
  start: false,
};

function refusal(state: unknown, delay?: string) {
  return new Response(
    JSON.stringify({
      code: 'template_image_preparing',
      template_transfer: token,
      error: 'Image unavailable',
      preparation: {
        state,
        error: state === 'failed' ? 'Image preparation could not finish' : undefined,
      },
    }),
    {
      status: 409,
      headers: {
        'Content-Type': 'application/json',
        ...(delay === undefined ? {} : { 'Retry-After': delay }),
      },
    },
  );
}

describe('template image preparation continuation', () => {
  let real: typeof fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['preparing', 'copying', 'ready'])(
    'reports %s and the actual delay without replaying',
    async (state) => {
      const fetch = vi.fn(async () => refusal(state, '12'));
      globalThis.fetch = fetch;
      const { call, close } = await connect();
      try {
        const result = await call('create_computer', original);
        expect(result.isError).toBe(true);
        expect(metadata(result)).toEqual({
          code: 'template_image_preparing',
          template_transfer: token,
          preparation: { state },
          retry_after_ms: 12000,
        });
        expect(said(result)).toContain('Wait 12000 milliseconds');
        expect(said(result)).toContain('all original identical arguments, including template');
        expect(said(result)).toContain('Stop after success');
        expect(said(result)).toContain(
          'Never automatically replay after a lost or ambiguous response',
        );
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        await close();
      }
    },
  );

  it.each([
    {},
    { size: 'small' },
    { template: '' },
    { template: '  ' },
    { template: original.template, size: 'small' },
  ])('does not advise an invalid continuation of original arguments %j', async (args) => {
    globalThis.fetch = vi.fn(async () => refusal('preparing', '5'));
    const { call, close } = await connect();
    try {
      const result = await call('create_computer', args);
      expect(result.isError).toBe(true);
      expect(metadata(result)).toEqual({
        code: 'template_image_preparing',
        template_transfer: token,
        preparation: { state: 'preparing' },
        retry_after_ms: 5000,
      });
      expect(said(result)).toContain(
        'The original create must include a nonblank template and omit size',
      );
      expect(said(result)).toContain('do not automatically wait or retry');
      expect(said(result)).not.toMatch(/Wait \d+|then repeat/);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it('preserves failure details without treating failure as pending', async () => {
    globalThis.fetch = vi.fn(async () => refusal('failed', '5'));
    const { call, close } = await connect();
    try {
      const result = await call('create_computer', original);
      expect(metadata(result)).toEqual({
        code: 'template_image_preparing',
        template_transfer: token,
        preparation: { state: 'failed', error: 'Image preparation could not finish' },
        retry_after_ms: 5000,
      });
      expect(said(result)).toContain('Inspect preparation.error');
      expect(said(result)).not.toMatch(/Wait \d+|then repeat/);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it.each([undefined, null, 'unknown', ['preparing']])(
    'does not invent retry advice for state %j',
    async (state) => {
      globalThis.fetch = vi.fn(async () => refusal(state, '5'));
      const { call, close } = await connect();
      try {
        const result = await call('create_computer', original);
        expect(said(result)).toContain('do not automatically wait or retry');
        expect(said(result)).not.toMatch(/Wait \d+|then repeat/);
        expect(metadata(result).preparation).toEqual(state === undefined ? {} : { state });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      } finally {
        await close();
      }
    },
  );

  it.each([undefined, '', 'garbage', '-1', '1.5', '0x10', '1e3'])(
    'leaves missing or invalid delay %j unknown',
    async (delay) => {
      globalThis.fetch = vi.fn(async () => refusal('preparing', delay));
      const { call, close } = await connect();
      try {
        const result = await call('create_computer', original);
        expect(metadata(result)).not.toHaveProperty('retry_after_ms');
        expect(said(result)).not.toMatch(/Wait \d+|then repeat/);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      } finally {
        await close();
      }
    },
  );

  it.each([
    'Thu, 01 Jan 2026 00:00:17 GMT',
    'Thursday, 01-Jan-26 00:00:17 GMT',
    'Thu Jan  1 00:00:17 2026',
  ])('converts HTTP date %s to milliseconds in UTC', async (header) => {
    vi.stubEnv('TZ', 'America/Chicago');
    const now = Date.UTC(2026, 0, 1);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    globalThis.fetch = vi.fn(async () => refusal('copying', header));
    const error = await new Api('com_test', BASE)
      .json('POST', 'computers', { body: original })
      .catch((error) => error);
    expect(error).toBeInstanceOf(APIError);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as APIError).retryAfterMs).toBe(17000);
    const { call, close } = await connect();
    try {
      const result = await call('create_computer', original);
      expect(metadata(result).retry_after_ms).toBe(17000);
      expect(said(result)).toContain('Wait 17000 milliseconds');
    } finally {
      await close();
    }
  });

  it.each(['preparing', 'copying', 'ready', 'failed', undefined, 'unknown'])(
    'forbids blind unchanged replay for state %j even with a transient reason',
    (state) => {
      expect(
        isTransient(
          errorForStatus(409, 'unavailable', {
            code: 'template_image_preparing',
            reason: 'starting',
            preparation: { state },
          }),
        ),
      ).toBe(false);
    },
  );

  it.each([
    { template_transfer: '' },
    { template_transfer: '  \n ' },
    { template_transfer: 12 },
    { template_transfer: null },
    { template_transfer: token, template: undefined },
    { template_transfer: token, template: '' },
    { template_transfer: token, template: '  ' },
    { template_transfer: token, size: 'small' },
  ])('rejects invalid continuation arguments before any request: %j', async (invalid) => {
    globalThis.fetch = vi.fn();
    const { call, close } = await connect();
    try {
      const result = await call('create_computer', { ...original, ...invalid });
      expect(result.isError).toBe(true);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(() =>
        createBody({ ...original, ...invalid } as Parameters<typeof createBody>[0]),
      ).toThrow();
    } finally {
      await close();
    }
  });

  it('preserves the original body and opaque token on explicit continuation, then stops after success', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? refusal('preparing', '0')
        : new Response(JSON.stringify({ id: 'vm-created', name: 'desk', status: 'stopped' }), {
            headers: { 'Content-Type': 'application/json' },
          });
    });
    const { call, close } = await connect();
    try {
      const first = await call('create_computer', original);
      expect(first.isError).toBe(true);
      expect(bodies).toEqual([original]);
      const result = await call('create_computer', {
        ...original,
        template_transfer: metadata(first).template_transfer,
      });
      expect(result.isError).not.toBe(true);
      expect(said(result)).toContain('Stop retrying this create');
      expect(bodies).toEqual([original, { ...original, template_transfer: token }]);
    } finally {
      await close();
    }
  });

  it.each(['lost', 'ambiguous'])(
    'never automatically replays a continuation after a %s response',
    async (kind) => {
      globalThis.fetch = vi.fn(async () => {
        if (kind === 'lost') throw new TypeError('fetch failed', { cause: { code: 'EPIPE' } });
        return new Response('not JSON', { headers: { 'Content-Type': 'application/json' } });
      });
      const { call, close } = await connect();
      try {
        expect(
          (await call('create_computer', { ...original, template_transfer: token })).isError,
        ).toBe(true);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      } finally {
        await close();
      }
    },
  );

  it('advertises the original arguments and replay limits in the tool description', async () => {
    const { client, close } = await connect();
    try {
      const tool = (await client.listTools()).tools.find((tool) => tool.name === 'create_computer');
      expect(tool?.description).toContain('all original create arguments, including template');
      expect(tool?.description).toContain('not a create idempotency key');
      expect(tool?.description).toContain('Stop after success');
      expect(tool?.description).toContain('lost or ambiguous response');
    } finally {
      await close();
    }
  });

  it('preserves the public RateLimitError constructor', () => {
    const error = new RateLimitError('slow down', 429, { error: 'slow down' }, 30000);
    expect(error.retryAfterMs).toBe(30000);
    expect(error.status).toBe(429);
    expect(error.body).toEqual({ error: 'slow down' });
  });
});
