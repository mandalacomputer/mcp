import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';
import { type APIError, errorForStatus } from '../src/errors.js';
import { EventHub } from '../src/events.js';
import { errorMetadata, failed } from '../src/format.js';
import { BASE, connect, fakeEvents, installFakePlatform } from './harness.js';

const textOf = (result: unknown): string => JSON.stringify(result);

const COMPUTER = { id: 'vm-1', name: 'one', status: 'running', os: 'linux' };

describe('a running computer that comes with no desktop credentials', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  let inner: typeof globalThis.fetch;
  let whoami: () => Response;
  let reads = 0;

  beforeEach(() => {
    platform = installFakePlatform();
    inner = globalThis.fetch;
    reads = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.href === `${BASE}/computers/vm-1`) return Response.json(COMPUTER);
      if (url.href === `${BASE}/whoami`) {
        reads += 1;
        return whoami();
      }
      return inner(input as never, init);
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = inner;
    platform.restore();
  });

  const expiring = () =>
    Response.json({ key: { id: 'key-1', expires_at: '2030-01-01T00:00:00Z' } });
  const lasting = () => Response.json({ key: { id: 'key-1', expires_at: null } });

  async function server() {
    return connect({ webSocket: fakeEvents({}).factory });
  }

  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('ends the event stream with the cause for a key that expires', async () => {
    whoami = expiring;
    const { call, close } = await server();
    const said = textOf(await call('poll_events', { computer_id: 'vm-1' }));
    expect(said).toContain('this API key expires');
    expect(said).toContain('without an expiry');
    expect(said).not.toContain('reconnecting');
    await close();
  });

  it('says the same from wait_for_event', async () => {
    whoami = expiring;
    const { call, close } = await server();
    const res = await call('wait_for_event', { computer_id: 'vm-1', timeout_s: 1 });
    expect(textOf(res)).toContain('without an expiry');
    await close();
  });

  it('says the same from wait_for_file_change', async () => {
    whoami = expiring;
    const { call, close } = await server();
    const res = await call('wait_for_file_change', {
      computer_id: 'vm-1',
      path: '/tmp',
      timeout_s: 1,
    });
    expect(textOf(res)).toContain('without an expiry');
    await close();
  });

  it('keeps reconnecting, and asks once, for a key that does not expire', async () => {
    whoami = lasting;
    const hub = new EventHub(new Api('com_x', BASE), fakeEvents({}).factory);
    const sub = hub.open('vm-1');
    await until(async () => reads >= 1);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(sub.state.status).not.toBe('stopped');
    expect(reads).toBe(1);
    hub.closeAll();
  });

  it('keeps reconnecting when the key cannot be read, and asks again', async () => {
    whoami = () => new Response('{"error":"down"}', { status: 500 });
    const hub = new EventHub(new Api('com_x', BASE), fakeEvents({}).factory);
    const sub = hub.open('vm-1');
    await until(async () => reads >= 2);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(sub.state.status).not.toBe('stopped');
    hub.closeAll();
  });

  it('names the expiring key from get_desktop_url', async () => {
    whoami = expiring;
    const { call, close } = await server();
    const res = await call('get_desktop_url', { computer_id: 'vm-1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('without an expiry');
    await close();
  });

  it('leaves the other causes open from get_desktop_url otherwise', async () => {
    whoami = lasting;
    const { call, close } = await server();
    const res = await call('get_desktop_url', { computer_id: 'vm-1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('hypervisor could not be reached');
    expect(textOf(res)).not.toContain('without an expiry');
    await close();
  });
});

describe('a balance too low to start something', () => {
  const refusal = (body: Record<string, unknown>) =>
    errorForStatus(402, 'too low', {
      error: 'too low',
      code: 'INSUFFICIENT_BALANCE',
      ...body,
    }) as APIError;

  it('says how far short it is, in the sentence and the metadata', () => {
    const err = refusal({ projected_micros: 100_000, required_micros: 250_000 });
    const text = textOf(failed(err));
    expect(text).toContain('$0.10 counts toward this start and it needs $0.25');
    expect(errorMetadata(err).fields).toMatchObject({
      projected_micros: 100_000,
      required_micros: 250_000,
    });
  });

  it('keeps a balance below zero', () => {
    const err = refusal({ projected_micros: -1_500_000, required_micros: 250_000 });
    expect(textOf(failed(err))).toContain('-$1.50');
    expect(errorMetadata(err).fields.projected_micros).toBe(-1_500_000);
  });

  it('claims no figures the platform did not send', () => {
    const err = refusal({ projected_micros: 'lots' });
    expect(textOf(failed(err))).not.toContain('counts toward');
    expect(errorMetadata(err).fields).not.toHaveProperty('projected_micros');
  });

  it('reads the figures only on that code', () => {
    const err = errorForStatus(402, 'x', {
      error: 'x',
      code: 'PLAN_REQUIRED',
      projected_micros: 1,
    }) as APIError;
    expect(errorMetadata(err).fields).not.toHaveProperty('projected_micros');
  });
});

describe('publishing to a ref that is taken', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  let inner: typeof globalThis.fetch;
  beforeEach(() => {
    platform = installFakePlatform();
    inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.href === `${BASE}/templates` && init?.method === 'POST')
        return Response.json({ error: 'That ref is taken.', reason: 'exists' }, { status: 409 });
      return inner(input as never, init);
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = inner;
    platform.restore();
  });

  it('says to bump the version, and nothing about paths', async () => {
    const { call, close } = await connect();
    const res = await call('publish_template', { document: 'apiVersion: mandala/v1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('That ref is taken.');
    expect(textOf(res)).toContain('bump metadata.version');
    expect(textOf(res)).not.toMatch(/\bpath\b|overwrit/);
    await close();
  });
});
