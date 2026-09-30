import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { connect } from './harness.js';

// OPL-5459: the guest agent answers a few seconds before the desktop user is
// logged in, and a desktop exec sent in between is refused with a 409 that
// carries no `reason`. wait_for_computer until "guest" waits that out on Linux.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

type Seen = { method: string; path: string; body?: Record<string, unknown> };

/** A platform answering from `respond`, recording every request, for the length of `fn`. */
async function platform<T>(
  respond: (seen: Seen, n: number) => [number, unknown],
  fn: (seen: Seen[]) => Promise<T>,
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
    const [status, body] = respond(call, seen.length);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = restore;
  }
}

const OK = { exit_code: 0, stdout_b64: '', stderr_b64: '' };
const NO_DESKTOP = {
  error: 'no active desktop session in the guest (it may still be booting, or nobody is logged in)',
};
const box = (extra: Record<string, unknown> = {}) => ({
  id: 'vm-1',
  name: 'box',
  status: 'running',
  running_ram_mb: 2048,
  os: 'linux',
  ...extra,
});
const isDesktopProbe = (s: Seen) => s.path.endsWith('/exec') && s.body?.session === 'desktop';

describe('wait_for_computer until "guest" waits for the desktop session', () => {
  // The platform leaves `desktop` out for X11, which is what most Linux
  // templates run: the absence is the case this wait matters most for.
  it.each([
    ['an X11 desktop (field absent)', {}],
    ['a Wayland desktop', { desktop: 'wayland' }],
  ])(
    'waits through no-desktop refusals on %s',
    async (_label, extra) => {
      let probes = 0;
      const res = await platform(
        (seen) => {
          if (isDesktopProbe(seen)) {
            probes++;
            return probes <= 1 ? [409, NO_DESKTOP] : [200, OK];
          }
          if (seen.path.endsWith('/exec')) return [200, OK];
          return [200, box(extra)];
        },
        async (seen) => {
          const { call, close } = await connect();
          const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
          await close();
          const desktop = seen.filter(isDesktopProbe);
          expect(desktop).toHaveLength(2);
          expect(desktop[0]!.body).toEqual({ command: 'true', timeout_s: 5, session: 'desktop' });
          // The desktop probe that answered is the last thing the wait asked.
          expect(isDesktopProbe(seen[seen.length - 1]!)).toBe(true);
          return r;
        },
      );
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain('Guest is answering');
    },
    30_000,
  );

  it.each([
    ['an explicitly empty desktop', { desktop: '' }],
    ['a computer whose os was not reported', { os: undefined }],
    ['a Windows guest', { os: 'windows' }],
  ])('asks nothing of %s', async (_label, extra) => {
    const res = await platform(
      (seen) => (seen.path.endsWith('/exec') ? [200, OK] : [200, box(extra)]),
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        expect(seen.filter(isDesktopProbe)).toHaveLength(0);
        expect(seen.map((s) => [s.method, s.path])).toEqual([
          ['GET', '/computers/vm-1'],
          ['POST', '/computers/vm-1/exec'],
        ]);
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Guest is answering');
  });

  it('does not probe the desktop when told to wait only for "running"', async () => {
    await platform(
      () => [200, box()],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'running', timeout_s: 30 });
        await close();
        expect(r.isError).toBeFalsy();
        expect(seen.some((s) => s.path.endsWith('/exec'))).toBe(false);
      },
    );
  });

  it('throws a refusal of the request itself from the desktop probe', async () => {
    const res = await platform(
      (seen) => {
        if (isDesktopProbe(seen)) return [403, { error: 'forbidden' }];
        if (seen.path.endsWith('/exec')) return [200, OK];
        return [200, box()];
      },
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        expect(seen.filter(isDesktopProbe)).toHaveLength(1);
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toMatch(/Guest is answering/);
    expect(textOf(res)).not.toMatch(/Gave up/);
  });

  it('gives up naming the desktop session when its refusals never stop', async () => {
    const res = await platform(
      (seen) => {
        if (isDesktopProbe(seen)) return [409, NO_DESKTOP];
        if (seen.path.endsWith('/exec')) return [200, OK];
        return [200, box()];
      },
      async () => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 5 });
        await close();
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Gave up after 5s/);
    expect(textOf(res)).toMatch(/desktop session is not active yet/);
    expect(textOf(res)).toMatch(/call again to keep waiting/);
  }, 30_000);

  // A probe whose in-guest session lookup outlived its five seconds answers 200
  // with `timed_out` set: no evidence of a session, and neither is a non-zero
  // exit. Both are polled through rather than read as a ready desktop.
  const UNFINISHED = { exit_code: -1, timed_out: true, stdout_b64: '', stderr_b64: '' };
  const FAILED = { exit_code: 1, stdout_b64: '', stderr_b64: '' };

  it.each([
    ['timed out in the guest', UNFINISHED],
    ['exited non-zero', FAILED],
  ])(
    'polls through a desktop probe that %s',
    async (_label, first) => {
      let probes = 0;
      const res = await platform(
        (seen) => {
          if (isDesktopProbe(seen)) {
            probes++;
            return probes <= 1 ? [200, first] : [200, OK];
          }
          if (seen.path.endsWith('/exec')) return [200, OK];
          return [200, box()];
        },
        async (seen) => {
          const { call, close } = await connect();
          const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
          await close();
          expect(seen.filter(isDesktopProbe)).toHaveLength(2);
          return r;
        },
      );
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain('Guest is answering');
    },
    30_000,
  );

  it('gives up naming the desktop session when every probe times out', async () => {
    const res = await platform(
      (seen) => {
        if (isDesktopProbe(seen)) return [200, UNFINISHED];
        if (seen.path.endsWith('/exec')) return [200, OK];
        return [200, box()];
      },
      async () => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 5 });
        await close();
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toMatch(/Guest is answering/);
    expect(textOf(res)).toMatch(/Gave up after 5s/);
    expect(textOf(res)).toMatch(/desktop session is not active yet/);
  }, 30_000);

  it('says so in its description', async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    await close();
    const wait = tools.find((t) => t.name === 'wait_for_computer');
    expect(wait?.description).toContain('desktop session is logged in');
  });
});
