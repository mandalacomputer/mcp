import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runHttp } from '../src/http.js';
import { BASE, installFakePlatform, WHOAMI } from './harness.js';

// OPL-5453 and OPL-5454: how the hosted session pool is shared out.
//
// - An account's default ceiling is a quarter of the pool (64 of 256). Half
//   let two accounts take the whole pool between them.
// - The last quarter of the pool goes only to accounts holding less than
//   their share of the rest: the unreserved part divided by the accounts
//   holding sessions, the asker's included.
// - A workspace-scoped key is also held to its workspace's sub-ceiling, a
//   quarter of its account's ceiling by default, and still shares its
//   operator's account ceiling above that.

const METADATA = 'https://app.mandala.computer/.well-known/oauth-protected-resource/mcp';
const SECRET = 'svc-0123456789abcdef';

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
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

const workspaceFull = (cap: number) =>
  `This workspace has reached its maximum of ${cap} ${cap === 1 ? 'session' : 'sessions'} on this server, across all its tokens. Close one (DELETE /mcp) or retry shortly.`;
const accountFull = (cap: number) =>
  `This account has reached its maximum of ${cap} sessions on this server, across all its tokens. Close one (DELETE /mcp) or retry shortly.`;
const reserveFull = (reserve: number) =>
  `This server keeps its last ${reserve} sessions for accounts holding less than their share of it, and this account holds its share. Retry shortly.`;

/**
 * The platform, as far as these tests need it: per token, the account id its
 * whoami names and the `workspace` it names (`null`, the default, for a key of
 * the account as a whole; any value at all, to test what is not a workspace);
 * per token, a gate its whoami requests wait on; and tokens refused with 401.
 */
function platform() {
  const base = installFakePlatform();
  const fake = globalThis.fetch;
  const accounts: Record<string, string> = {};
  const workspaces: Record<string, unknown> = {};
  const gates = new Map<string, Promise<void>>();
  const refused = new Set<string>();
  let whoamis = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.host !== new URL(BASE).host) return fake(input as never, init);
    const token = (new Headers(init?.headers ?? {}).get('authorization') ?? '').replace(
      /^Bearer /,
      '',
    );
    const isWhoami = url.pathname.endsWith('/whoami');
    if (isWhoami) whoamis++;
    const gate = isWhoami ? gates.get(token) : undefined;
    if (gate) await gate;
    if (refused.has(token)) {
      return new Response(JSON.stringify({ error: 'invalid or expired access token' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer error="invalid_token"',
        },
      });
    }
    const id = accounts[token];
    if (isWhoami && id !== undefined) {
      const record = {
        ...WHOAMI,
        account: { ...WHOAMI.account, id, name: id },
        workspace: token in workspaces ? workspaces[token] : null,
      };
      return new Response(JSON.stringify(record), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return fake(input as never, init);
  }) as typeof fetch;

  /** Name `tokens` as keys of account `id`, scoped to `workspace` when given. */
  const key = (id: string, workspace: unknown, ...tokens: string[]) => {
    for (const t of tokens) {
      accounts[t] = id;
      if (workspace === undefined) delete workspaces[t];
      else workspaces[t] = workspace;
    }
  };
  /** Hold `token`'s whoami requests until the returned release is called. */
  const hold = (token: string) => {
    let release = () => {};
    gates.set(
      token,
      new Promise<void>((r) => {
        release = r;
      }),
    );
    return () => {
      gates.delete(token);
      release();
    };
  };
  /** Resolve once more whoami requests than `before` have arrived. */
  const reached = async (before: number) => {
    const deadline = Date.now() + 5000;
    while (whoamis <= before) {
      if (Date.now() > deadline) throw new Error('a whoami never reached the platform');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return {
    accounts,
    refused,
    key,
    hold,
    reached,
    whoamis: () => whoamis,
    restore: () => {
      for (const g of gates.keys()) gates.delete(g);
      globalThis.fetch = fake;
      base.restore();
    },
  };
}

async function start(extra: Partial<Parameters<typeof runHttp>[0]> = {}) {
  const server = await runHttp({
    port: 0,
    host: '127.0.0.1',
    baseUrl: BASE,
    resourceMetadataUrl: METADATA,
    serviceSecret: SECRET,
    ...extra,
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/mcp` };
}

const stop = (server: Server) => new Promise<void>((r) => server.close(() => r()));

const as = (token: string, session?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(session ? { 'mcp-session-id': session } : {}),
});

function client(url: string) {
  const send = (
    body: unknown,
    headers: Record<string, string> = {},
    method: 'POST' | 'GET' | 'DELETE' = 'POST',
  ) =>
    fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
  const open = async (token: string) => {
    const res = await send(INIT, as(token));
    expect(res.status, `${token}'s initialize`).toBe(200);
    await res.text();
    return res.headers.get('mcp-session-id') as string;
  };
  /** The status of a tools/list on `session` under `token`. */
  const list = async (token: string, session: string) => {
    const res = await send(LIST, as(token, session));
    await res.text();
    return res.status;
  };
  return { send, open, list };
}

const sessions = async (url: string) =>
  ((await (await fetch(url.replace(/\/mcp$/, '/healthz'))).json()) as { sessions: number })
    .sessions;

const message = async (res: Response) =>
  ((await res.json()) as { error: { message: string } }).error.message;

/** An initialize that must be refused: its status, Retry-After and message. */
const refusal = async (res: Response) => ({
  status: res.status,
  retryAfter: res.headers.get('retry-after'),
  session: res.headers.get('mcp-session-id'),
  message: await message(res),
});

/**
 * Hold every initialize before its session exists, until `open`, so the
 * admissions stay pending. Returns how many are held so far and a restore for
 * `finally`.
 */
function holdInitializes() {
  const original = StreamableHTTPServerTransport.prototype.handleRequest;
  let open = () => {};
  const hold = new Promise<void>((r) => {
    open = r;
  });
  const held = { count: 0 };
  StreamableHTTPServerTransport.prototype.handleRequest = async function (...args) {
    if (!this.sessionId) {
      held.count++;
      await hold;
    }
    return original.apply(this, args);
  };
  return {
    held,
    open: () => open(),
    restore: () => {
      open();
      StreamableHTTPServerTransport.prototype.handleRequest = original;
    },
  };
}

/**
 * Send `tokens`' initializes at once while every admission is held pending,
 * and resolve once each is either held or answered: what was answered at once,
 * how many are held, and the whole burst's statuses once released.
 */
async function burst(url: string, tokens: string[]) {
  const c = client(url);
  const hold = holdInitializes();
  const answered: Array<{ status: number; message: string }> = [];
  try {
    const sent = tokens.map((t) =>
      c.send(INIT, as(t)).then(async (r) => {
        if (r.status === 200) {
          await r.text();
        } else {
          answered.push({ status: r.status, message: await message(r) });
        }
        return r.status;
      }),
    );
    const deadline = Date.now() + 5000;
    while (hold.held.count + answered.length < tokens.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const held = hold.held.count;
    const early = [...answered];
    hold.open();
    const all = (await Promise.all(sent)).sort();
    return { held, early, all };
  } finally {
    hold.restore();
  }
}

describe('hosted: an account’s default ceiling is a quarter of the pool (OPL-5454)', () => {
  let p: ReturnType<typeof platform>;
  afterEach(() => p.restore());

  it('holds an account to 2 of a pool of 8 across its keys, and leaves another account alone', async () => {
    p = platform();
    p.key('acc-a', undefined, 'mcpat_a1', 'mcpat_a2', 'mcpat_a3');
    p.key('acc-b', undefined, 'mcpat_b');
    const { server, url } = await start({ maxSessions: 8 });
    try {
      const c = client(url);
      const held = [await c.open('mcpat_a1'), await c.open('mcpat_a2')];
      const over = await refusal(await c.send(INIT, as('mcpat_a3')));
      expect(over).toEqual({
        status: 429,
        retryAfter: '30',
        session: null,
        message: accountFull(2),
      });
      expect(await c.list('mcpat_a1', held[0])).toBe(200);
      expect(await c.list('mcpat_a2', held[1])).toBe(200);
      await c.open('mcpat_b');
      expect(await sessions(url)).toBe(3);
    } finally {
      await stop(server);
    }
  });
});

describe('hosted: the last quarter of the pool is for accounts under their share (OPL-5454)', () => {
  let p: ReturnType<typeof platform>;
  afterEach(() => p.restore());

  // Pool 8: 2 reserved, 6 unreserved. A lone account's share is all 6, so it
  // never enters the reserve; each newcomer can.
  it('keeps the reserve from a lone account, closes nothing, and gives it to newcomers', async () => {
    p = platform();
    p.key('acc-a', undefined, 'mcpat_a');
    p.key('acc-b', undefined, 'mcpat_b');
    p.key('acc-c', undefined, 'mcpat_c');
    const { server, url } = await start({ maxSessions: 8, maxSessionsPerAccount: 8 });
    try {
      const c = client(url);
      const mine: string[] = [];
      for (let i = 0; i < 6; i++) mine.push(await c.open('mcpat_a'));
      const over = await refusal(await c.send(INIT, as('mcpat_a')));
      expect(over).toEqual({
        status: 503,
        retryAfter: '30',
        session: null,
        message: reserveFull(2),
      });
      // Nothing was closed to answer it.
      expect(await sessions(url)).toBe(6);
      for (const s of mine) expect(await c.list('mcpat_a', s)).toBe(200);

      // Two accounts now: a share is 3, and the newcomer holds none.
      await c.open('mcpat_b');
      expect(await sessions(url)).toBe(7);
      await c.open('mcpat_b');
      expect(await sessions(url)).toBe(8);
      // The pool itself is full: its own answer, unchanged.
      const full = await refusal(await c.send(INIT, as('mcpat_c')));
      expect(full).toEqual({
        status: 503,
        retryAfter: '30',
        session: null,
        message: 'This server is holding its maximum of 8 sessions. Retry shortly.',
      });
      expect(await sessions(url)).toBe(8);
    } finally {
      await stop(server);
    }
  });

  // Pool 16: 4 reserved, 12 unreserved. With three accounts a share is 4.
  it('refuses an account at its share in the reserve while a smaller one is admitted', async () => {
    p = platform();
    p.key('acc-a', undefined, 'mcpat_a');
    p.key('acc-b', undefined, 'mcpat_b');
    p.key('acc-c', undefined, 'mcpat_c');
    const { server, url } = await start({ maxSessions: 16, maxSessionsPerAccount: 16 });
    try {
      const c = client(url);
      for (let i = 0; i < 8; i++) await c.open('mcpat_a');
      for (let i = 0; i < 4; i++) await c.open('mcpat_b');
      expect(await sessions(url)).toBe(12);
      // Two accounts hold sessions: a's share is 6, and it holds 8.
      expect(await refusal(await c.send(INIT, as('mcpat_a')))).toMatchObject({
        status: 503,
        message: reserveFull(4),
      });
      // A third account asking makes the share 4, and it holds none.
      await c.open('mcpat_c');
      expect(await sessions(url)).toBe(13);
      // b holds exactly its share of 4 now: refused, in the same state in
      // which c, holding 1, is admitted.
      expect(await refusal(await c.send(INIT, as('mcpat_b')))).toMatchObject({
        status: 503,
        message: reserveFull(4),
      });
      await c.open('mcpat_c');
      expect(await sessions(url)).toBe(14);
      expect(await refusal(await c.send(INIT, as('mcpat_a')))).toMatchObject({ status: 503 });
      expect(await sessions(url)).toBe(14);
    } finally {
      await stop(server);
    }
  });

  // Pool 16: with four accounts holding or asking, a share of the 12 is 3.
  // Every admission of the burst is still pending when the next is counted.
  it('counts an account’s initializes in flight toward its share', async () => {
    p = platform();
    p.key('acc-a', undefined, 'mcpat_a');
    p.key('acc-c', undefined, 'mcpat_c');
    p.key('acc-d', undefined, 'mcpat_d');
    const bs = ['mcpat_b0', 'mcpat_b1', 'mcpat_b2', 'mcpat_b3'];
    p.key('acc-b', undefined, ...bs);
    const { server, url } = await start({ maxSessions: 16, maxSessionsPerAccount: 16 });
    try {
      const c = client(url);
      for (let i = 0; i < 8; i++) await c.open('mcpat_a');
      for (let i = 0; i < 2; i++) await c.open('mcpat_c');
      for (let i = 0; i < 2; i++) await c.open('mcpat_d');
      expect(await sessions(url)).toBe(12);
      const { held, early, all } = await burst(url, bs);
      expect(held).toBe(3);
      expect(early).toEqual([{ status: 503, message: reserveFull(4) }]);
      expect(all).toEqual([200, 200, 200, 503]);
      expect(await sessions(url)).toBe(15);
    } finally {
      await stop(server);
    }
  });

  // A key replacing its own idle session is not refused for the session it
  // is about to give back: that one is not counted toward its share.
  it('does not count the session a key is about to give back toward its share', async () => {
    p = platform();
    p.key('acc-a', undefined, 'mcpat_a1', 'mcpat_a2');
    p.key('acc-b', undefined, 'mcpat_b');
    p.key('acc-c', undefined, 'mcpat_c');
    const { server, url } = await start({
      maxSessions: 16,
      maxSessionsPerAccount: 16,
      maxSessionsPerBearer: 4,
    });
    try {
      const c = client(url);
      for (let i = 0; i < 4; i++) await c.open('mcpat_a1');
      for (let i = 0; i < 4; i++) await c.open('mcpat_a2');
      const bs: string[] = [];
      for (let i = 0; i < 4; i++) bs.push(await c.open('mcpat_b'));
      await c.open('mcpat_c');
      expect(await sessions(url)).toBe(13);
      // b is at its own cap of 4 and at its share of 4 (three accounts): its
      // oldest idle session makes the room, leaving it 3 and then 4 again.
      const again = await c.open('mcpat_b');
      expect(await sessions(url)).toBe(13);
      expect(await c.list('mcpat_b', bs[0])).toBe(404);
      expect(await c.list('mcpat_b', again)).toBe(200);
    } finally {
      await stop(server);
    }
  });
});

describe('hosted: a workspace’s sub-ceiling under its account’s (OPL-5453)', () => {
  let p: ReturnType<typeof platform>;
  afterEach(() => p.restore());

  const ws = (id: string) => ({ id, name: id, created_at: '2026-09-01T00:00:00Z' });

  // Pool 32: the account ceiling is 8 and a workspace's sub-ceiling 2.
  it('holds a workspace to a quarter of its account’s ceiling, and nobody else to it', async () => {
    p = platform();
    p.key('acc-a', ws('ws-1'), 'mcpat_w1a', 'mcpat_w1b', 'mcpat_w1c');
    p.key('acc-a', ws('ws-2'), 'mcpat_w2');
    p.key('acc-a', null, 'mcpat_op');
    const { server, url } = await start({ maxSessions: 32 });
    try {
      const c = client(url);
      const held = [await c.open('mcpat_w1a'), await c.open('mcpat_w1b')];
      const over = await refusal(await c.send(INIT, as('mcpat_w1c')));
      expect(over).toEqual({
        status: 429,
        retryAfter: '30',
        session: null,
        message: workspaceFull(2),
      });
      expect(await c.list('mcpat_w1a', held[0])).toBe(200);
      expect(await c.list('mcpat_w1b', held[1])).toBe(200);
      // Another workspace of the account, and the account's own key.
      await c.open('mcpat_w2');
      await c.open('mcpat_op');
      await c.open('mcpat_op');
      expect(await sessions(url)).toBe(5);
      // Taken from the cached acceptance this time, the workspace included:
      // w1a's own idle session makes the room.
      const again = await c.open('mcpat_w1a');
      expect(await sessions(url)).toBe(5);
      expect(await c.list('mcpat_w1a', held[0])).toBe(404);
      expect(await c.list('mcpat_w1a', again)).toBe(200);
    } finally {
      await stop(server);
    }
  });

  it('holds a workspace-scoped key to its operator’s account ceiling as well', async () => {
    p = platform();
    p.key('acc-a', null, 'mcpat_op');
    p.key('acc-a', ws('ws-2'), 'mcpat_w2');
    p.key('acc-a', ws('ws-4'), 'mcpat_w4');
    p.key('acc-a', ws('ws-3'), 'mcpat_w3');
    const { server, url } = await start({ maxSessions: 32 });
    try {
      const c = client(url);
      for (let i = 0; i < 4; i++) await c.open('mcpat_op');
      for (let i = 0; i < 2; i++) await c.open('mcpat_w2');
      for (let i = 0; i < 2; i++) await c.open('mcpat_w4');
      // ws-3 holds nothing, so its sub-ceiling has room; its account has none.
      const over = await refusal(await c.send(INIT, as('mcpat_w3')));
      expect(over).toEqual({
        status: 429,
        retryAfter: '30',
        session: null,
        message: accountFull(8),
      });
      expect(await sessions(url)).toBe(8);
    } finally {
      await stop(server);
    }
  });

  it('makes room at the sub-ceiling from the key’s own idle session, or a refused key’s, never another live key’s', async () => {
    p = platform();
    p.key('acc-a', ws('ws-1'), 'mcpat_w1a', 'mcpat_w1b');
    const { server, url } = await start({
      maxSessions: 32,
      maxSessionsPerBearer: 16,
      bearerCheckTtlMs: 0,
    });
    try {
      const c = client(url);
      const first = await c.open('mcpat_w1a');
      await new Promise((r) => setTimeout(r, 5));
      const other = await c.open('mcpat_w1b');
      // At the sub-ceiling: w1a's own idle session makes the room, and w1b's
      // live one, older or not, is never closed for it.
      const again = await c.open('mcpat_w1a');
      expect(await sessions(url)).toBe(2);
      expect(await c.list('mcpat_w1a', first)).toBe(404);
      expect(await c.list('mcpat_w1b', other)).toBe(200);
      expect(await c.list('mcpat_w1a', again)).toBe(200);

      // w1b's token is refused: its idle session goes first, before w1a's own.
      delete p.accounts.mcpat_w1b;
      p.refused.add('mcpat_w1b');
      expect(await c.list('mcpat_w1b', other)).toBe(401);
      const fresh = await c.open('mcpat_w1a');
      expect(await sessions(url)).toBe(2);
      expect(await c.list('mcpat_w1b', other)).toBe(404);
      expect(await c.list('mcpat_w1a', again)).toBe(200);
      expect(await c.list('mcpat_w1a', fresh)).toBe(200);
    } finally {
      await stop(server);
    }
  });

  // One key per session throughout, from here on: a key's own idle session
  // would otherwise make the room.
  // A refused key's idle session makes room only for the limits it counts
  // against: one in another workspace frees nothing in this one.
  it('never closes a session of another workspace to make room in this one', async () => {
    p = platform();
    p.key('acc-a', ws('ws-2'), 'mcpat_gone');
    p.key('acc-a', ws('ws-1'), 'mcpat_w1', 'mcpat_w2', 'mcpat_w3');
    const { server, url } = await start({ maxSessions: 32, bearerCheckTtlMs: 0 });
    try {
      const c = client(url);
      const gone = await c.open('mcpat_gone');
      await c.open('mcpat_w1');
      await c.open('mcpat_w2');
      delete p.accounts.mcpat_gone;
      p.refused.add('mcpat_gone');
      expect(await c.list('mcpat_gone', gone)).toBe(401);
      expect(await refusal(await c.send(INIT, as('mcpat_w3')))).toMatchObject({
        status: 429,
        message: workspaceFull(2),
      });
      expect(await sessions(url)).toBe(3);
      expect(await c.list('mcpat_gone', gone)).toBe(401);
    } finally {
      await stop(server);
    }
  });

  it('keeps the same workspace id under two accounts apart', async () => {
    p = platform();
    p.key('acc-a', ws('ws-1'), 'mcpat_x1', 'mcpat_x2', 'mcpat_x3');
    p.key('acc-b', ws('ws-1'), 'mcpat_y1', 'mcpat_y2', 'mcpat_y3');
    const { server, url } = await start({ maxSessions: 32 });
    try {
      const c = client(url);
      await c.open('mcpat_x1');
      await c.open('mcpat_x2');
      await c.open('mcpat_y1');
      await c.open('mcpat_y2');
      expect(await sessions(url)).toBe(4);
      expect(await refusal(await c.send(INIT, as('mcpat_x3')))).toMatchObject({
        status: 429,
        message: workspaceFull(2),
      });
      expect(await refusal(await c.send(INIT, as('mcpat_y3')))).toMatchObject({
        status: 429,
        message: workspaceFull(2),
      });
    } finally {
      await stop(server);
    }
  });

  it('reads a malformed workspace as none, and a well-formed one as a workspace', async () => {
    p = platform();
    const malformed: Array<[string, unknown]> = [
      ['mcpat_empty', { id: '' }],
      ['mcpat_number', { id: 5 }],
      ['mcpat_long', { id: 'w'.repeat(257) }],
      ['mcpat_string', 'ws-1'],
      ['mcpat_noid', { name: 'ws-1' }],
    ];
    // Each its own account with three keys, so only a sub-ceiling of 2 could
    // refuse a third.
    const keys = (token: string) => [0, 1, 2].map((i) => `${token}${i}`);
    for (const [token, value] of malformed) p.key(`acc-${token}`, value, ...keys(token));
    p.key('acc-long-ok', { id: 'w'.repeat(256) }, ...keys('mcpat_long_ok'));
    const { server, url } = await start({ maxSessions: 32 });
    try {
      const c = client(url);
      for (const [token] of malformed) {
        for (const k of keys(token)) await c.open(k);
      }
      expect(await sessions(url)).toBe(15);
      await c.open('mcpat_long_ok0');
      await c.open('mcpat_long_ok1');
      expect(await refusal(await c.send(INIT, as('mcpat_long_ok2')))).toMatchObject({
        status: 429,
        message: workspaceFull(2),
      });
    } finally {
      await stop(server);
    }
  });

  it('never lets concurrent initializes across a workspace’s keys pass its sub-ceiling', async () => {
    p = platform();
    const tokens = ['mcpat_c0', 'mcpat_c1', 'mcpat_c2', 'mcpat_c3'];
    p.key('acc-c', ws('ws-1'), ...tokens);
    const { server, url } = await start({ maxSessions: 32 });
    try {
      const { held, early, all } = await burst(url, tokens);
      expect(held).toBe(2);
      expect(early).toEqual([
        { status: 429, message: workspaceFull(2) },
        { status: 429, message: workspaceFull(2) },
      ]);
      expect(all).toEqual([200, 200, 429, 429]);
      expect(await sessions(url)).toBe(2);
    } finally {
      await stop(server);
    }
  });

  // The room an initialize plans is made only once its session exists. When
  // the sub-ceiling is the limit that binds and the idle session it planned
  // to close is put to work in between, the new one is dropped at birth (404)
  // rather than admitted over the sub-ceiling, and nothing is closed.
  it('drops at birth an initialize whose planned room under the sub-ceiling was put to work', async () => {
    p = platform();
    p.key('acc-l', ws('ws-1'), 'mcpat_l1', 'mcpat_l2');
    const { server, url } = await start({
      maxSessions: 32,
      maxSessionsPerBearer: 16,
      bearerCheckTtlMs: 0,
    });
    let hold: ReturnType<typeof holdInitializes> | undefined;
    let release = () => {};
    try {
      const c = client(url);
      const first = await c.open('mcpat_l1');
      const other = await c.open('mcpat_l2');
      hold = holdInitializes();
      // Under its own cap and its account's, at its workspace's: admitted to
      // replace its own idle session, and held before its session exists.
      const late = c.send(INIT, as('mcpat_l1'));
      const deadline = Date.now() + 5000;
      while (hold.held.count === 0) {
        if (Date.now() > deadline) throw new Error('the initialize never reached the transport');
        await new Promise((r) => setTimeout(r, 5));
      }
      // The planned session is put to work: its request waits on its probe.
      release = p.hold('mcpat_l1');
      const before = p.whoamis();
      const busy = c.send(LIST, as('mcpat_l1', first));
      await p.reached(before);

      hold.open();
      const dropped = await late;
      expect(dropped.status).toBe(404);
      expect(dropped.headers.get('mcp-session-id')).toBeNull();
      await dropped.text();
      expect(await sessions(url)).toBe(2);
      release();
      const done = await busy;
      expect(done.status).toBe(200);
      await done.text();
      expect(await c.list('mcpat_l1', first)).toBe(200);
      expect(await c.list('mcpat_l2', other)).toBe(200);
    } finally {
      release();
      hold?.restore();
      await stop(server);
    }
  });

  it('honours an explicit sub-ceiling, clamps it to the account’s, and follows the account’s by default', async () => {
    p = platform();
    const tokens = Array.from({ length: 5 }, (_, i) => `mcpat_w${i}`);
    p.key('acc-a', ws('ws-1'), ...tokens);
    /** Open `n` sessions on as many keys, and try one more on another. */
    const opened = async (cfg: Partial<Parameters<typeof runHttp>[0]>, n: number) => {
      const { server, url } = await start({ maxSessions: 32, ...cfg });
      try {
        const c = client(url);
        for (let i = 0; i < n; i++) await c.open(tokens[i]);
        return await refusal(await c.send(INIT, as(tokens[n])));
      } finally {
        await stop(server);
      }
    };
    // Explicit.
    expect(await opened({ maxSessionsPerWorkspace: 3 }, 3)).toMatchObject({
      status: 429,
      message: workspaceFull(3),
    });
    // Above the account's ceiling of 2, it is 2: the workspace's limit is
    // the one named, as it is when both are met.
    expect(await opened({ maxSessionsPerAccount: 2, maxSessionsPerWorkspace: 5 }, 2)).toMatchObject(
      { status: 429, message: workspaceFull(2) },
    );
    // Unusable: the default, a quarter of the account's 8.
    for (const bad of [Number.NaN, 0, -1]) {
      expect(await opened({ maxSessionsPerWorkspace: bad }, 2), String(bad)).toMatchObject({
        status: 429,
        message: workspaceFull(2),
      });
    }
    // The default follows an explicit account ceiling: a quarter of 16.
    expect(await opened({ maxSessionsPerAccount: 16 }, 4)).toMatchObject({
      status: 429,
      message: workspaceFull(4),
    });
  });
});
