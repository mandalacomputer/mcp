import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, SECRET } from './harness.js';

// OPL-5536: wait_for_computer's "not yet" turns on a running computer used to
// sleep a flat POLL_MS each, so a secret that landed just after a read was
// noticed up to two seconds late. They ramp now: 250ms, doubling, up to
// POLL_MS. Failed polls keep pollDelay, Retry-After included.

// Every sleep the wait asks for, answered at once so the test measures the
// requested durations rather than spending them.
const sleeps: number[] = [];
vi.mock('../src/poll.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/poll.js')>();
  return {
    ...real,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
});

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

type Seen = { method: string; path: string; body?: Record<string, unknown> };

/** A platform answering from `respond`, recording every request, for the length of `fn`. */
async function platform<T>(
  respond: (seen: Seen, n: number) => [number, unknown, Record<string, string>?],
  fn: () => Promise<T>,
): Promise<T> {
  const restore = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const call: Seen = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname.replace(/^\/api\/v1/, ''),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(call);
    const [status, body, headers] = respond(call, seen.length);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = restore;
  }
}

const wait = async () => {
  const { call, close } = await connect();
  const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
  await close();
  return r;
};

const OK = { exit_code: 0, stdout_b64: '', stderr_b64: '' };
const BINDING = { secret_id: SECRET.id, revision_id: SECRET.revision_id, env: 'TOKEN' };
const box = (extra: Record<string, unknown> = {}) => ({
  id: 'vm-1',
  name: 'box',
  status: 'running',
  running_ram_mb: 2048,
  ...extra,
});
const isDesktopProbe = (s: Seen) => s.path.endsWith('/exec') && s.body?.session === 'desktop';

beforeEach(() => {
  sleeps.length = 0;
});

describe('wait_for_computer polls fast first', () => {
  it('ramps 250, 500, 1000, 2000, 2000 while the secrets are on their way', async () => {
    let gets = 0;
    const res = await platform((seen) => {
      if (seen.path.endsWith('/exec')) return [200, OK];
      gets++;
      return [
        200,
        box({ secrets: [BINDING], secrets_generation: 1, secrets_delivering: gets <= 5 }),
      ];
    }, wait);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Guest is answering');
    expect(sleeps).toEqual([250, 500, 1_000, 2_000, 2_000]);
  });

  it('ramps through a pending browser proxy and then a pending egress proxy', async () => {
    let gets = 0;
    const res = await platform((seen) => {
      if (seen.path.endsWith('/exec')) return [200, OK];
      gets++;
      return [
        200,
        box({ browser_proxy_pending: gets <= 2, egress_proxy_pending: gets > 2 && gets <= 4 }),
      ];
    }, wait);
    expect(res.isError).toBeFalsy();
    // One ramp across the whole wait, not one per stage.
    expect(sleeps).toEqual([250, 500, 1_000, 2_000]);
  });

  it('ramps through a desktop that is not logged in yet, by 409 or by an unfinished probe', async () => {
    let probes = 0;
    const res = await platform((seen) => {
      if (isDesktopProbe(seen)) {
        probes++;
        if (probes === 1) return [409, { error: 'no active desktop session in the guest' }];
        if (probes === 2) return [200, { ...OK, exit_code: -1, timed_out: true }];
        return [200, OK];
      }
      if (seen.path.endsWith('/exec')) return [200, OK];
      return [200, box({ os: 'linux' })];
    }, wait);
    expect(res.isError).toBeFalsy();
    expect(sleeps).toEqual([250, 500]);
  });

  it('a rate-limited desktop probe still waits its Retry-After, and the ramp carries on', async () => {
    let probes = 0;
    const res = await platform((seen) => {
      if (isDesktopProbe(seen)) {
        probes++;
        if (probes === 1) return [200, { ...OK, exit_code: -1, timed_out: true }];
        if (probes === 2) return [429, { error: 'rate limited' }, { 'Retry-After': '5' }];
        if (probes === 3) return [200, { ...OK, exit_code: -1, timed_out: true }];
        return [200, OK];
      }
      if (seen.path.endsWith('/exec')) return [200, OK];
      return [200, box({ os: 'linux' })];
    }, wait);
    expect(res.isError).toBeFalsy();
    expect(sleeps).toEqual([250, 5_000, 500]);
  });

  it('keeps the flat interval for a status read that failed', async () => {
    let gets = 0;
    const res = await platform((seen) => {
      if (seen.path.endsWith('/exec')) return [200, OK];
      gets++;
      if (gets === 1) return [503, { error: 'host unreachable' }];
      return [
        200,
        box({ secrets: [BINDING], secrets_generation: 1, secrets_delivering: gets === 2 }),
      ];
    }, wait);
    expect(res.isError).toBeFalsy();
    expect(sleeps).toEqual([2_000, 250]);
  });
});
