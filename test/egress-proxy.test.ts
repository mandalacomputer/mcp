import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { describe as describeComputer } from '../src/format.js';
import { connect } from './harness.js';

// OPL-5246: egress_proxy on create_computer and update_computer, and the
// computer's summary line naming it and egress_proxy_pending.

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

const SERVER = 'https://proxy.example.com:3128';
const CREDS = 'csec-0123456789abcdef';
const PROXY = { server: SERVER, credentials_secret_id: CREDS };
const box = (extra: Record<string, unknown> = {}) => ({
  id: 'vm-1',
  name: 'box',
  status: 'running',
  running_ram_mb: 2048,
  ...extra,
});

describe('update_computer with egress_proxy', () => {
  it('sends the setting alone, and says the connections wait for credentials', async () => {
    const res = await platform(
      () => [200, box({ egress_proxy: PROXY, egress_proxy_pending: true })],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', { egress_proxy: PROXY });
        await close();
        expect(seen).toEqual([
          { method: 'PATCH', path: '/computers/vm-1', body: { egress_proxy: PROXY } },
        ]);
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(`all outbound traffic via ${SERVER} (with credentials ${CREDS})`);
    expect(textOf(res)).toContain('its egress proxy is waiting for credentials');
  });

  it('sends null to remove it, and a null credentials id as none', async () => {
    await platform(
      () => [200, box()],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', { egress_proxy: null });
        const bare = await call('update_computer', {
          egress_proxy: { server: SERVER, credentials_secret_id: null },
        });
        await close();
        expect(r.isError).toBeFalsy();
        expect(bare.isError).toBeFalsy();
        expect(seen[0]?.body).toEqual({ egress_proxy: null });
        expect(seen[1]?.body).toEqual({ egress_proxy: { server: SERVER } });
      },
    );
  });

  it.each([
    [{ name: 'renamed' }],
    [{ cpu: 2 }],
    [{ idle_suspend_min: 30 }],
    [{ idle_suspend_min: null }],
    [{ browser_proxy: null }],
  ])('refuses it beside %j before any request', async (other) => {
    for (const egress_proxy of [PROXY, null]) {
      await platform(
        () => [200, box()],
        async (seen) => {
          const { call, close } = await connect();
          const r = await call('update_computer', { ...other, egress_proxy });
          await close();
          expect(r.isError).toBe(true);
          expect(textOf(r)).toContain('egress_proxy must be sent on its own');
          expect(seen).toEqual([]);
        },
      );
    }
  });

  it.each([
    [{ server: '  ' }],
    [{ server: SERVER, bypass: ['<local>'] }],
    [{ server: SERVER, credentials: CREDS }],
    [SERVER],
    [{ server: SERVER, credentials_secret_id: 'csec-0123' }],
    [{ server: SERVER, credentials_secret_id: 7 }],
  ])('refuses %j before any request', async (value) => {
    await platform(
      () => [200, box()],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', { egress_proxy: value });
        await close();
        expect(r.isError).toBe(true);
        // Refused for this field, not for an empty change that dropped it.
        expect(textOf(r)).toContain('egress_proxy');
        expect(textOf(r)).not.toContain('Nothing to change');
        expect(seen).toEqual([]);
      },
    );
  });

  it('keeps the credentials id copied from get_computer', async () => {
    const res = await platform(
      (seen) => [200, box({ egress_proxy: seen.method === 'GET' ? PROXY : seen.body })],
      async (seen) => {
        const { call, close } = await connect();
        const got = await call('get_computer', {});
        const text = textOf(got);
        const copied = (
          JSON.parse(text.slice(text.indexOf('\n\n') + 2)) as { egress_proxy: typeof PROXY }
        ).egress_proxy;
        expect(copied).toEqual(PROXY);
        const r = await call('update_computer', {
          egress_proxy: { ...copied, server: 'https://proxy.example.com:8443' },
        });
        await close();
        expect(seen[1]?.body).toEqual({
          egress_proxy: { server: 'https://proxy.example.com:8443', credentials_secret_id: CREDS },
        });
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
  });

  it("passes the platform's refusal of a value through as it is", async () => {
    const sentence = 'egress_proxy.server: a port is required';
    const res = await platform(
      () => [400, { error: sentence }],
      async () => {
        const { call, close } = await connect();
        const r = await call('update_computer', {
          egress_proxy: { server: 'https://proxy.example.com' },
        });
        await close();
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(sentence);
  });

  it('tells a model what the setting does and that the secret is not bound', async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    await close();
    for (const name of ['update_computer', 'create_computer']) {
      const tool = tools.find((t) => t.name === name);
      const text = JSON.stringify(
        (tool!.inputSchema.properties as Record<string, unknown>).egress_proxy,
      );
      expect(text, name).toContain('FAILS CLOSED');
      expect(text, name).toContain('DNS lookups are NOT proxied');
      expect(text, name).toContain('It is NOT bound to the computer');
    }
  });
});

describe('create_computer with egress_proxy', () => {
  it('sends it on the create, exactly', async () => {
    await platform(
      () => [201, box({ egress_proxy: PROXY })],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('create_computer', { template: 'base', egress_proxy: PROXY });
        const bare = await call('create_computer', {
          template: 'base',
          egress_proxy: { server: 'socks5://p.example:1080', credentials_secret_id: null },
        });
        await close();
        expect(r.isError).toBeFalsy();
        expect(bare.isError).toBeFalsy();
        expect(seen[0]).toMatchObject({ method: 'POST', path: '/computers' });
        expect(seen[0]?.body).toEqual({ template: 'base', egress_proxy: PROXY, start: true });
        expect(seen[1]?.body).toEqual({
          template: 'base',
          egress_proxy: { server: 'socks5://p.example:1080' },
          start: true,
        });
      },
    );
  });

  it('refuses a bypass list before any request', async () => {
    await platform(
      () => [201, box()],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('create_computer', {
          template: 'base',
          egress_proxy: { server: SERVER, bypass: ['a.com'] },
        });
        await close();
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('egress_proxy');
        expect(seen).toEqual([]);
      },
    );
  });
});

describe('the summary line', () => {
  it('names the egress proxy and its pending credentials, and says nothing when absent', () => {
    expect(describeComputer(box({ egress_proxy: { server: SERVER } }) as never)).toContain(
      `all outbound traffic via ${SERVER}`,
    );
    const pending = describeComputer(
      box({ egress_proxy: PROXY, egress_proxy_pending: true }) as never,
    );
    expect(pending).toContain(`(with credentials ${CREDS})`);
    expect(pending).toContain(
      'its egress proxy is waiting for credentials; connections are closed until they arrive',
    );
    const none = describeComputer(box() as never);
    expect(none).not.toContain('outbound');
    expect(none).not.toContain('egress');
  });
});

// OPL-5323: every connection is closed while egress_proxy_pending, so a guest
// that answers is not yet a guest that can reach out.
describe('wait_for_computer on a computer whose egress proxy waits for credentials', () => {
  it('waits, with "guest", until the credentials have arrived', async () => {
    let gets = 0;
    const res = await platform(
      (seen) => {
        if (seen.path.endsWith('/exec'))
          return [200, { exit_code: 0, stdout_b64: '', stderr_b64: '' }];
        gets++;
        return [
          200,
          box({ egress_proxy: PROXY, ...(gets === 1 ? { egress_proxy_pending: true } : {}) }),
        ];
      },
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        // No guest probe while the credentials were still on their way.
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

  it('says so in its description, and create_computer says connections are closed meanwhile', async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    await close();
    const wait = tools.find((t) => t.name === 'wait_for_computer');
    expect(wait?.description).toContain('egress proxy is waiting for its credentials');
    const properties = (tools.find((t) => t.name === 'create_computer')?.inputSchema.properties ??
      {}) as Record<string, unknown>;
    const create = JSON.stringify(properties.egress_proxy);
    expect(create).toContain('connections are closed, not sent directly');
    expect(create).toContain('never answered from the warm pool');
    expect(create).not.toContain('always a cold boot');
  });
});
