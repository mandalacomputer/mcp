import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { describe as describeComputer } from '../src/format.js';
import { connect } from './harness.js';

// OPL-5144: browser_proxy on create_computer and update_computer, and
// wait_for_computer "guest" waiting until the computer's browsers have it.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

type Seen = { method: string; path: string; body?: unknown };

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

const SERVER = 'http://proxy.example.com:3128';
const PROXY = { server: SERVER, bypass: ['<local>'] };
const box = (extra: Record<string, unknown> = {}) => ({
  id: 'vm-1',
  name: 'box',
  status: 'running',
  running_ram_mb: 2048,
  ...extra,
});
const GUEST = { exit_code: 0, stdout_b64: '', stderr_b64: '' };

describe('update_computer with browser_proxy', () => {
  it('sends the setting alone, and says it is being applied', async () => {
    const res = await platform(
      () => [200, box({ browser_proxy: PROXY, browser_proxy_pending: true })],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', { browser_proxy: PROXY });
        await close();
        expect(seen).toEqual([
          { method: 'PATCH', path: '/computers/vm-1', body: { browser_proxy: PROXY } },
        ]);
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(`browsers via ${SERVER}`);
    expect(textOf(res)).toContain('its browser proxy is still being applied');
  });

  it('sends null to remove it', async () => {
    await platform(
      () => [200, box()],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', { browser_proxy: null });
        await close();
        expect(r.isError).toBeFalsy();
        expect(seen[0]?.body).toEqual({ browser_proxy: null });
      },
    );
  });

  it("passes the platform's refusal of a value through as it is", async () => {
    // The rules on a proxy URL are the platform's, and they grow; the tool
    // sends what it was given and hands the sentence back.
    const sentence = 'browser_proxy.server: https:// is not supported yet';
    const res = await platform(
      () => [400, { error: sentence }],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', {
          browser_proxy: { server: 'https://proxy.example.com:443' },
        });
        await close();
        expect(seen[0]?.body).toEqual({
          browser_proxy: { server: 'https://proxy.example.com:443' },
        });
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(sentence);
  });

  it.each([
    [{ server: '  ' }],
    [{ server: SERVER, bypass: [''] }],
    [{ server: SERVER, bypas: ['a.com'] }],
    [SERVER],
  ])('refuses %j before any request', async (value) => {
    await platform(
      () => [200, box()],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', { browser_proxy: value });
        await close();
        expect(r.isError).toBe(true);
        expect(seen).toEqual([]);
      },
    );
  });
});

describe('create_computer with browser_proxy', () => {
  it('sends it on the create', async () => {
    await platform(
      () => [201, box({ browser_proxy: PROXY, browser_proxy_pending: true })],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('create_computer', { template: 'base', browser_proxy: PROXY });
        await close();
        expect(r.isError).toBeFalsy();
        expect(seen[0]).toMatchObject({
          method: 'POST',
          path: '/computers',
          body: { template: 'base', browser_proxy: PROXY, start: true },
        });
      },
    );
  });
});

describe('wait_for_computer on a computer whose browser proxy is being applied', () => {
  it('waits, with "guest", until its browsers have it', async () => {
    let gets = 0;
    const res = await platform(
      (seen) => {
        if (seen.path.endsWith('/exec')) return [200, GUEST];
        gets++;
        return [
          200,
          box({ browser_proxy: PROXY, ...(gets === 1 ? { browser_proxy_pending: true } : {}) }),
        ];
      },
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        // No guest probe while the proxy was still being applied.
        expect(seen.map((c) => [c.method, c.path])).toEqual([
          ['GET', '/computers/vm-1'],
          ['GET', '/computers/vm-1'],
          ['POST', '/computers/vm-1/exec'],
        ]);
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Guest is answering');
  });

  it('does not wait for it with "running"', async () => {
    await platform(
      () => [200, box({ browser_proxy: PROXY, browser_proxy_pending: true })],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'running', timeout_s: 30 });
        await close();
        expect(r.isError).toBeFalsy();
        expect(seen).toHaveLength(1);
      },
    );
  });
});

describe('describe', () => {
  it('names the proxy by its server, and says nothing when there is none', () => {
    expect(describeComputer(box({ browser_proxy: PROXY }))).toBe(
      `box · vm-1 · running · browsers via ${SERVER}`,
    );
    expect(describeComputer(box())).toBe('box · vm-1 · running');
  });
});
