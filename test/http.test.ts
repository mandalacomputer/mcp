import {
  Agent as HttpAgent,
  request as httpRequest,
  IncomingMessage,
  type Server,
} from 'node:http';
import { type AddressInfo, connect, Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runHttp } from '../src/http.js';
import { MeteredBody } from '../src/http-body.js';
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

it('stops forwarding and retaining chunks when the body reader refuses admission', async () => {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  let seen = 0;
  let forwarded = 0;
  const refused = vi.fn();
  const input = new MeteredBody(
    request,
    (bytes) => {
      seen += bytes;
      return seen <= 256 * 1024;
    },
    refused,
  );
  input.on('data', (chunk: Buffer) => {
    forwarded += chunk.length;
  });
  input.on('error', () => {});
  const closed = new Promise<void>((resolve) => input.once('close', resolve));
  const drained = new Promise<void>((resolve) => request.once('end', resolve));
  try {
    request.push(Buffer.alloc(256 * 1024));
    request.push(Buffer.alloc(1));
    await closed;
    request.push(Buffer.alloc(1024 * 1024));
    request.complete = true;
    request.push(null);
    await drained;
    expect(refused).toHaveBeenCalledOnce();
    expect(forwarded).toBe(256 * 1024);
    expect(input.readableLength).toBe(0);
    expect(input.writableLength).toBe(0);
    expect(input.destroyed).toBe(true);
  } finally {
    request.destroy();
    socket.destroy();
  }
});

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
    const res = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { Authorization: 'Bearer com_alice' },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { id: unknown }).id).toBe(2);
  });

  // OPL-5050: with no key at all, the missing key is the answer, not the
  // missing session — as it already was for an initialize.
  it('answers a sessionless non-initialize with no key 401, not 400', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string }; id: unknown };
    expect(body.error.message).toContain('Bearer');
    expect(body.id).toBe(2);
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
    //
    // Since fair share (OPL-5447) a newcomer may close the idle session of
    // the bearer holding the most, so how many of the burst are answered 200
    // depends on how many land before the next arrives. What cannot change is
    // the table: never more than its two, and every refusal the 503.
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
    expect(burst.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(2);
    expect(burst.filter((r) => r.status !== 200 && r.status !== 503)).toHaveLength(0);
    const health = (await (await fetch(`${url}/healthz`)).json()) as { sessions: number };
    expect(health.sessions).toBe(2);
  });
});

// OPL-5443: the process-wide cap alone let one bearer hold every session, and
// every other caller's initialize was 503'd until the sweep.
describe('the per-bearer session cap', () => {
  const ACCOUNT_CALL = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_account', arguments: {} },
  };
  const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

  /**
   * A server whose platform holds every `GET account` until released, so a
   * `get_account` call keeps its session busy for as long as a test needs.
   */
  async function setup(extra: {
    maxSessionsPerBearer: number;
    maxSessions?: number;
    maxSessionsPerAccount?: number;
  }) {
    const platform = installFakePlatform();
    const inner = globalThis.fetch;
    let open = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const held = { count: 0 };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input.toString());
      if (u.host === new URL(BASE).host && u.pathname.endsWith('/account')) {
        held.count++;
        await gate;
      }
      return inner(input as never, init);
    }) as typeof fetch;
    const server = await runHttp({
      port: 0,
      host: '127.0.0.1',
      baseUrl: BASE,
      maxSessions: 10,
      ...extra,
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (
      body: unknown,
      headers: Record<string, string>,
      method: 'POST' | 'DELETE' = 'POST',
    ) =>
      fetch(`${base}/mcp`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
      });
    const as = (token: string, session?: string) => ({
      Authorization: `Bearer ${token}`,
      ...(session ? { 'mcp-session-id': session } : {}),
    });
    const open1 = async (token: string) => {
      const res = await send(INIT, as(token));
      expect(res.status).toBe(200);
      await res.text();
      return res.headers.get('mcp-session-id') as string;
    };
    /** Start a call that stays in flight until `release`, and wait for it to be held. */
    const busy = async (token: string, session: string) => {
      const before = held.count;
      const call = send(ACCOUNT_CALL, as(token, session));
      const deadline = Date.now() + 5000;
      while (held.count === before) {
        if (Date.now() > deadline) throw new Error('the call never reached the platform');
        await new Promise((r) => setTimeout(r, 5));
      }
      return call;
    };
    const count = async () =>
      ((await (await fetch(`${base}/healthz`)).json()) as { sessions: number }).sessions;
    const teardown = async () => {
      open();
      globalThis.fetch = inner;
      platform.restore();
      await new Promise<void>((r) => server.close(() => r()));
    };
    return {
      url: `${base}/mcp`,
      send,
      as,
      open: open1,
      busy,
      count,
      release: () => open(),
      teardown,
    };
  }

  it('refuses a bearer whose sessions are all busy 429, and still serves another bearer', async () => {
    const t = await setup({ maxSessionsPerBearer: 2 });
    try {
      const a = await t.open('com_alice');
      const b = await t.open('com_alice');
      const calls = [await t.busy('com_alice', a), await t.busy('com_alice', b)];

      const third = await t.send(INIT, t.as('com_alice'));
      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).toBe('30');
      expect(third.headers.get('mcp-session-id')).toBeNull();
      const body = (await third.json()) as { id: unknown; error: { message: string } };
      expect(body.id).toBe(INIT.id);
      expect(body.error.message).toContain('This token already holds its maximum of 2 sessions');
      expect(await t.count()).toBe(2);

      // The pool is not full, only this bearer's share of it.
      await t.open('com_bob');
      expect(await t.count()).toBe(3);

      t.release();
      for (const call of calls) {
        const res = await call;
        expect(res.status).toBe(200);
        await res.text();
      }
    } finally {
      await t.teardown();
    }
  });

  it('makes room by closing the bearer’s least recently seen idle session', async () => {
    const t = await setup({ maxSessionsPerBearer: 2 });
    try {
      const older = await t.open('com_alice');
      const newer = await t.open('com_alice');
      const bob = await t.open('com_bob');
      await new Promise((r) => setTimeout(r, 5));
      // Heard from after `newer`, so `newer` is now the least recently seen.
      const touched = await t.send(LIST, t.as('com_alice', older));
      expect(touched.status).toBe(200);
      await touched.text();

      const third = await t.open('com_alice');
      expect(third).toBeTruthy();
      expect(await t.count()).toBe(3);

      const gone = await t.send(LIST, t.as('com_alice', newer));
      expect(gone.status).toBe(404);
      await gone.text();
      for (const [token, session] of [
        ['com_alice', older],
        ['com_alice', third],
        ['com_bob', bob],
      ] as const) {
        const res = await t.send(LIST, t.as(token, session));
        expect(res.status).toBe(200);
        await res.text();
      }
    } finally {
      await t.teardown();
    }
  });

  it('admits at most its cap from a burst of one bearer’s initializes', async () => {
    // Held before the transport answers, so every reservation is still pending
    // and none is a session yet: nothing can be evicted, and only the
    // per-bearer reservation count stands between the burst and the cap.
    const original = StreamableHTTPServerTransport.prototype.handleRequest;
    let open = () => {};
    const hold = new Promise<void>((r) => {
      open = r;
    });
    let held = 0;
    StreamableHTTPServerTransport.prototype.handleRequest = async function (...args) {
      if (!this.sessionId) {
        held++;
        await hold;
      }
      return original.apply(this, args);
    };
    const t = await setup({ maxSessionsPerBearer: 2 });
    try {
      const answered: number[] = [];
      const burst = Array.from({ length: 5 }, () =>
        t.send(INIT, t.as('com_alice')).then(async (r) => {
          answered.push(r.status);
          await r.text();
          return r.status;
        }),
      );
      const deadline = Date.now() + 5000;
      while (held + answered.length < 5 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(held).toBe(2);
      expect(answered).toEqual([429, 429, 429]);

      open();
      expect((await Promise.all(burst)).sort()).toEqual([200, 200, 429, 429, 429]);
      expect(await t.count()).toBe(2);
    } finally {
      open();
      StreamableHTTPServerTransport.prototype.handleRequest = original;
      await t.teardown();
    }
  });

  it('gives a slot back when a session is deleted', async () => {
    const t = await setup({ maxSessionsPerBearer: 1 });
    try {
      const a = await t.open('com_alice');
      const call = await t.busy('com_alice', a);
      const full = await t.send(INIT, t.as('com_alice'));
      expect(full.status).toBe(429);
      await full.text();

      const del = await t.send(undefined, t.as('com_alice', a), 'DELETE');
      expect(del.status).toBe(200);
      await del.text();
      await t.open('com_alice');
      expect(await t.count()).toBe(1);

      t.release();
      await (await call).text();
    } finally {
      await t.teardown();
    }
  });

  it('gives a reservation back when an initialize fails before it has a session', async () => {
    const t = await setup({ maxSessionsPerBearer: 1 });
    try {
      // No `text/event-stream` in Accept: the SDK answers 406 and never makes
      // the session this initialize had reserved a slot for.
      const refused = await fetch(t.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: 'Bearer com_alice',
        },
        body: JSON.stringify(INIT),
      });
      expect(refused.status).toBe(406);
      await refused.text();
      await t.open('com_alice');
      expect(await t.count()).toBe(1);
    } finally {
      await t.teardown();
    }
  });

  // Review round 1: the room was made before the SDK had looked at the
  // request, so an initialize it then refused cost the caller its idle session
  // and gave it nothing in return.
  it('closes nothing for an initialize the SDK refuses, and still makes room for a valid one', async () => {
    const t = await setup({ maxSessionsPerBearer: 1 });
    try {
      const first = await t.open('com_alice');
      const refused = await t.send(INIT, {
        Accept: 'application/json',
        Authorization: 'Bearer com_alice',
      });
      expect(refused.status).toBe(406);
      await refused.text();

      const kept = await t.send(LIST, t.as('com_alice', first));
      expect(kept.status).toBe(200);
      await kept.text();
      expect(await t.count()).toBe(1);

      const second = await t.open('com_alice');
      expect(await t.count()).toBe(1);
      const gone = await t.send(LIST, t.as('com_alice', first));
      expect(gone.status).toBe(404);
      await gone.text();
      const now = await t.send(LIST, t.as('com_alice', second));
      expect(now.status).toBe(200);
      await now.text();
    } finally {
      await t.teardown();
    }
  });

  // The session it will close is still in the map when the process-wide cap
  // is checked; it must not count against the bearer giving it back.
  it('makes room within its own share when the whole pool is full', async () => {
    const t = await setup({ maxSessionsPerBearer: 1, maxSessions: 2 });
    try {
      const first = await t.open('com_alice');
      const bob = await t.open('com_bob');
      const second = await t.open('com_alice');
      expect(await t.count()).toBe(2);
      const gone = await t.send(LIST, t.as('com_alice', first));
      expect(gone.status).toBe(404);
      await gone.text();
      const now = await t.send(LIST, t.as('com_alice', second));
      expect(now.status).toBe(200);
      await now.text();

      // Another bearer with nothing to give back meets a full pool, and it is
      // shared out (OPL-5447): alice and bob hold one each, so the tie goes to
      // the one whose idle session is older, bob's, untouched since it opened.
      const carol = await t.open('com_carol');
      expect(await t.count()).toBe(2);
      const bobGone = await t.send(LIST, t.as('com_bob', bob));
      expect(bobGone.status).toBe(404);
      await bobGone.text();
      for (const [token, session] of [
        ['com_alice', second],
        ['com_carol', carol],
      ] as const) {
        const res = await t.send(LIST, t.as(token, session));
        expect(res.status).toBe(200);
        await res.text();
      }
    } finally {
      await t.teardown();
    }
  });

  // The per-bearer cap is subtracted from the process-wide count, so a NaN
  // (`Number(process.env.X)` with X unset) once switched off both caps.
  it('keeps both caps when maxSessionsPerBearer is not a usable number', async () => {
    for (const bad of [Number.NaN, 0, -3]) {
      const t = await setup({ maxSessionsPerBearer: bad, maxSessions: 2 });
      try {
        // Busy, so fair share has nothing it may close and the pool is full.
        const calls = [
          await t.busy('com_alice', await t.open('com_alice')),
          await t.busy('com_bob', await t.open('com_bob')),
        ];
        const carol = await t.send(INIT, t.as('com_carol'));
        expect(carol.status).toBe(503);
        await carol.text();
        expect(await t.count()).toBe(2);
        t.release();
        for (const c of calls) await c.text();
      } finally {
        await t.teardown();
      }
    }
    // And the default per-bearer 16 applies, not the unusable value.
    const t = await setup({ maxSessionsPerBearer: Number.NaN, maxSessions: 40 });
    try {
      const mine: string[] = [];
      for (let i = 0; i < 16; i++) mine.push(await t.open('com_alice'));
      const calls: Response[] = [];
      for (const s of mine) calls.push(await t.busy('com_alice', s));
      const over = await t.send(INIT, t.as('com_alice'));
      expect(over.status).toBe(429);
      await over.text();
      t.release();
      for (const c of calls) await c.text();
    } finally {
      await t.teardown();
    }
  });

  // The room is chosen when the initialize arrives but made only once its
  // session exists. A session put to work in between is not closed under its
  // request, and the bearer is not let over its cap either.
  it('drops a new session rather than close one put to work while it was being made', async () => {
    const original = StreamableHTTPServerTransport.prototype.handleRequest;
    let open = () => {};
    const hold = new Promise<void>((r) => {
      open = r;
    });
    let held = 0;
    const t = await setup({ maxSessionsPerBearer: 1 });
    try {
      const first = await t.open('com_alice');
      StreamableHTTPServerTransport.prototype.handleRequest = async function (...args) {
        if (!this.sessionId) {
          held++;
          await hold;
        }
        return original.apply(this, args);
      };
      const second = t.send(INIT, t.as('com_alice'));
      const deadline = Date.now() + 5000;
      while (held === 0) {
        if (Date.now() > deadline) throw new Error('the initialize never reached the transport');
        await new Promise((r) => setTimeout(r, 5));
      }
      // Idle when the initialize was admitted; busy by the time it lands.
      const call = await t.busy('com_alice', first);
      open();
      const late = await second;
      // The SDK answers it, not the 429 path: the transport was closed before
      // it replied. README and CHANGELOG say 404 for this race; pin it.
      expect(late.status).toBe(404);
      expect(late.headers.get('mcp-session-id')).toBeNull();
      expect(late.headers.get('retry-after')).toBeNull();
      expect(((await late.json()) as { error: { code: number } }).error.code).toBe(-32001);
      expect(await t.count()).toBe(1);

      t.release();
      const answered = await call;
      expect(answered.status).toBe(200);
      await answered.text();
      const kept = await t.send(LIST, t.as('com_alice', first));
      expect(kept.status).toBe(200);
      await kept.text();
    } finally {
      open();
      StreamableHTTPServerTransport.prototype.handleRequest = original;
      await t.teardown();
    }
  });

  // OPL-5447: the pool was first come, first served. Full, every newcomer was
  // 503'd however few sessions it held, while one caller holding most of them
  // kept them all. Self-hosted, each bearer is its own account.
  describe('fair share of a full pool', () => {
    const pause = () => new Promise((r) => setTimeout(r, 5));
    const status = async (t: Awaited<ReturnType<typeof setup>>, token: string, session: string) => {
      const res = await t.send(LIST, t.as(token, session));
      await res.text();
      return res.status;
    };
    /** Hold every initialize at the transport until `open`, counting them. */
    function holdInitializes() {
      const original = StreamableHTTPServerTransport.prototype.handleRequest;
      let open = () => {};
      const gate = new Promise<void>((r) => {
        open = r;
      });
      const state = { held: 0 };
      StreamableHTTPServerTransport.prototype.handleRequest = async function (...args) {
        if (!this.sessionId) {
          state.held++;
          await gate;
        }
        return original.apply(this, args);
      };
      return {
        state,
        open: () => open(),
        restore: () => {
          open();
          StreamableHTTPServerTransport.prototype.handleRequest = original;
        },
      };
    }
    const until = async (done: () => boolean, what: string) => {
      const deadline = Date.now() + 5000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(what);
        await pause();
      }
    };

    it('closes the least recently used idle session of the bearer holding the most', async () => {
      const t = await setup({ maxSessionsPerBearer: 16, maxSessions: 4 });
      try {
        // Bob's one session is the oldest in the pool, and is not the one to go.
        const bob = await t.open('com_bob');
        await pause();
        const a1 = await t.open('com_alice');
        await pause();
        const a2 = await t.open('com_alice');
        await pause();
        const a3 = await t.open('com_alice');
        expect(await t.count()).toBe(4);

        const carol = await t.open('com_carol');
        expect(await t.count()).toBe(4);
        expect(await status(t, 'com_alice', a1)).toBe(404);
        expect(await status(t, 'com_bob', bob)).toBe(200);
        expect(await status(t, 'com_alice', a2)).toBe(200);
        expect(await status(t, 'com_alice', a3)).toBe(200);
        expect(await status(t, 'com_carol', carol)).toBe(200);
      } finally {
        await t.teardown();
      }
    });

    it('closes the requester’s own idle session when it is the one holding the most', async () => {
      const t = await setup({ maxSessionsPerBearer: 16, maxSessions: 4 });
      try {
        const bob = await t.open('com_bob');
        await pause();
        const a1 = await t.open('com_alice');
        await pause();
        await t.open('com_alice');
        await pause();
        await t.open('com_alice');
        const a4 = await t.open('com_alice');
        expect(await t.count()).toBe(4);
        expect(await status(t, 'com_alice', a1)).toBe(404);
        expect(await status(t, 'com_bob', bob)).toBe(200);
        expect(await status(t, 'com_alice', a4)).toBe(200);
      } finally {
        await t.teardown();
      }
    });

    it('never closes a session with a request in flight, nor a smaller holder’s instead', async () => {
      const t = await setup({ maxSessionsPerBearer: 16, maxSessions: 4 });
      try {
        const bob = await t.open('com_bob');
        await pause();
        const a1 = await t.open('com_alice');
        await pause();
        const a2 = await t.open('com_alice');
        await pause();
        const a3 = await t.open('com_alice');
        const calls = [await t.busy('com_alice', a1), await t.busy('com_alice', a2)];

        // Alice's older two are busy; her idle third is the one that goes.
        const carol = await t.open('com_carol');
        expect(await status(t, 'com_alice', a3)).toBe(404);
        expect(await t.count()).toBe(4);

        // Alice still holds the most, and nothing of hers is idle: the pool is
        // full, and bob's and carol's idle sessions are not taken instead.
        const dave = await t.send(INIT, t.as('com_dave'));
        expect(dave.status).toBe(503);
        expect(dave.headers.get('mcp-session-id')).toBeNull();
        await dave.text();
        expect(await t.count()).toBe(4);
        expect(await status(t, 'com_bob', bob)).toBe(200);
        expect(await status(t, 'com_carol', carol)).toBe(200);

        t.release();
        for (const call of calls) {
          const res = await call;
          expect(res.status).toBe(200);
          await res.text();
        }
      } finally {
        await t.teardown();
      }
    });

    it('never lets concurrent initializes take the same room twice', async () => {
      const t = await setup({ maxSessionsPerBearer: 16, maxSessions: 2 });
      let hold: ReturnType<typeof holdInitializes> | undefined;
      try {
        const alice = await t.open('com_alice');
        const bob = await t.open('com_bob');
        const call = await t.busy('com_bob', bob);
        hold = holdInitializes();
        const h = hold;
        // One idle session in the pool, two newcomers at once: the first
        // plans to close it, and the second, counting the first as pending,
        // finds nothing more to close.
        const answered: number[] = [];
        const both = ['com_carol', 'com_dave'].map((token) =>
          t.send(INIT, t.as(token)).then(async (r) => {
            answered.push(r.status);
            await r.text();
            return r.status;
          }),
        );
        await until(() => h.state.held + answered.length === 2, 'the initializes never settled');
        expect(h.state.held).toBe(1);
        expect(answered).toEqual([503]);

        h.open();
        expect((await Promise.all(both)).sort()).toEqual([200, 503]);
        expect(await t.count()).toBe(2);
        expect(await status(t, 'com_alice', alice)).toBe(404);

        t.release();
        await (await call).text();
      } finally {
        hold?.restore();
        await t.teardown();
      }
    });

    it('drops a new session rather than close a fair-share victim put to work while it was made', async () => {
      const t = await setup({ maxSessionsPerBearer: 16, maxSessions: 2 });
      let hold: ReturnType<typeof holdInitializes> | undefined;
      try {
        const a1 = await t.open('com_alice');
        await pause();
        const a2 = await t.open('com_alice');
        const busyA2 = await t.busy('com_alice', a2);
        hold = holdInitializes();
        const h = hold;
        const carol = t.send(INIT, t.as('com_carol'));
        await until(() => h.state.held === 1, 'the initialize never reached the transport');
        // Idle when carol was admitted; busy by the time her session lands.
        const busyA1 = await t.busy('com_alice', a1);
        h.open();
        const late = await carol;
        expect(late.status).toBe(404);
        expect(late.headers.get('mcp-session-id')).toBeNull();
        await late.text();
        expect(await t.count()).toBe(2);

        t.release();
        for (const call of [busyA1, busyA2]) await (await call).text();
        expect(await status(t, 'com_alice', a1)).toBe(200);
        expect(await status(t, 'com_alice', a2)).toBe(200);
      } finally {
        hold?.restore();
        await t.teardown();
      }
    });

    it('sets no account ceiling by default, and holds each token to one that is set', async () => {
      const open = await setup({ maxSessionsPerBearer: 16, maxSessions: 4 });
      try {
        for (let i = 0; i < 4; i++) await open.open('com_alice');
        expect(await open.count()).toBe(4);
      } finally {
        await open.teardown();
      }

      const t = await setup({ maxSessionsPerBearer: 16, maxSessionsPerAccount: 2 });
      try {
        const a1 = await t.open('com_alice');
        await pause();
        const a2 = await t.open('com_alice');
        // Idle: the third closes the first.
        const a3 = await t.open('com_alice');
        expect(await t.count()).toBe(2);
        expect(await status(t, 'com_alice', a1)).toBe(404);
        // Busy: the fourth is refused, in words about the token.
        const calls = [await t.busy('com_alice', a2), await t.busy('com_alice', a3)];
        const over = await t.send(INIT, t.as('com_alice'));
        expect(over.status).toBe(429);
        expect(over.headers.get('retry-after')).toBe('30');
        expect(((await over.json()) as { error: { message: string } }).error.message).toContain(
          'This token already holds its maximum of 2 sessions',
        );
        // Another token is its own account.
        await t.open('com_bob');
        expect(await t.count()).toBe(3);
        t.release();
        for (const c of calls) await (await c).text();
      } finally {
        await t.teardown();
      }
    });
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

/** A GET with a Host header of our choosing, for the reason `rawPost` exists. */
function rawGet(
  port: number,
  host: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } },
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
    req.end();
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

  it('is told which of its requests was refused, like every other refusal here', async () => {
    // The rebinding 403 was the one refusal on this route that answered with a
    // null id, so a client with several requests in flight could not tell which
    // call it belonged to. `parseBody` has already run, so the id is there.
    const res = await rawPost(
      port,
      'evil.example',
      { Authorization: 'Bearer com_alice' },
      { ...INIT, id: 7 },
    );
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { id: unknown }).id).toBe(7);
  });

  it('is not told the occupancy counters by /healthz either', async () => {
    // The counters are withheld from an exposed bind because they time an
    // exhaustion. A loopback bind withheld nothing, on the reasoning that its
    // only readers are on this machine — and a rebound name is precisely a
    // reader that is not, reading a same-origin response from the browser.
    const evil = JSON.parse((await rawGet(port, 'evil.example', '/healthz')).body) as Record<
      string,
      unknown
    >;
    expect(evil.ok).toBe(true);
    expect(evil.sessions).toBeUndefined();
    expect(evil.largeBodyParses).toBeUndefined();
    // Still counted for a caller that reached the server by a name it answers.
    const ours = JSON.parse((await rawGet(port, `127.0.0.1:${port}`, '/healthz')).body) as Record<
      string,
      unknown
    >;
    expect(ours.sessions).toBeTypeOf('number');
    expect(ours.largeBodyParses).toBeTypeOf('number');
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
    // The statuses a bearer-less caller gets are the route's own: the body is
    // still parsed, just not at the large limit. With no key, a sessionless
    // tools/list is a 401 like an initialize (OPL-5050).
    expect(
      (await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).status,
    ).toBe(401);
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

describe('a body that declared no length', () => {
  let server: Server;
  let url: string;
  let platform: ReturnType<typeof installFakePlatform>;

  beforeAll(async () => {
    platform = installFakePlatform();
    // One slot, so "took a slot" and "did not" are the difference between a
    // second request being served and being refused.
    server = await runHttp({ port: 0, host: '127.0.0.1', baseUrl: BASE, maxLargeBodyParses: 1 });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    platform.restore();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** A chunked POST: no Content-Length, written in two pieces. */
  const chunked = (sessionId: string, body: string) => {
    const target = new URL(url);
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-platform-key',
        'mcp-session-id': sessionId,
      },
    });
    const done = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
    });
    return { req, done, body };
  };

  const openSession = async () => {
    const opened = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-platform-key',
      },
      body: JSON.stringify(INIT),
    });
    const id = opened.headers.get('mcp-session-id') as string;
    await opened.text();
    return id;
  };

  const parsesNow = async () =>
    ((await (await fetch(`${url}/healthz`)).json()) as { largeBodyParses: number }).largeBodyParses;

  it('does not charge a slot for a small one, however many are in flight', async () => {
    // A missing Content-Length was read as "may be large", so a chunked call the
    // size of a mouse click held one of the process's slots for its whole tool
    // lifetime. With one slot configured, two such calls used to mean a 503 for
    // the second — on the strength of an absent header, not of any bytes.
    const sessionId = await openSession();
    const small = JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/list' });

    const a = chunked(sessionId, small);
    const b = chunked(sessionId, small);
    a.req.write(small.slice(0, 10));
    b.req.write(small.slice(0, 10));
    await new Promise((r) => setTimeout(r, 50));
    // Neither has taken one, with both mid-flight.
    expect(await parsesNow()).toBe(0);

    a.req.end(small.slice(10));
    b.req.end(small.slice(10));
    expect(await a.done).not.toBe(503);
    expect(await b.done).not.toBe(503);
    expect(await parsesNow()).toBe(0);
  }, 10_000);

  it('delivers the 503 to a caller still uploading', async () => {
    // The refusal this path exists to give, asserted end to end — it had no
    // test, and two attempts at tidying the socket afterwards both lost it
    // entirely: the caller got zero bytes and EPIPE instead of a status line.
    // Nothing is destroyed here now; body-parser drains the rest under its own
    // ceiling and the socket ends the ordinary way.
    const sessionId = await openSession();
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/list',
      pad: 'x'.repeat(900_000),
    });
    // Hold the single slot with one request, mid-flight.
    const holder = chunked(sessionId, big);
    holder.req.write(big.slice(0, 300_000));
    for (let i = 0; i < 100 && (await parsesNow()) === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await parsesNow()).toBe(1);

    // A second one crosses the threshold with no slot left, still writing.
    const refused = chunked(sessionId, big);
    let status = 0;
    let body = '';
    const answered = new Promise<void>((resolve) => {
      refused.req.on('response', (res) => {
        status = res.statusCode ?? 0;
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () => resolve());
      });
      // EPIPE is the failure this test exists to catch, not an excuse to skip.
      refused.req.on('error', () => resolve());
    });
    // KEEPS WRITING while the answer comes back. That is the condition: a
    // client that stops and waits races differently and gets the 503 even from
    // a build that would have lost it, which is exactly how the first spelling
    // of this test passed against the bug it was written for.
    let writing = true;
    const chunk = 'y'.repeat(256 * 1024);
    const keepWriting = () => {
      if (!writing) return;
      if (!refused.req.write(chunk)) refused.req.once('drain', keepWriting);
      else setImmediate(keepWriting);
    };
    refused.req.on('error', () => {
      writing = false;
    });
    keepWriting();
    await answered;
    writing = false;

    expect(status).toBe(503);
    expect(body).toMatch(/maximum.*large request bodies/i);

    holder.req.end(big.slice(300_000));
    await holder.done;
  }, 15_000);

  it('never parses a refused chunked body, including bytes sent after the 503', async () => {
    const sessionId = await openSession();
    const holder = chunked(sessionId, '');
    void holder.done.catch(() => {});
    holder.req.write(`{"pad":"${'x'.repeat(300_000)}`);
    for (let i = 0; i < 100 && (await parsesNow()) === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await parsesNow()).toBe(1);

    const marker = 'refused-body-must-never-be-parsed';
    const parse = vi.spyOn(JSON, 'parse');
    const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
    socket.setTimeout(5_000, () => socket.destroy(new Error('upload test timed out')));
    let received = '';
    const answered = new Promise<void>((resolve, reject) => {
      socket.on('data', (data) => {
        received += data.toString();
        if (received.includes('HTTP/1.1 503')) resolve();
      });
      socket.on('error', reject);
    });
    const drained = new Promise<void>((resolve, reject) => {
      socket.on('data', () => {
        if (received.includes('"ok":true')) resolve();
      });
      socket.on('error', reject);
    });
    void drained.catch(() => {});
    const writeChunk = (body: string) =>
      socket.write(`${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n`);
    try {
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${(server.address() as AddressInfo).port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer not-a-platform-key\r\nmcp-session-id: ${sessionId}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n`,
      );
      writeChunk(`{"pad":"${marker}${'x'.repeat(300_000)}`);
      await answered;
      writeChunk(`${'y'.repeat(1024 * 1024)}"}`);
      socket.write(
        `0\r\n\r\nGET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${(server.address() as AddressInfo).port}\r\nConnection: close\r\n\r\n`,
      );
      await drained;
      expect(parse.mock.calls.some(([body]) => body.includes(marker))).toBe(false);
    } finally {
      parse.mockRestore();
      socket.destroy();
      holder.req.destroy();
    }
  }, 10_000);

  it('reads an empty Content-Encoding as no encoding, the way body-parser does', async () => {
    // `Content-Encoding:` with nothing after it inflates nothing, so metering it
    // is exact — and treating the blank header as an encoding put the original
    // bug back within reach of anyone who sends one: a mouse-click-sized
    // chunked call holding a process-wide slot for its whole tool lifetime.
    const sessionId = await openSession();
    const small = JSON.stringify({ jsonrpc: '2.0', id: 25, method: 'tools/list' });
    const target = new URL(url);
    for (const value of ['', 'identity']) {
      const req = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': value,
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer not-a-platform-key',
          'mcp-session-id': sessionId,
        },
      });
      const done = new Promise<number>((resolve, reject) => {
        req.on('response', (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
      });
      req.write(small.slice(0, 10));
      await new Promise((r) => setTimeout(r, 50));
      expect(await parsesNow(), `Content-Encoding: '${value}'`).toBe(0);
      req.end(small.slice(10));
      await done;
    }
  }, 10_000);

  it('releases a chunked upload lease when its client aborts', async () => {
    const sessionId = await openSession();
    const abandoned = chunked(sessionId, '');
    const stopped = abandoned.done.catch(() => {});
    abandoned.req.write(`{"pad":"${'x'.repeat(300_000)}`);
    for (let i = 0; i < 100 && (await parsesNow()) === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await parsesNow()).toBe(1);
    abandoned.req.destroy();
    await stopped;
    for (let i = 0; i < 100 && (await parsesNow()) !== 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await parsesNow()).toBe(0);

    const next = chunked(sessionId, '');
    // JSON-RPC rejects unknown top-level fields; request metadata carries the
    // padding without turning this recovery check into an invalid request.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/list',
      params: { _meta: { pad: 'x'.repeat(300_000) } },
    });
    next.req.write(body.slice(0, 1));
    next.req.end(body.slice(1));
    expect(await next.done).toBe(200);
  }, 10_000);

  it('still rejects malformed JSON arriving through the metered reader', async () => {
    const sessionId = await openSession();
    const malformed = chunked(sessionId, '');
    malformed.req.write('{');
    malformed.req.end('"jsonrpc":');
    expect(await malformed.done).toBe(400);
    expect(await parsesNow()).toBe(0);
  });

  it('charges a compressed body up front, since the wire says nothing about its size', async () => {
    // body-parser inflates before applying its limit, so wire bytes are not
    // what gets allocated: a few thousand gzipped bytes become megabytes of
    // parsed JSON the meter never sees. Metering an encoded body would be a way
    // AROUND the cap rather than a sharpening of it, so it keeps the old rule.
    const sessionId = await openSession();
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/list',
      pad: 'x'.repeat(5_000_000),
    });
    const squashed = gzipSync(Buffer.from(big));
    // Comfortably under the 256KB threshold on the wire, and 5MB once inflated.
    expect(squashed.length).toBeLessThan(256 * 1024);

    const target = new URL(url);
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-platform-key',
        'mcp-session-id': sessionId,
      },
    });
    const done = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
    });
    // Written in two pieces so the request is still in flight when the count is
    // read: a body this small would otherwise be parsed before the check.
    req.write(squashed.subarray(0, 100));
    for (let i = 0; i < 100 && (await parsesNow()) === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await parsesNow()).toBe(1);
    req.end(squashed.subarray(100));
    await done;
  }, 10_000);

  it('charges one the moment the bytes say it is large', async () => {
    // The other half: metering has to actually engage, or the cap it replaced
    // would be bounding nothing at all.
    const sessionId = await openSession();
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/list',
      pad: 'x'.repeat(400_000),
    });
    const a = chunked(sessionId, big);
    // WHEN the slot is taken is the whole point, so both sides are asserted.
    // Under the old rule it was taken on arrival, before a byte had been read;
    // now the first 10 bytes buy nothing.
    a.req.write(big.slice(0, 10));
    await new Promise((r) => setTimeout(r, 50));
    expect(await parsesNow()).toBe(0);

    // Past SMALL_BODY_BYTES (256KB) and not finished, so the slot is held here.
    a.req.write(big.slice(10, 300_000));
    for (let i = 0; i < 100 && (await parsesNow()) === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await parsesNow()).toBe(1);
    a.req.end(big.slice(300_000));
    await a.done;
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
