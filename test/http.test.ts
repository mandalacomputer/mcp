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

  it('rejects a session id it never issued', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      { Authorization: 'Bearer com_alice', 'mcp-session-id': 'not-a-session' },
    );
    expect(res.status).toBe(404);
  });
});
