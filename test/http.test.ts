import { Agent as HttpAgent, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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

  it('answers an unknown path with JSON rather than Express HTML', async () => {
    const res = await fetch(`${url}/not-an-endpoint`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { jsonrpc: string; error: { message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.message).toContain('Unknown path');
  });

  it('drains an ignored body so the keep-alive connection can serve the next request', async () => {
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    let connections = 0;
    const count = () => connections++;
    server.on('connection', count);

    const request = (method: string, path: string, body?: Buffer) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          `${url}${path}`,
          {
            method,
            agent,
            headers: body ? { 'Content-Length': body.length } : undefined,
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.setTimeout(5_000, () => req.destroy(new Error('keep-alive request timed out')));
        req.on('error', reject);
        req.end(body);
      });

    try {
      expect(await request('POST', '/not-an-endpoint', Buffer.alloc(1024 * 1024))).toBe(404);
      expect(await request('GET', '/healthz')).toBe(200);
      expect(connections).toBe(1);
    } finally {
      server.off('connection', count);
      agent.destroy();
    }
  });

  it('refuses to initialize without one', async () => {
    const res = await post(INIT);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { jsonrpc: string; error: { message: string }; id: unknown };
    // JSON-RPC shaped, because the thing on the other end is an MCP client and
    // has no way to report an HTML error page to its user.
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.message).toContain('Bearer');
    expect(body.id).toBe(INIT.id);
  });

  it('refuses a non-initialize request that carries no session', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { id: unknown }).id).toBe(2);
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

describe('HTTP startup configuration', () => {
  it('rejects an invalid base URL before binding a server', async () => {
    await expect(
      runHttp({ port: 0, host: '127.0.0.1', baseUrl: 'not an absolute URL' }),
    ).rejects.toThrow(/valid base URL/i);
    await expect(
      runHttp({ port: 0, host: '127.0.0.1', baseUrl: 'file:///etc/passwd' }),
    ).rejects.toThrow(/http\(s\)/i);
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

// --- round three ----------------------------------------------------------

/**
 * A POST with a Host header of our choosing.
 *
 * `fetch` silently drops an attempt to set Host, so a DNS-rebinding test
 * written with it proves nothing — it sends the real authority every time and
 * passes whether or not the check exists. node:http sends what it is given.
 */
function rawPost(
  port: number,
  host: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Host: host,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('a page that resolved its own name to this server', () => {
  let server: Server;
  let port: number;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    // No allowedHosts configured — the default install, which is the whole
    // point: protection used to be off unless an operator turned it on.
    server = await runHttp({ port: 0, host: '127.0.0.1', baseUrl: BASE });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('is turned away by the Host header it had to send', async () => {
    // DNS rebinding: the attacker's page resolves evil.example to 127.0.0.1,
    // so the browser makes it same-origin and CORS offers nothing. The Host
    // header is the only thing left that says which server was meant, and
    // nothing was checking it on a default install.
    const res = await rawPost(port, 'evil.example', { Authorization: 'Bearer com_alice' }, INIT);
    expect(res.status).toBe(403);
  });

  it('still answers the addresses it is actually reachable at', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await rawPost(port, host, { Authorization: 'Bearer com_alice' }, INIT);
      expect(res.status, `${host} was refused`).toBe(200);
    }
  });

  it('answers them in any casing, since host names are case-insensitive', async () => {
    // The SDK compares the Host header to the allowlist with a plain
    // `includes`, so `LOCALHOST:3000` missed a list holding `localhost:3000`
    // and a conformant client was answered 403 by the rebinding protection.
    // The header is folded before it gets there now.
    for (const host of [`LOCALHOST:${port}`, `LocalHost:${port}`]) {
      const res = await rawPost(port, host, { Authorization: 'Bearer com_alice' }, INIT);
      expect(res.status, `${host} was refused`).toBe(200);
    }
  });

  it('still turns away a name it was never reachable at, whatever its casing', async () => {
    const res = await rawPost(port, 'EVIL.example', { Authorization: 'Bearer com_alice' }, INIT);
    expect(res.status).toBe(403);
  });
});

describe('a Host the rebinding check refuses, when the session cap is already full', () => {
  let server: Server;
  let port: number;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    server = await runHttp({ port: 0, host: '127.0.0.1', baseUrl: BASE, maxSessions: 1 });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('is 403, not 503, because occupancy is not the answer to a name this server never served', async () => {
    // The Host check used to run inside handleRequest, after the reservation.
    // A full table then answered a DNS-rebinding initialize with 503, and a
    // table that still had room paid for a whole McpServer to say 403.
    const ok = await rawPost(
      port,
      `127.0.0.1:${port}`,
      { Authorization: 'Bearer com_alice' },
      INIT,
    );
    expect(ok.status).toBe(200);
    const evil = await rawPost(port, 'evil.example', { Authorization: 'Bearer com_mallory' }, INIT);
    expect(evil.status).toBe(403);
    const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as {
      sessions: number;
    };
    expect(health.sessions).toBe(1);
  });
});

describe('an Origin allowlist', () => {
  let server: Server;
  let port: number;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    server = await runHttp({
      port: 0,
      host: '127.0.0.1',
      baseUrl: BASE,
      allowedOrigins: ['HTTPS://Client.Example'],
    });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('matches configured and incoming origins without case sensitivity', async () => {
    for (const origin of ['https://client.example', 'HTTPS://CLIENT.EXAMPLE']) {
      const res = await rawPost(
        port,
        `localhost:${port}`,
        { Authorization: 'Bearer com_alice', Origin: origin },
        INIT,
      );
      expect(res.status, `${origin} was refused`).toBe(200);
    }
  });

  it('turns away an Origin that is not on the list', async () => {
    const res = await rawPost(
      port,
      `localhost:${port}`,
      { Authorization: 'Bearer com_alice', Origin: 'https://evil.example' },
      INIT,
    );
    expect(res.status).toBe(403);
  });
});

describe('a body from a caller who sent no key', () => {
  let server: Server;
  let url: string;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    server = await runHttp({ port: 0, host: '127.0.0.1', baseUrl: BASE });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    });

  it('is not buffered to the limit an authenticated one gets', async () => {
    // `express.json` parses before any route runs, so mounted globally at 80mb
    // it spent that on a request carrying no credential — free to send, and
    // nothing about it needed a key.
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', pad: 'x'.repeat(400_000) });
    expect((await post(big)).status).toBe(413);
  });

  it('still reaches the routes that answer without one', async () => {
    // The statuses a bearer-less caller used to get are unchanged: the body is
    // still parsed, just not at the large limit.
    expect(
      (await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).status,
    ).toBe(400);
    expect((await post(JSON.stringify(INIT))).status).toBe(401);
  });

  it('is not let through by a bearer this server never checked', async () => {
    // The header is not the credential. A `com_…` key cannot be verified
    // without a round trip to the platform, so `Bearer x` says nothing — and
    // gating the large buffer on the presence of one would have handed it to
    // anybody willing to type eight characters.
    const big = JSON.stringify({ ...INIT, pad: 'x'.repeat(400_000) });
    expect((await post(big, { Authorization: 'Bearer x' })).status).toBe(413);
  });

  it('is let through on a session whose key this server has matched', async () => {
    // Not 413 is the whole claim: the same payload refused unread above is
    // parsed here, which is what keeps write_file working — it always arrives
    // on an established session. What it parses to is a 400, because a padded
    // tools/list is still a tools/list; that it got as far as being judged on
    // its content is the point.
    const opened = await post(JSON.stringify(INIT), { Authorization: 'Bearer com_alice' });
    const sessionId = opened.headers.get('mcp-session-id') as string;
    await opened.text();
    expect(sessionId).toBeTruthy();

    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/list',
      pad: 'x'.repeat(400_000),
    });
    const res = await post(big, {
      Authorization: 'Bearer com_alice',
      'mcp-session-id': sessionId,
    });
    expect(res.status).not.toBe(413);

    // And not to the holder of the id alone, who is refused at the same size
    // the session's own key is served at.
    const stolen = await post(big, {
      Authorization: 'Bearer com_mallory',
      'mcp-session-id': sessionId,
    });
    expect(stolen.status).toBe(413);
  });

  it('is refused in the shape an MCP client can read', async () => {
    // Past the limit express.json throws before any route runs, and nothing
    // was catching it: Express's own handler renders the message and, outside
    // NODE_ENV=production, the whole stack — absolute paths included — into
    // the body. An MCP client has no way to report an HTML page to its user,
    // and this one is reachable by anyone who can open a socket.
    const res = await post(JSON.stringify({ pad: 'x'.repeat(400_000) }));
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { jsonrpc: string; error: { message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.message).toContain('too large');
    expect(body.error.message).toContain('256KB');
    expect(body.error.message).toContain('initialize first');
    expect(JSON.stringify(body)).not.toContain('node_modules');
  });

  it('says so in the same shape when the body is not JSON at all', async () => {
    const res = await post('{ not json');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { jsonrpc: string; error: unknown };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('node_modules');
  });
});

describe('concurrent large request bodies', () => {
  let server: Server;
  let url: string;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    server = await runHttp({
      port: 0,
      host: '127.0.0.1',
      baseUrl: BASE,
      maxLargeBodyParses: 1,
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('caps parses even when arbitrary bearers initialized the sessions', async () => {
    const opened = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-platform-key',
      },
      body: JSON.stringify(INIT),
    });
    const sessionId = opened.headers.get('mcp-session-id') as string;
    await opened.text();
    expect(sessionId).toBeTruthy();

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/list',
      pad: 'x'.repeat(400_000),
    });
    const target = new URL(url);
    const first = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-platform-key',
        'mcp-session-id': sessionId,
        'Content-Length': Buffer.byteLength(body),
      },
    });
    const firstDone = new Promise<number>((resolve, reject) => {
      first.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      first.on('error', reject);
    });
    first.write(body.slice(0, 100));

    for (let tries = 0; tries < 100; tries++) {
      const health = (await (await fetch(`${url}/healthz`)).json()) as {
        largeBodyParses: number;
      };
      if (health.largeBodyParses === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const second = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-platform-key',
        'mcp-session-id': sessionId,
        'Content-Length': Buffer.byteLength(body),
      },
    });
    let secondResponded = false;
    const secondDone = new Promise<{ status: number; body: string }>((resolve, reject) => {
      second.on('response', (res) => {
        secondResponded = true;
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      });
      second.on('error', reject);
    });
    second.write(body.slice(0, 100));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondResponded).toBe(false);
    second.end(body.slice(100));
    const rejected = await secondDone;
    expect(rejected.status).toBe(503);
    expect((JSON.parse(rejected.body) as { error: { message: string } }).error.message).toMatch(
      /maximum.*large request bodies/i,
    );

    first.end(body.slice(100));
    await firstDone;
  });

  it('holds the cap while a parsed large body remains retained by its handler', async () => {
    const opened = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-platform-key',
      },
      body: JSON.stringify(INIT),
    });
    const sessionId = opened.headers.get('mcp-session-id') as string;
    await opened.text();

    const fake = globalThis.fetch;
    let release!: () => void;
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handlerReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === 'string' ? input : input.toString());
      if (target.host === new URL(BASE).host && target.pathname.endsWith('/screenshot')) {
        started();
        return handlerReleased.then(
          () =>
            new Response(new Uint8Array([1]), {
              headers: { 'Content-Type': 'image/png' },
            }),
        );
      }
      return fake(input as never, init);
    }) as typeof fetch;

    try {
      const largeCall = JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'screenshot',
          arguments: { computer_id: 'vm-1', pad: 'x'.repeat(400_000) },
        },
      });
      const first = fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer not-a-platform-key',
          'mcp-session-id': sessionId,
        },
        body: largeCall,
      });
      await handlerStarted;
      const accepted = await first;
      expect(accepted.status).toBe(200);
      // Closing the response lets transport.handleRequest settle before the
      // tool callback. The parsed body's lease must transfer to that callback.
      await accepted.body?.cancel();

      const health = (await (await fetch(`${url}/healthz`)).json()) as {
        largeBodyParses: number;
      };
      expect(health.largeBodyParses).toBe(1);

      const second = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer not-a-platform-key',
          'mcp-session-id': sessionId,
        },
        body: largeCall,
      });
      expect(second.status).toBe(503);
      await second.text();

      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const after = (await (await fetch(`${url}/healthz`)).json()) as {
        largeBodyParses: number;
      };
      expect(after.largeBodyParses).toBe(0);
    } finally {
      release();
      globalThis.fetch = fake;
    }
  }, 10_000);
});

describe('an initialize still in flight', () => {
  it('cannot be swept during the gap after its session becomes visible', async () => {
    const original = StreamableHTTPServerTransport.prototype.handleRequest;
    let release!: () => void;
    let initialized!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const visible = new Promise<void>((resolve) => {
      initialized = resolve;
    });
    StreamableHTTPServerTransport.prototype.handleRequest = async function (...args) {
      const result = await original.apply(this, args);
      if (!this.sessionId) return result;
      initialized();
      await hold;
      return result;
    };

    const platform = installFakePlatform();
    let server: Server | undefined;
    try {
      server = await runHttp({
        port: 0,
        host: '127.0.0.1',
        baseUrl: BASE,
        sessionTtlMs: 50,
      });
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const opened = fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer com_alice',
        },
        body: JSON.stringify(INIT),
      });
      await visible;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const during = (await (await fetch(`${url}/healthz`)).json()) as { sessions: number };
      expect(during.sessions).toBe(1);

      release();
      const response = await opened;
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const after = (await (await fetch(`${url}/healthz`)).json()) as { sessions: number };
      expect(after.sessions).toBe(0);
    } finally {
      release();
      StreamableHTTPServerTransport.prototype.handleRequest = original;
      platform.restore();
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  }, 10_000);
});

describe('an abandoned request whose tool is still running', () => {
  let server: Server;
  let url: string;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    server = await runHttp({
      port: 0,
      host: '127.0.0.1',
      baseUrl: BASE,
      sessionTtlMs: 50,
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('does not sweep the session while a tool outlives its closed response', async () => {
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

    const fake = globalThis.fetch;
    let release!: () => void;
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handlerReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === 'string' ? input : input.toString());
      if (target.host === new URL(BASE).host && target.pathname.endsWith('/screenshot')) {
        started();
        return handlerReleased.then(
          () =>
            new Response(new Uint8Array([1]), {
              headers: { 'Content-Type': 'image/png' },
            }),
        );
      }
      return fake(input as never, init);
    }) as typeof fetch;

    try {
      const abandoned = fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer com_alice',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: { name: 'screenshot', arguments: { computer_id: 'vm-1' } },
        }),
      });
      await handlerStarted;
      // The MCP transport starts an SSE response before the tool result is
      // ready. Cancel only that response body after the request was accepted;
      // unlike aborting fetch itself, this does not cancel the incoming tool
      // call and exactly models a client closing its response socket.
      const response = await abandoned;
      await response.body?.cancel();

      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const during = (await (await fetch(`${url}/healthz`)).json()) as { sessions: number };
      expect(during.sessions).toBe(1);

      release();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const after = (await (await fetch(`${url}/healthz`)).json()) as { sessions: number };
      expect(after.sessions).toBe(0);
    } finally {
      release();
      globalThis.fetch = fake;
    }
  }, 10_000);
});

describe("the operator's own computer", () => {
  let server: Server;
  let url: string;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    // What MANDALA_COMPUTER_ID does on a hosted install.
    server = await runHttp({
      port: 0,
      host: '127.0.0.1',
      baseUrl: BASE,
      computerId: 'vm-operator',
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("is not bound into a stranger's session", async () => {
    // `{...cfg}` carried computerId into every caller's Session, so a stranger's
    // key arrived pre-bound to a machine on somebody else's account: every call
    // until they ran use_computer 404'd, and the id of a computer that was not
    // theirs was named back to them by way of explanation. modelKey was
    // overridden one line above for exactly this reason.
    const opened = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer com_stranger',
      },
      body: JSON.stringify(INIT),
    });
    const sessionId = opened.headers.get('mcp-session-id') as string;
    await opened.text();
    expect(sessionId).toBeTruthy();

    const called = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer com_stranger',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'screenshot', arguments: {} },
      }),
    });
    const text = await called.text();
    expect(text).toMatch(/No computer selected/);
    expect(text).not.toMatch(/vm-operator/);
  });
});

// --- grok bug hunt, OPL-4218 ---------------------------------------------

describe('an operator allowlist written the way operators write it', () => {
  let server: Server;
  let port: number;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    // A bare name, which is what MANDALA_ALLOWED_HOSTS documents and what
    // anybody types. The server is bound on an ephemeral port, so every direct
    // client sends `Host: mcp.example.com:<port>`.
    server = await runHttp({
      port: 0,
      host: '127.0.0.1',
      baseUrl: BASE,
      allowedHosts: ['mcp.example.com'],
    });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('answers the Host header a browser actually sends, port and all', async () => {
    // The bug: only the bare name was allowlisted, the SDK compares the whole
    // header, and so the protection an operator had just turned on answered 403
    // to every request their own clients made.
    const res = await rawPost(
      port,
      `mcp.example.com:${port}`,
      { Authorization: 'Bearer com_alice' },
      INIT,
    );
    expect(res.status).toBe(200);
  });

  it('still answers the portless spelling a proxy forwards', async () => {
    const res = await rawPost(port, 'mcp.example.com', { Authorization: 'Bearer com_alice' }, INIT);
    expect(res.status).toBe(200);
  });

  it('still turns away a name nobody allowed', async () => {
    const res = await rawPost(
      port,
      `evil.example:${port}`,
      { Authorization: 'Bearer com_alice' },
      INIT,
    );
    expect(res.status).toBe(403);
  });
});

describe('what /healthz says about capacity', () => {
  let server: Server;
  let url: string;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    // Every interface, and no allowlist: the exposed bind, where the counters
    // are a capacity oracle rather than a local convenience.
    server = await runHttp({ port: 0, host: '0.0.0.0', baseUrl: BASE });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('still reports liveness', async () => {
    const health = (await (await fetch(`${url}/healthz`)).json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health.name).toBe('mandala-computer');
  });

  it('withholds the two numbers that time an exhaustion', async () => {
    const health = (await (await fetch(`${url}/healthz`)).json()) as Record<string, unknown>;
    expect(health.sessions).toBeUndefined();
    expect(health.largeBodyParses).toBeUndefined();
  });
});
