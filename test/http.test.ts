import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHttp } from '../src/http.js';
import { BASE, installFakePlatform } from './harness.js';

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

describe('the hosted transport', () => {
  let server: Server;
  let url: string;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    server = await runHttp({ port: 0, host: '127.0.0.1', baseUrl: BASE });
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  it('answers a health check without a key', async () => {
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('refuses to initialize without one', async () => {
    const res = await post(INIT);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { jsonrpc: string; error: { message: string } };
    // JSON-RPC shaped, because the thing on the other end is an MCP client and
    // has no way to report an HTML error page to its user.
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.message).toContain('Bearer');
  });

  it('refuses a non-initialize request that carries no session', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(400);
  });

  it('gives each caller a session of their own', async () => {
    const res = await post(INIT, { Authorization: 'Bearer com_alice' });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it("will not let a second key drive the first one's session", async () => {
    const opened = await post(INIT, { Authorization: 'Bearer com_alice' });
    const sessionId = opened.headers.get('mcp-session-id') as string;
    await opened.text();

    // A session id travels in a plain header and ends up in proxy logs. On its
    // own it must not be enough to act as somebody else.
    const stolen = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { Authorization: 'Bearer com_mallory', 'mcp-session-id': sessionId },
    );
    expect(stolen.status).toBe(401);

    const mine = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { Authorization: 'Bearer com_alice', 'mcp-session-id': sessionId },
    );
    expect(mine.status).toBe(200);
  });

  it('takes the auth scheme in any case, as RFC 7235 requires', async () => {
    // Matching only 'Bearer ' answered a well-formed credential with a 401
    // whose message told the client to send the thing it had just sent.
    const res = await post(INIT, { Authorization: 'bearer com_alice' });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('rejects a session id it never issued', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      { Authorization: 'Bearer com_alice', 'mcp-session-id': 'not-a-session' },
    );
    expect(res.status).toBe(404);
  });
});

describe('the session cap', () => {
  let server: Server;
  let url: string;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    server = await runHttp({ port: 0, host: '127.0.0.1', baseUrl: BASE, maxSessions: 2 });
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('holds under a burst of simultaneous initializes', async () => {
    // The cap is checked two awaits before the session is recorded, so what it
    // bounds depends on nothing yielding in between. That holds today — this
    // burst is admitted exactly twice with or without the reservation the code
    // now takes — and it holds for a reason no one here controls: it is a
    // property of the SDK's initialize path, not of this file. The reservation
    // is what makes the cap survive that changing; this test is what would
    // notice if it stopped being enough.
    const burst = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        fetch(`${url}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer com_caller_${i}`,
          },
          body: JSON.stringify(INIT),
        }),
      ),
    );
    await Promise.all(burst.map((r) => r.text()));
    expect(burst.filter((r) => r.status === 200)).toHaveLength(2);
    expect(burst.filter((r) => r.status === 503)).toHaveLength(14);
  });
});

describe('a session whose client walked away', () => {
  let server: Server;
  let url: string;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    // Short enough that the sweep is observable; the sweep period follows the
    // TTL down to a floor of a second.
    server = await runHttp({
      port: 0,
      host: '127.0.0.1',
      baseUrl: BASE,
      sessionTtlMs: 50,
    });
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('is swept even while its notification stream is still open', async () => {
    // The standing GET /mcp stream is what a conforming client opens once and
    // holds for the whole session. Counting it as work in flight meant
    // `active` never fell to zero, so no such session was ever swept — and the
    // case the sweeper exists for, a laptop that slept and left the socket
    // half-open, is exactly the one where the stream's `close` never fires.
    // The transport and its registered server sat on a maxSessions slot for
    // the life of the process.
    const opened = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer com_alice',
      },
      body: JSON.stringify(INIT),
    });
    const sessionId = opened.headers.get('mcp-session-id') as string;
    await opened.text();
    expect(sessionId).toBeTruthy();

    const abort = new AbortController();
    const stream = await fetch(`${url}/mcp`, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer com_alice',
        'mcp-session-id': sessionId,
      },
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);

    try {
      await new Promise((r) => setTimeout(r, 1500));
      const health = (await (await fetch(`${url}/healthz`)).json()) as { sessions: number };
      expect(health.sessions).toBe(0);
    } finally {
      abort.abort();
      await stream.body?.cancel().catch(() => {});
    }
  });
});
