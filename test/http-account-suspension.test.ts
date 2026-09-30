import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runHttp } from '../src/http.js';
import { BASE, installFakePlatform, WHOAMI } from './harness.js';

// OPL-5452: a suspended account holds ONE hosted session in all, across every
// key and token it holds. It used to be one per bearer (OPL-5443/5448), so an
// account with N keys kept N sessions. Each test below is one sequence from
// the review history of the earlier attempts (mcp#159, mcp#160).

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
/** A request that reaches the platform (`GET whoami`), so a gate can hold it. */
const WHOAMI_CALL = {
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'whoami', arguments: {} },
};
const NOTE = { jsonrpc: '2.0', method: 'notifications/initialized' };

const SUSPENDED_FULL =
  'This account is suspended, so it may hold only 1 session on this server across all its tokens, and none it holds is idle. Retry once its session finishes its request, or close it (DELETE /mcp).';

type Standing = 'active' | 'suspended';

/**
 * The platform, as far as these tests need it: per token, the account its
 * whoami names and that account's status, READ WHEN THE REQUEST ARRIVES (so a
 * held probe answers with what was true when it was sent); per token, a gate
 * its whoami requests wait on; and tokens refused with a 401.
 */
function platform() {
  const base = installFakePlatform();
  const fake = globalThis.fetch;
  const accounts: Record<string, { id: string; status: Standing }> = {};
  const gates = new Map<string, Promise<void>>();
  const refused = new Set<string>();
  /** Per token, how many whoami requests have arrived. */
  const whoamis = new Map<string, number>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.host !== new URL(BASE).host) return fake(input as never, init);
    const token = (new Headers(init?.headers ?? {}).get('authorization') ?? '').replace(
      /^Bearer /,
      '',
    );
    const isWhoami = url.pathname.endsWith('/whoami');
    const named = accounts[token] ? { ...accounts[token] } : undefined;
    if (isWhoami) whoamis.set(token, (whoamis.get(token) ?? 0) + 1);
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
    if (isWhoami && named) {
      return new Response(
        JSON.stringify({ ...WHOAMI, account: { ...WHOAMI.account, name: named.id, ...named } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return fake(input as never, init);
  }) as typeof fetch;

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
  /** Resolve once `token` has sent more whoami requests than `before`. */
  const reached = async (token: string, before: number) => {
    const deadline = Date.now() + 5000;
    while ((whoamis.get(token) ?? 0) <= before) {
      if (Date.now() > deadline) throw new Error(`${token}'s whoami never reached the platform`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const count = (token: string) => whoamis.get(token) ?? 0;
  /** Name `tokens` as keys of one account with this status. */
  const set = (id: string, status: Standing, ...tokens: string[]) => {
    for (const t of tokens) accounts[t] = { id, status };
  };
  return {
    accounts,
    refused,
    hold,
    reached,
    count,
    set,
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
    expect(res.status).toBe(200);
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

describe('hosted: a suspended account holds one session across all its keys', () => {
  let p: ReturnType<typeof platform>;
  afterEach(() => p.restore());

  // Two keys of one suspended account: the second key's initialize is
  // refused while the account's one session is busy, and takes it over once
  // it is idle. Never two.
  it('refuses a second key while the one session is busy, and takes it over once idle', async () => {
    p = platform();
    p.set('acc-s', 'suspended', 'mcpat_k1', 'mcpat_k2');
    const { server, url } = await start();
    const c = client(url);
    let release = () => {};
    try {
      const s1 = await c.open('mcpat_k1');
      release = p.hold('mcpat_k1');
      const before = p.count('mcpat_k1');
      const busy = c.send(WHOAMI_CALL, as('mcpat_k1', s1));
      await p.reached('mcpat_k1', before);

      const refused = await c.send(INIT, as('mcpat_k2'));
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('30');
      expect(refused.headers.get('mcp-session-id')).toBeNull();
      expect(await message(refused)).toBe(SUSPENDED_FULL);
      expect(await sessions(url)).toBe(1);

      release();
      const answered = await busy;
      expect(answered.status).toBe(200);
      await answered.text();

      const s2 = await c.open('mcpat_k2');
      expect(await sessions(url)).toBe(1);
      expect(await c.list('mcpat_k1', s1)).toBe(404);
      expect(await c.list('mcpat_k2', s2)).toBe(200);
    } finally {
      release();
      await stop(server);
    }
  });

  // Probe ordering: A's probe starts first and says suspended, B's starts
  // later and says active, and A's answers last. The newest-started answer
  // stands, so the account is active and A is not held to one.
  it('keeps the newer-started active answer over an older suspended one that finishes last', async () => {
    p = platform();
    p.set('acc-o', 'suspended', 'mcpat_a');
    p.set('acc-o', 'active', 'mcpat_b');
    const { server, url } = await start();
    const c = client(url);
    let release = () => {};
    try {
      release = p.hold('mcpat_a');
      const before = p.count('mcpat_a');
      const late = c.send(INIT, as('mcpat_a'));
      await p.reached('mcpat_a', before);
      // Reinstated since A's probe was sent; B's probe says so and answers first.
      p.set('acc-o', 'active', 'mcpat_a');
      const b1 = await c.open('mcpat_b');
      release();
      const first = await late;
      expect(first.status).toBe(200);
      await first.text();
      const a1 = first.headers.get('mcp-session-id') as string;

      // A's acceptance is cached; the account's standing is read, not A's answer.
      const a2 = await c.open('mcpat_a');
      expect(await sessions(url)).toBe(3);
      for (const [token, session] of [
        ['mcpat_b', b1],
        ['mcpat_a', a1],
        ['mcpat_a', a2],
      ]) {
        expect(await c.list(token, session)).toBe(200);
      }
    } finally {
      release();
      await stop(server);
    }
  });

  // The reverse: an older-started active answer arriving last cannot undo a
  // newer suspended one.
  it('keeps the newer-started suspended answer over an older active one that finishes last', async () => {
    p = platform();
    p.set('acc-p', 'active', 'mcpat_a');
    p.set('acc-p', 'suspended', 'mcpat_b');
    const { server, url } = await start();
    const c = client(url);
    let release = () => {};
    try {
      release = p.hold('mcpat_a');
      const before = p.count('mcpat_a');
      const late = c.send(INIT, as('mcpat_a'));
      await p.reached('mcpat_a', before);
      const b1 = await c.open('mcpat_b');
      release();
      const first = await late;
      expect(first.status).toBe(200);
      await first.text();
      const a1 = first.headers.get('mcp-session-id') as string;
      // Held to one in all: A's initialize took over B's idle session.
      expect(await sessions(url)).toBe(1);
      expect(await c.list('mcpat_b', b1)).toBe(404);

      const a2 = await c.open('mcpat_a');
      expect(await sessions(url)).toBe(1);
      expect(await c.list('mcpat_a', a1)).toBe(404);
      expect(await c.list('mcpat_a', a2)).toBe(200);
    } finally {
      release();
      await stop(server);
    }
  });

  // A key whose own cached acceptance said active, while another key's newer
  // probe says the account is suspended: the account is held.
  it('holds the account when another key’s newer probe finds it suspended', async () => {
    p = platform();
    p.set('acc-c', 'active', 'mcpat_k1', 'mcpat_k2', 'mcpat_k3');
    const { server, url } = await start();
    const c = client(url);
    try {
      const s1 = await c.open('mcpat_k1');
      const s2 = await c.open('mcpat_k2');
      p.set('acc-c', 'suspended', 'mcpat_k1', 'mcpat_k2', 'mcpat_k3');

      const s3 = await c.open('mcpat_k3');
      expect(await sessions(url)).toBe(1);
      // k1's cached acceptance is still good, and says nothing about standing.
      const again = await c.open('mcpat_k1');
      expect(await sessions(url)).toBe(1);
      expect(await c.list('mcpat_k1', again)).toBe(200);
      for (const [token, session] of [
        ['mcpat_k1', s1],
        ['mcpat_k2', s2],
        ['mcpat_k3', s3],
      ]) {
        expect(await c.list(token, session)).toBe(404);
      }
    } finally {
      await stop(server);
    }
  });

  // Traffic that carries no request asks the platform nothing, and an
  // account suspended while two of its sessions were busy kept both once they
  // were idle, for as long as its clients sent only notifications or held
  // their streams.
  for (const traffic of ['a notification', 'the event stream'] as const) {
    it(`holds the account to one session on ${traffic} alone`, async () => {
      p = platform();
      p.set('acc-n', 'active', 'mcpat_k1', 'mcpat_k2', 'mcpat_k3');
      const { server, url } = await start();
      const c = client(url);
      const releases: Array<() => void> = [];
      try {
        const s1 = await c.open('mcpat_k1');
        const s2 = await c.open('mcpat_k2');
        const busy: Array<Promise<Response>> = [];
        for (const [token, session] of [
          ['mcpat_k1', s1],
          ['mcpat_k2', s2],
        ]) {
          releases.push(p.hold(token));
          const before = p.count(token);
          busy.push(c.send(WHOAMI_CALL, as(token, session)));
          await p.reached(token, before);
        }
        p.set('acc-n', 'suspended', 'mcpat_k1', 'mcpat_k2', 'mcpat_k3');
        // Found suspended while both are busy: neither is closed.
        const refused = await c.send(INIT, as('mcpat_k3'));
        expect(refused.status).toBe(429);
        expect(await message(refused)).toBe(SUSPENDED_FULL);
        for (const r of releases) r();
        for (const res of await Promise.all(busy)) {
          expect(res.status).toBe(200);
          await res.text();
        }
        expect(await sessions(url)).toBe(2);

        if (traffic === 'a notification') {
          const res = await c.send(NOTE, as('mcpat_k1', s1));
          expect(res.status).toBe(202);
          await res.text();
        } else {
          const abort = new AbortController();
          const res = await fetch(url, {
            headers: { Accept: 'text/event-stream', ...as('mcpat_k1', s1) },
            signal: abort.signal,
          });
          expect(res.status).toBe(200);
          abort.abort();
          await res.body?.cancel().catch(() => {});
        }
        expect(await sessions(url)).toBe(1);
        expect(await c.list('mcpat_k2', s2)).toBe(404);
        expect(await c.list('mcpat_k1', s1)).toBe(200);
      } finally {
        for (const r of releases) r();
        await stop(server);
      }
    });
  }

  // The other side of the same rule: traffic that asks the platform nothing
  // acts on the account's standing only while its own token's acceptance is
  // cached. Past that the standing may predate a reinstatement nobody has
  // asked about since, so it closes nothing; the next request asks.
  for (const traffic of ['a notification', 'the event stream'] as const) {
    it(`does not act on a standing older than the token’s lapsed acceptance on ${traffic}`, async () => {
      p = platform();
      p.set('acc-g', 'active', 'mcpat_k1', 'mcpat_k2', 'mcpat_k3');
      const { server, url } = await start({ bearerCheckTtlMs: 300 });
      const c = client(url);
      const releases: Array<() => void> = [];
      try {
        const s1 = await c.open('mcpat_k1');
        const s2 = await c.open('mcpat_k2');
        const busy: Array<Promise<Response>> = [];
        for (const [token, session] of [
          ['mcpat_k1', s1],
          ['mcpat_k2', s2],
        ]) {
          releases.push(p.hold(token));
          const before = p.count(token);
          busy.push(c.send(WHOAMI_CALL, as(token, session)));
          await p.reached(token, before);
        }
        p.set('acc-g', 'suspended', 'mcpat_k1', 'mcpat_k2', 'mcpat_k3');
        const refused = await c.send(INIT, as('mcpat_k3'));
        expect(refused.status).toBe(429);
        await refused.text();
        for (const r of releases) r();
        for (const res of await Promise.all(busy)) await res.text();
        // Reinstated, and every acceptance lapses with nobody asking.
        p.set('acc-g', 'active', 'mcpat_k1', 'mcpat_k2', 'mcpat_k3');
        await new Promise((r) => setTimeout(r, 400));

        if (traffic === 'a notification') {
          const note = await c.send(NOTE, as('mcpat_k1', s1));
          expect(note.status).toBe(202);
          await note.text();
        } else {
          const abort = new AbortController();
          const res = await fetch(url, {
            headers: { Accept: 'text/event-stream', ...as('mcpat_k1', s1) },
            signal: abort.signal,
          });
          expect(res.status).toBe(200);
          abort.abort();
          await res.body?.cancel().catch(() => {});
        }
        expect(await sessions(url)).toBe(2);
        // A request asks, finds the account active, and closes nothing.
        expect(await c.list('mcpat_k1', s1)).toBe(200);
        expect(await c.list('mcpat_k2', s2)).toBe(200);
        expect(await sessions(url)).toBe(2);
      } finally {
        for (const r of releases) r();
        await stop(server);
      }
    });
  }

  // An OAuth refresh: the old token's session is left behind idle, and the
  // new token's initialize takes the one slot over rather than being refused
  // until the old session idles out.
  it('gives the old token’s idle session up to a refreshed token’s initialize', async () => {
    p = platform();
    p.set('acc-r', 'suspended', 'mcpat_old', 'mcpat_new');
    const { server, url } = await start();
    const c = client(url);
    try {
      const old = await c.open('mcpat_old');
      delete p.accounts.mcpat_old;
      p.refused.add('mcpat_old');
      // The old session answers the new token as unknown, and it initializes.
      expect(await c.list('mcpat_new', old)).toBe(404);
      const fresh = await c.open('mcpat_new');
      expect(await sessions(url)).toBe(1);
      expect(await c.list('mcpat_new', fresh)).toBe(200);
      const gone = await c.send(undefined, as('mcpat_old', old), 'DELETE');
      expect(gone.status).toBe(404);
      await gone.text();
    } finally {
      await stop(server);
    }
  });

  // Which session keeps the slot: a session whose token the platform has
  // refused is closed before a live one, even when the live one is older.
  // The initialize here is refused by the SDK (406) after its admission, so
  // only the admission's trim closes anything and the one left can be seen.
  it('closes a refused token’s session before an older live one', async () => {
    p = platform();
    p.set('acc-q', 'active', 'mcpat_live', 'mcpat_dead', 'mcpat_new');
    // Every request probes, so the revoked token is found refused at once.
    const { server, url } = await start({ bearerCheckTtlMs: 0 });
    const c = client(url);
    try {
      const live = await c.open('mcpat_live');
      await new Promise((r) => setTimeout(r, 5));
      const dead = await c.open('mcpat_dead');
      delete p.accounts.mcpat_dead;
      p.refused.add('mcpat_dead');
      expect(await c.list('mcpat_dead', dead)).toBe(401);
      p.set('acc-q', 'suspended', 'mcpat_live', 'mcpat_new');

      const res = await c.send(INIT, { ...as('mcpat_new'), Accept: 'application/json' });
      expect(res.status).toBe(406);
      await res.text();
      expect(await sessions(url)).toBe(1);
      expect(await c.list('mcpat_live', live)).toBe(200);
      expect(await c.list('mcpat_dead', dead)).toBe(404);
    } finally {
      await stop(server);
    }
  });

  // Un-suspension: a newer probe that finds the account active lifts the
  // hold at once for every key, including one whose cached acceptance was
  // taken while the account was suspended (mcp#160 review round 3: a cached
  // suspended answer outlived a newer active one and trimmed the account).
  it('lifts the hold for every key once a newer probe finds the account active', async () => {
    p = platform();
    p.set('acc-u', 'suspended', 'mcpat_k1', 'mcpat_k2');
    const { server, url } = await start();
    const c = client(url);
    try {
      const a1 = await c.open('mcpat_k1');
      p.set('acc-u', 'active', 'mcpat_k1', 'mcpat_k2');
      const c1 = await c.open('mcpat_k2');
      const c2 = await c.open('mcpat_k2');
      expect(await sessions(url)).toBe(3);
      // k1's acceptance was cached while suspended; a request on it trims nothing.
      expect(await c.list('mcpat_k1', a1)).toBe(200);
      expect(await sessions(url)).toBe(3);
      const a2 = await c.open('mcpat_k1');
      expect(await sessions(url)).toBe(4);
      for (const [token, session] of [
        ['mcpat_k1', a1],
        ['mcpat_k1', a2],
        ['mcpat_k2', c1],
        ['mcpat_k2', c2],
      ]) {
        expect(await c.list(token, session)).toBe(200);
      }
    } finally {
      await stop(server);
    }
  });

  // The room an initialize planned is made only once its session exists, and
  // the standing is read again then: an answer that came in between is the
  // newer word, so a reinstatement meanwhile closes nothing of the account's.
  it('reads the standing again when a held initialize lands', async () => {
    p = platform();
    p.set('acc-l', 'active', 'mcpat_a', 'mcpat_b', 'mcpat_c');
    const { server, url } = await start();
    const c = client(url);
    const original = StreamableHTTPServerTransport.prototype.handleRequest;
    let open = () => {};
    try {
      const b1 = await c.open('mcpat_b');
      // Hold the next initialize (only that one) before its session exists.
      const gate = new Promise<void>((r) => {
        open = r;
      });
      let held = 0;
      StreamableHTTPServerTransport.prototype.handleRequest = async function (...args) {
        if (!this.sessionId && held++ === 0) await gate;
        return original.apply(this, args);
      };
      p.set('acc-l', 'suspended', 'mcpat_a');
      // Admitted suspended, planning to take b1 over, and held.
      const late = c.send(INIT, as('mcpat_a'));
      const deadline = Date.now() + 5000;
      while (held === 0) {
        if (Date.now() > deadline) throw new Error('the initialize never reached the transport');
        await new Promise((r) => setTimeout(r, 5));
      }
      // Reinstated: a newer probe says so before the held one lands.
      const c1 = await c.open('mcpat_c');
      open();
      const landed = await late;
      expect(landed.status).toBe(200);
      await landed.text();
      const a1 = landed.headers.get('mcp-session-id') as string;
      expect(await sessions(url)).toBe(3);
      for (const [token, session] of [
        ['mcpat_a', a1],
        ['mcpat_b', b1],
        ['mcpat_c', c1],
      ]) {
        expect(await c.list(token, session)).toBe(200);
      }
    } finally {
      open();
      StreamableHTTPServerTransport.prototype.handleRequest = original;
      await stop(server);
    }
  });

  // A token whose whoami named no account counts its sessions against itself
  // (a `bearer:` bucket). When the platform later names its account, and
  // that account is suspended, a request on one of its sessions holds the
  // token to one there and then, although the sessions stay in the bucket
  // they were admitted under (mcp#166 review round 2).
  it('holds a token to one session once the platform names its suspended account', async () => {
    p = platform();
    p.accounts.mcpat_m = { id: '', status: 'active' };
    const { server, url } = await start({ bearerCheckTtlMs: 0 });
    const c = client(url);
    try {
      const s1 = await c.open('mcpat_m');
      const s2 = await c.open('mcpat_m');
      const s3 = await c.open('mcpat_m');
      expect(await sessions(url)).toBe(3);
      p.set('acc-x', 'suspended', 'mcpat_m');
      expect(await c.list('mcpat_m', s1)).toBe(200);
      expect(await sessions(url)).toBe(1);
      expect(await c.list('mcpat_m', s2)).toBe(404);
      expect(await c.list('mcpat_m', s3)).toBe(404);
      expect(await c.list('mcpat_m', s1)).toBe(200);
    } finally {
      await stop(server);
    }
  });

  // The same, with the probes crossing: the token's probe is sent while the
  // account is suspended and answers last, after a newer-started probe of
  // another of its tokens found it reinstated. The newer answer stands, so
  // the token keeps every session.
  it('keeps a newly named account’s sessions when a newer probe found it active', async () => {
    p = platform();
    p.accounts.mcpat_m = { id: '', status: 'active' };
    const { server, url } = await start({ bearerCheckTtlMs: 0 });
    const c = client(url);
    let release = () => {};
    try {
      const s1 = await c.open('mcpat_m');
      const s2 = await c.open('mcpat_m');
      const s3 = await c.open('mcpat_m');
      p.set('acc-x', 'suspended', 'mcpat_m');
      release = p.hold('mcpat_m');
      const before = p.count('mcpat_m');
      const late = c.send(LIST, as('mcpat_m', s1));
      await p.reached('mcpat_m', before);
      p.set('acc-x', 'active', 'mcpat_m', 'mcpat_n');
      const n1 = await c.open('mcpat_n');
      release();
      const answered = await late;
      expect(answered.status).toBe(200);
      await answered.text();
      expect(await sessions(url)).toBe(4);
      for (const [token, session] of [
        ['mcpat_m', s1],
        ['mcpat_m', s2],
        ['mcpat_m', s3],
        ['mcpat_n', n1],
      ]) {
        expect(await c.list(token, session)).toBe(200);
      }
    } finally {
      release();
      await stop(server);
    }
  });

  // A self-hosted server asks the platform nothing, so nothing is suspended
  // there, whatever whoami would say: every limit stays per bearer.
  it('leaves a self-hosted server’s limits per bearer', async () => {
    p = platform();
    p.set('acc-h', 'suspended', 'com_one', 'com_two');
    const server = await runHttp({ port: 0, host: '127.0.0.1', baseUrl: BASE });
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/mcp`;
    const c = client(url);
    try {
      for (const token of ['com_one', 'com_one', 'com_two', 'com_two']) await c.open(token);
      expect(await sessions(url)).toBe(4);
      expect(p.count('com_one') + p.count('com_two')).toBe(0);
    } finally {
      await stop(server);
    }
  });
});
