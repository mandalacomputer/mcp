import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Api, SERVICE_HEADER } from '../src/api.js';
import { bearerChallenge, runHttp } from '../src/http.js';
import { BASE, installFakePlatform, WHOAMI } from './harness.js';

// The hosted install (OPL-4982): an HTTP server in front of the platform whose
// callers are OAuth clients. What is pinned here is what those clients act on —
// the 401 and its header — and what the platform is sent on their behalf.

const METADATA = 'https://app.mandala.computer/.well-known/oauth-protected-resource/mcp';
const CHALLENGE =
  'Bearer resource_metadata="https://app.mandala.computer/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"';
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
const ACCOUNT = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'get_account', arguments: {} },
};

/**
 * The fake platform, with the two refusals this file needs in front of it:
 * a bearer the platform has stopped accepting (401 with a Bearer challenge, as
 * the API sends it), and a model provider's 401, which carries none.
 */
function platformWithRefusals() {
  const platform = installFakePlatform();
  const fake = globalThis.fetch;
  const refused = new Set<string>();
  const state: {
    providerRefuses: boolean;
    onlyAccept?: string;
    /** What `GET whoami`, the bearer probe, answers instead of its record. */
    probeStatus?: number;
    /** A suspended account: every route but `whoami` answers 403 (OPL-5437). */
    suspended?: boolean;
    probeDelayMs?: number;
    /** When set, every probe waits on this before answering. */
    probeGate?: Promise<void>;
    /**
     * Per token: the `account` its whoami names (OPL-5447). Read when the
     * probe ARRIVES, before any gate, so a gated probe answers with what was
     * true when it was sent.
     */
    accounts?: Record<string, Record<string, unknown>>;
    /** Per token: a gate that token's probes wait on. */
    probeGates?: Map<string, Promise<void>>;
  } = { providerRefuses: false };
  /** Tokens refused on `GET account` only, after a delay in ms. */
  const slowRefusals = new Map<string, number>();
  /** Headers of every request that reached the platform, lower-cased. */
  const seen: Array<Record<string, string>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.host !== new URL(BASE).host) return fake(input as never, init);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });
    seen.push(headers);
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    const named = url.pathname.endsWith('/whoami') ? state.accounts?.[token] : undefined;
    const record = named ? { ...WHOAMI, account: { ...named } } : undefined;
    const gate = url.pathname.endsWith('/whoami') ? state.probeGates?.get(token) : undefined;
    if (gate) await gate;
    if (record) {
      return new Response(JSON.stringify(record), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/whoami') && state.probeGate) await state.probeGate;
    if (url.pathname.endsWith('/whoami') && state.probeDelayMs) {
      await new Promise((r) => setTimeout(r, state.probeDelayMs));
    }
    if (state.suspended && !url.pathname.endsWith('/whoami')) {
      return new Response(JSON.stringify({ error: 'account suspended', reason: 'revoked' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/whoami') && state.probeStatus !== undefined) {
      return new Response(JSON.stringify({ error: 'refused' }), {
        status: state.probeStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const slow = slowRefusals.get(token);
    if (slow !== undefined && url.pathname.endsWith('/account')) {
      await new Promise((r) => setTimeout(r, slow));
      refused.add(token);
    }
    if (refused.has(token) || (state.onlyAccept !== undefined && token !== state.onlyAccept)) {
      return new Response(
        JSON.stringify({ error: 'invalid or expired access token', reason: 'invalid' }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer error="invalid_token"',
          },
        },
      );
    }
    if (state.providerRefuses) {
      return new Response(JSON.stringify({ error: { type: 'authentication_error' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // A suspended account's whoami says so, as the platform's does.
    if (state.suspended && url.pathname.endsWith('/whoami')) {
      return new Response(
        JSON.stringify({ ...WHOAMI, account: { ...WHOAMI.account, status: 'suspended' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return fake(input as never, init);
  }) as typeof fetch;
  return {
    refused,
    state,
    slowRefusals,
    seen,
    restore: () => {
      globalThis.fetch = fake;
      platform.restore();
    },
  };
}

async function start(extra: Partial<Parameters<typeof runHttp>[0]>) {
  const server = await runHttp({ port: 0, host: '127.0.0.1', baseUrl: BASE, ...extra });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/mcp` };
}

const stop = (server: Server) => new Promise<void>((r) => server.close(() => r()));

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
  const open = async (token: string, headers: Record<string, string> = {}) => {
    const res = await send(INIT, { Authorization: `Bearer ${token}`, ...headers });
    expect(res.status).toBe(200);
    await res.text();
    return res.headers.get('mcp-session-id') as string;
  };
  return { send, open };
}

/** The JSON-RPC messages in an SSE or JSON answer. */
async function messages(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    return [JSON.parse(text)];
  }
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

it('builds the challenge an MCP client reads, exactly', () => {
  expect(bearerChallenge(METADATA)).toBe(CHALLENGE);
});

describe('hosted: a request with no bearer', () => {
  let platform: ReturnType<typeof platformWithRefusals>;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    platform = platformWithRefusals();
    ({ server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET }));
  });
  afterAll(async () => {
    platform.restore();
    await stop(server);
  });

  it('is a 401 carrying the challenge, on initialize', async () => {
    const res = await client(url).send(INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    const body = (await res.json()) as { jsonrpc: string; id: unknown };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
  });

  it('is a 401 on tools/list too, with or without a session id', async () => {
    const c = client(url);
    const bare = await c.send(LIST);
    expect(bare.status).toBe(401);
    expect(bare.headers.get('www-authenticate')).toBe(CHALLENGE);

    const session = await c.open('mcpat_alice');
    const res = await c.send(LIST, { 'mcp-session-id': session });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
  });

  it('is a 401 on the event stream and on DELETE', async () => {
    const c = client(url);
    const session = await c.open('mcpat_alice');
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await c.send(undefined, { 'mcp-session-id': session }, method);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
      await res.text();
    }
  });

  it('leaves /healthz open', async () => {
    const res = await fetch(url.replace(/\/mcp$/, '/healthz'));
    expect(res.status).toBe(200);
  });
});

describe('not hosted: the metadata URL unset', () => {
  let platform: ReturnType<typeof platformWithRefusals>;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    platform = platformWithRefusals();
    ({ server, url } = await start({}));
  });
  afterAll(async () => {
    platform.restore();
    await stop(server);
  });
  afterEach(() => {
    platform.refused.clear();
    platform.seen.length = 0;
  });

  it('refuses a missing key as before, with no challenge', async () => {
    const res = await client(url).send(INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      'Bearer',
    );
  });

  it('still answers a second key on a session with 401, not 404', async () => {
    const c = client(url);
    const session = await c.open('com_alice');
    const res = await c.send(LIST, {
      Authorization: 'Bearer com_mallory',
      'mcp-session-id': session,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('keeps a refused key a tool error inside a 200', async () => {
    const c = client(url);
    const session = await c.open('com_alice');
    platform.refused.add('com_alice');
    const res = await c.send(ACCOUNT, {
      Authorization: 'Bearer com_alice',
      'mcp-session-id': session,
    });
    expect(res.status).toBe(200);
    const [msg] = await messages(res);
    expect((msg.result as { isError?: boolean }).isError).toBe(true);
  });

  it('sends no service header, and forwards none a client sent', async () => {
    const c = client(url);
    const session = await c.open('com_alice', { [SERVICE_HEADER]: 'forged' });
    const res = await c.send(ACCOUNT, {
      Authorization: 'Bearer com_alice',
      'mcp-session-id': session,
      [SERVICE_HEADER]: 'forged',
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(platform.seen.length).toBeGreaterThan(0);
    for (const h of platform.seen) expect(h['x-mandala-mcp-service']).toBeUndefined();
  });
});

describe('hosted: the platform and the bearer', () => {
  let platform: ReturnType<typeof platformWithRefusals>;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    platform = platformWithRefusals();
    ({ server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET }));
  });
  afterAll(async () => {
    platform.restore();
    await stop(server);
  });
  afterEach(() => {
    platform.refused.clear();
    platform.state.providerRefuses = false;
    platform.seen.length = 0;
  });

  it('sends the service secret with every platform request, never a client’s value', async () => {
    const c = client(url);
    const session = await c.open('mcpat_alice', { [SERVICE_HEADER]: 'forged' });
    const res = await c.send(ACCOUNT, {
      Authorization: 'Bearer mcpat_alice',
      'mcp-session-id': session,
      [SERVICE_HEADER]: 'forged',
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(platform.seen.length).toBeGreaterThan(0);
    for (const h of platform.seen) {
      expect(h['x-mandala-mcp-service']).toBe(SECRET);
      // Passed through unchanged.
      expect(h.authorization).toBe('Bearer mcpat_alice');
    }
  });

  it('turns a platform 401 into an HTTP 401 with the challenge, not a tool error', async () => {
    const c = client(url);
    const session = await c.open('mcpat_alice');
    platform.refused.add('mcpat_alice');
    const res = await c.send(ACCOUNT, {
      Authorization: 'Bearer mcpat_alice',
      'mcp-session-id': session,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    const body = (await res.json()) as { jsonrpc: string; id: unknown; error: unknown };
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 3 });

    // The session remembers: the same refused token is turned away before
    // anything reaches the platform.
    platform.seen.length = 0;
    const again = await c.send(ACCOUNT, {
      Authorization: 'Bearer mcpat_alice',
      'mcp-session-id': session,
    });
    expect(again.status).toBe(401);
    expect(again.headers.get('www-authenticate')).toBe(CHALLENGE);
    await again.text();
    expect(platform.seen).toHaveLength(0);
  });

  it('passes an answer with no body, a notification’s 202, through the hold unchanged', async () => {
    const c = client(url);
    const session = await c.open('mcpat_alice');
    const res = await c.send(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { Authorization: 'Bearer mcpat_alice', 'mcp-session-id': session },
    );
    expect(res.status).toBe(202);
    await res.text();
  });

  it('leaves a model provider’s 401, which challenges nobody, a tool error', async () => {
    const c = client(url);
    const session = await c.open('mcpat_alice');
    platform.state.providerRefuses = true;
    const res = await c.send(ACCOUNT, {
      Authorization: 'Bearer mcpat_alice',
      'mcp-session-id': session,
    });
    expect(res.status).toBe(200);
    const [msg] = await messages(res);
    expect((msg.result as { isError?: boolean }).isError).toBe(true);

    platform.state.providerRefuses = false;
    const next = await c.send(ACCOUNT, {
      Authorization: 'Bearer mcpat_alice',
      'mcp-session-id': session,
    });
    expect(next.status).toBe(200);
    await next.text();
  });

  it('answers a refreshed token on an old session as unknown, and serves it on a new one', async () => {
    const c = client(url);
    const old = await c.open('mcpat_before');
    platform.refused.add('mcpat_before');
    const refusedCall = await c.send(ACCOUNT, {
      Authorization: 'Bearer mcpat_before',
      'mcp-session-id': old,
    });
    expect(refusedCall.status).toBe(401);
    await refusedCall.text();

    // The client refreshed. The new bearer is not rebound onto the old
    // session: 404 is the spec's "initialize again".
    const stale = await c.send(ACCOUNT, {
      Authorization: 'Bearer mcpat_after',
      'mcp-session-id': old,
    });
    expect(stale.status).toBe(404);
    expect(stale.headers.get('www-authenticate')).toBeNull();
    await stale.text();

    const fresh = await c.open('mcpat_after');
    expect(fresh).not.toBe(old);
    const res = await c.send(ACCOUNT, {
      Authorization: 'Bearer mcpat_after',
      'mcp-session-id': fresh,
    });
    expect(res.status).toBe(200);
    const [msg] = await messages(res);
    expect((msg.result as { isError?: boolean }).isError).toBeFalsy();
  });

  it('never lets a different credential use another’s session', async () => {
    const c = client(url);
    const alice = await c.open('mcpat_alice');
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      const res = await c.send(
        ACCOUNT,
        { Authorization: 'Bearer mcpat_mallory', 'mcp-session-id': alice },
        method,
      );
      expect(res.status).toBe(404);
      await res.text();
    }
    // Nothing went to the platform under mallory's name, and alice's session
    // survived the attempt to DELETE it.
    expect(platform.seen.filter((h) => h.authorization === 'Bearer mcpat_mallory')).toHaveLength(0);
    const mine = await c.send(ACCOUNT, {
      Authorization: 'Bearer mcpat_alice',
      'mcp-session-id': alice,
    });
    expect(mine.status).toBe(200);
    await mine.text();
  });
});

describe('the hosted settings at startup', () => {
  it('refuses a metadata URL that is not an absolute http(s) URL', async () => {
    await expect(start({ resourceMetadataUrl: 'not a url' })).rejects.toThrow(
      /MANDALA_MCP_RESOURCE_METADATA_URL/,
    );
    await expect(start({ resourceMetadataUrl: 'ftp://x.example/meta' })).rejects.toThrow(
      /http\(s\)/,
    );
  });

  it('refuses a metadata URL that would break out of the quoted header value', async () => {
    await expect(start({ resourceMetadataUrl: 'https://x.example/"meta' })).rejects.toThrow(
      /quote/,
    );
  });

  it('refuses a secret that cannot be a header value, without echoing it', async () => {
    const err = await start({ serviceSecret: 'abc\ndef' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('MANDALA_MCP_SERVICE_SECRET');
    expect((err as Error).message).not.toContain('abc');
  });
});

describe('the Api client and the service header', () => {
  let platform: ReturnType<typeof platformWithRefusals>;
  beforeAll(() => {
    platform = platformWithRefusals();
  });
  afterAll(() => platform.restore());
  afterEach(() => {
    platform.seen.length = 0;
  });

  it('sends its own secret and drops a per-call header of that name, in any case', async () => {
    const api = new Api('com_key', BASE, undefined, { serviceSecret: SECRET });
    await api.json('GET', 'account', {
      headers: { 'x-mandala-mcp-service': 'forged', 'X-MANDALA-MCP-SERVICE': 'forged' },
    });
    expect(platform.seen).toHaveLength(1);
    expect(platform.seen[0]['x-mandala-mcp-service']).toBe(SECRET);
  });

  it('sends nothing extra without one, even when a call asks', async () => {
    const api = new Api('com_key', BASE);
    await api.json('GET', 'account', { headers: { [SERVICE_HEADER]: 'forged' } });
    expect(platform.seen).toHaveLength(1);
    expect(platform.seen[0]['x-mandala-mcp-service']).toBeUndefined();
  });

  it('keeps the secret on a client bound to a call’s signal', async () => {
    const api = new Api('com_key', BASE, undefined, { serviceSecret: SECRET });
    await api.with(new AbortController().signal).json('GET', 'account');
    expect(platform.seen[0]['x-mandala-mcp-service']).toBe(SECRET);
  });
});

describe('hosted: checking a bearer before it gets anything', () => {
  let platform: ReturnType<typeof platformWithRefusals>;
  afterEach(() => platform.restore());

  const sessions = async (url: string) =>
    ((await (await fetch(url.replace(/\/mcp$/, '/healthz'))).json()) as { sessions: number })
      .sessions;

  it('creates no session for invented bearers, however many, and still serves a real one', async () => {
    platform = platformWithRefusals();
    platform.state.onlyAccept = 'mcpat_good';
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxSessions: 3,
      maxFailedInitializes: 100,
    });
    try {
      const c = client(url);
      for (let i = 0; i < 6; i++) {
        const res = await c.send(INIT, { Authorization: `Bearer mcpat_invented${i}` });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
        expect(res.headers.get('mcp-session-id')).toBeNull();
        await res.text();
      }
      expect(await sessions(url)).toBe(0);
      const session = await c.open('mcpat_good');
      expect(session).toBeTruthy();
      expect(await sessions(url)).toBe(1);
    } finally {
      await stop(server);
    }
  });

  const probes = () => platform.seen.length;

  for (const status of [403, 404]) {
    it(`admits nobody on a ${status} from the probe, and caches nothing`, async () => {
      platform = platformWithRefusals();
      platform.state.probeStatus = status;
      const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
      try {
        const c = client(url);
        for (let i = 0; i < 2; i++) {
          const before = probes();
          const res = await c.send(INIT, { Authorization: 'Bearer mcpat_alice' });
          expect(res.status).toBe(503);
          expect(res.headers.get('mcp-session-id')).toBeNull();
          await res.text();
          // Asked again each time: an unconfirmed answer is never cached.
          expect(probes()).toBe(before + 1);
        }
        expect(await sessions(url)).toBe(0);
      } finally {
        await stop(server);
      }
    });
  }

  // OPL-5437: the probe was `GET ssh-keys`, which a suspended account is
  // refused (403), so its holder could never open a session to ask whoami —
  // the one route the platform answers a suspended account on.
  it('admits a suspended account, whose whoami is answered and nothing else is', async () => {
    platform = platformWithRefusals();
    platform.state.suspended = true;
    const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
    try {
      const session = await client(url).open('mcpat_suspended');
      expect(session).toBeTruthy();
      expect(await sessions(url)).toBe(1);
    } finally {
      await stop(server);
    }
  });

  // OPL-5443: admitted, a suspended account's bearer is held to one session,
  // so it cannot fill the pool the way any accepted bearer once could.
  it('holds a suspended account’s bearer to one session, which still reaches whoami', async () => {
    platform = platformWithRefusals();
    platform.state.suspended = true;
    const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
    const as = (token: string, session?: string) => ({
      Authorization: `Bearer ${token}`,
      ...(session ? { 'mcp-session-id': session } : {}),
    });
    let release = () => {};
    try {
      const c = client(url);
      const first = await c.open('mcpat_suspended');

      // Busy: its whoami call is held at the platform. The next initialize's
      // probe is not, because the acceptance is cached.
      platform.state.probeGate = new Promise<void>((r) => {
        release = r;
      });
      const before = probes();
      const call = c.send(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
        as('mcpat_suspended', first),
      );
      const deadline = Date.now() + 5000;
      while (probes() === before) {
        if (Date.now() > deadline) throw new Error('the whoami call never reached the platform');
        await new Promise((r) => setTimeout(r, 5));
      }
      const second = await c.send(INIT, as('mcpat_suspended'));
      expect(second.status).toBe(429);
      expect(second.headers.get('retry-after')).toBe('30');
      expect(((await second.json()) as { error: { message: string } }).error.message).toContain(
        'This token already holds its maximum of 1 session on this server',
      );
      expect(await sessions(url)).toBe(1);

      platform.state.probeGate = undefined;
      release();
      const answer = JSON.stringify(await messages(await call));
      expect(answer).toContain('SUSPENDED');

      // Idle now: the next initialize closes it rather than being refused, and
      // the bearer still holds exactly one.
      const third = await c.open('mcpat_suspended');
      expect(await sessions(url)).toBe(1);
      const gone = await c.send(LIST, as('mcpat_suspended', first));
      expect(gone.status).toBe(404);
      await gone.text();
      const kept = await c.send(LIST, as('mcpat_suspended', third));
      expect(kept.status).toBe(200);
      await kept.text();

      // An active account is not held to one.
      platform.state.suspended = false;
      await c.open('mcpat_active');
      await c.open('mcpat_active');
      expect(await sessions(url)).toBe(3);
    } finally {
      platform.state.probeGate = undefined;
      release();
      await stop(server);
    }
  });

  // Review round 1: a request already routed to a session waits on its bearer
  // probe before it is dispatched, and the session looked idle all that time,
  // so an initialize on the same bearer at its cap closed it and the request
  // was answered 404.
  it('never closes a session to make room while a request on it waits for its probe', async () => {
    platform = platformWithRefusals();
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxSessionsPerBearer: 1,
      // Every request probes, so the one below waits on the platform.
      bearerCheckTtlMs: 0,
    });
    const as = (session?: string) => ({
      Authorization: 'Bearer mcpat_one',
      ...(session ? { 'mcp-session-id': session } : {}),
    });
    let release = () => {};
    try {
      const c = client(url);
      const first = await c.open('mcpat_one');

      platform.state.probeGate = new Promise<void>((r) => {
        release = r;
      });
      const before = probes();
      const call = c.send(LIST, as(first));
      const deadline = Date.now() + 5000;
      while (probes() === before) {
        if (Date.now() > deadline) throw new Error('the request never reached its probe');
        await new Promise((r) => setTimeout(r, 5));
      }
      // Only that probe is held; the initialize's own goes straight through.
      platform.state.probeGate = undefined;

      const second = await c.send(INIT, as());
      expect(second.status).toBe(429);
      expect(second.headers.get('mcp-session-id')).toBeNull();
      await second.text();

      release();
      const answered = await call;
      expect(answered.status).toBe(200);
      await answered.text();
      expect(await sessions(url)).toBe(1);
      const kept = await c.send(LIST, as(first));
      expect(kept.status).toBe(200);
      await kept.text();
    } finally {
      platform.state.probeGate = undefined;
      release();
      await stop(server);
    }
  });

  // OPL-5448: the one-session limit was applied only at initialize, so a
  // bearer that opened sessions while its account was active kept every one
  // of them after the account was suspended.
  it('closes a newly suspended bearer’s other idle sessions on its next request, never a busy one', async () => {
    platform = platformWithRefusals();
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      // Every request probes, so the suspension is seen at once.
      bearerCheckTtlMs: 0,
    });
    const as = (session?: string) => ({
      Authorization: 'Bearer mcpat_flip',
      ...(session ? { 'mcp-session-id': session } : {}),
    });
    let release = () => {};
    try {
      const c = client(url);
      const [a, b, d, e] = [
        await c.open('mcpat_flip'),
        await c.open('mcpat_flip'),
        await c.open('mcpat_flip'),
        await c.open('mcpat_flip'),
      ];
      expect(await sessions(url)).toBe(4);
      platform.state.suspended = true;

      // B is in flight: its request waits on its probe at the platform.
      platform.state.probeGate = new Promise<void>((r) => {
        release = r;
      });
      const before = probes();
      const busy = c.send(LIST, as(b));
      const deadline = Date.now() + 5000;
      while (probes() === before) {
        if (Date.now() > deadline) throw new Error('the request on B never reached its probe');
        await new Promise((r) => setTimeout(r, 5));
      }
      platform.state.probeGate = undefined;

      // A request on A: A is kept (it is serving this), B is kept (busy), and
      // the idle D and E are closed.
      const onA = await c.send(LIST, as(a));
      expect(onA.status).toBe(200);
      await onA.text();
      expect(await sessions(url)).toBe(2);
      for (const gone of [d, e]) {
        const res = await c.send(LIST, as(gone));
        expect(res.status).toBe(404);
        await res.text();
      }

      // B finishes its probe with A now idle, so A goes and B is the one left.
      release();
      const onB = await busy;
      expect(onB.status).toBe(200);
      await onB.text();
      expect(await sessions(url)).toBe(1);
      const goneA = await c.send(LIST, as(a));
      expect(goneA.status).toBe(404);
      await goneA.text();
      const keptB = await c.send(LIST, as(b));
      expect(keptB.status).toBe(200);
      await keptB.text();
    } finally {
      platform.state.probeGate = undefined;
      release();
      await stop(server);
    }
  });

  // OPL-5448: the initialize of a newly suspended bearer trims the same way,
  // and a 429 for a bearer still over its limit says what it holds rather
  // than telling it to close one.
  it('trims a newly suspended bearer at initialize, and its 429 names what it still holds', async () => {
    platform = platformWithRefusals();
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      bearerCheckTtlMs: 0,
    });
    const as = (session?: string) => ({
      Authorization: 'Bearer mcpat_flip2',
      ...(session ? { 'mcp-session-id': session } : {}),
    });
    let release = () => {};
    try {
      const c = client(url);
      const [a, b, d, e] = [
        await c.open('mcpat_flip2'),
        await c.open('mcpat_flip2'),
        await c.open('mcpat_flip2'),
        await c.open('mcpat_flip2'),
      ];
      platform.state.suspended = true;

      // A and B are in flight, each waiting on its probe.
      platform.state.probeGate = new Promise<void>((r) => {
        release = r;
      });
      const inFlight: Array<Promise<Response>> = [];
      for (const s of [a, b]) {
        const before = probes();
        inFlight.push(c.send(LIST, as(s)));
        const deadline = Date.now() + 5000;
        while (probes() === before) {
          if (Date.now() > deadline) throw new Error('a request never reached its probe');
          await new Promise((r) => setTimeout(r, 5));
        }
      }
      platform.state.probeGate = undefined;

      const refused = await c.send(INIT, as());
      expect(refused.status).toBe(429);
      expect(refused.headers.get('mcp-session-id')).toBeNull();
      const message = ((await refused.json()) as { error: { message: string } }).error.message;
      expect(message).toContain(
        'This token holds 2 sessions on this server, over its maximum of 1',
      );
      expect(message).not.toContain('Close one');
      // The idle two went, whatever became of the initialize.
      expect(await sessions(url)).toBe(2);
      for (const gone of [d, e]) {
        const res = await c.send(LIST, as(gone));
        expect(res.status).toBe(404);
        await res.text();
      }

      release();
      for (const answer of await Promise.all(inFlight)) {
        expect(answer.status).toBe(200);
        await answer.text();
      }
      // Both idle now: the next initialize closes them and leaves one, its own.
      const last = await c.open('mcpat_flip2');
      expect(await sessions(url)).toBe(1);
      const kept = await c.send(LIST, as(last));
      expect(kept.status).toBe(200);
      await kept.text();
    } finally {
      platform.state.probeGate = undefined;
      release();
      await stop(server);
    }
  });

  // OPL-5050: a refused bearer on a sessionless request that is not an
  // initialize was answered 400 "No session id", which sent the client to its
  // session handling when the fix was its token.
  it('answers a refused bearer with no session 401, and a valid one 400', async () => {
    platform = platformWithRefusals();
    platform.state.onlyAccept = 'mcpat_good';
    const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
    try {
      const c = client(url);
      const bad = await c.send(LIST, { Authorization: 'Bearer mcpat_invented' });
      expect(bad.status).toBe(401);
      expect(bad.headers.get('www-authenticate')).toBe(CHALLENGE);
      expect(((await bad.json()) as { id: unknown }).id).toBe(LIST.id);

      // The protocol mistake is still named once the key is not the problem.
      const good = await c.send(LIST, { Authorization: 'Bearer mcpat_good' });
      expect(good.status).toBe(400);
      expect(((await good.json()) as { error: { message: string } }).error.message).toContain(
        'No session id',
      );
      expect(await sessions(url)).toBe(0);
    } finally {
      await stop(server);
    }
  });

  it('answers a bearer the platform cannot confirm with no session 400, not 503', async () => {
    platform = platformWithRefusals();
    platform.state.probeStatus = 503;
    const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
    try {
      const res = await client(url).send(LIST, { Authorization: 'Bearer mcpat_alice' });
      // Only a refusal changes the answer; an unconfirmed key is not one.
      expect(res.status).toBe(400);
      await res.text();
    } finally {
      await stop(server);
    }
  });

  it('still initializes a valid client from an address whose budget is spent', async () => {
    platform = platformWithRefusals();
    platform.state.onlyAccept = 'mcpat_good';
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxFailedInitializes: 2,
      exhaustedProbeIntervalMs: 100,
    });
    try {
      const c = client(url);
      await c.open('mcpat_good');
      for (let i = 0; i < 3; i++) {
        const res = await c.send(INIT, { Authorization: `Bearer mcpat_invented${i}` });
        expect(res.status).toBe(401);
        await res.text();
      }
      // Already accepted: passes the spent budget without a probe.
      const before = probes();
      await c.open('mcpat_good');
      expect(probes()).toBe(before);
      // New to this server, from the same spent address: still probed, and in,
      // once the address's probe interval has passed.
      await new Promise((r) => setTimeout(r, 150));
      platform.state.onlyAccept = 'mcpat_new';
      expect(await c.open('mcpat_new')).toBeTruthy();
    } finally {
      await stop(server);
    }
  });

  it('lets a spent address probe one new bearer per interval, 429s the rest unasked, and passes an accepted one', async () => {
    platform = platformWithRefusals();
    platform.state.onlyAccept = 'mcpat_good';
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxFailedInitializes: 1,
    });
    try {
      const c = client(url);
      await c.open('mcpat_good');
      const first = await c.send(INIT, { Authorization: 'Bearer mcpat_invented0' });
      expect(first.status).toBe(401);
      await first.text();
      platform.state.probeDelayMs = 100;
      const before = probes();
      const [a, b, good] = await Promise.all([
        c.send(INIT, { Authorization: 'Bearer mcpat_invented1' }),
        c.send(INIT, { Authorization: 'Bearer mcpat_invented2' }),
        // Arrives while the address's one probe is in flight, and passes on
        // the platform's earlier acceptance.
        new Promise<void>((r) => setTimeout(r, 30)).then(() =>
          c.send(INIT, { Authorization: 'Bearer mcpat_good' }),
        ),
      ]);
      expect([a.status, b.status].sort()).toEqual([401, 429]);
      expect(good.status).toBe(200);
      const limited = a.status === 429 ? a : b;
      // The default 5 s interval, rounded up to whole seconds.
      expect(limited.headers.get('retry-after')).toBe('5');
      await Promise.all([a.text(), b.text(), good.text()]);
      expect(probes()).toBe(before + 1);
    } finally {
      await stop(server);
    }
  });

  it('lets a spent address have one new bearer checked per interval, however many it sends', async () => {
    platform = platformWithRefusals();
    platform.state.onlyAccept = 'mcpat_good';
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxFailedInitializes: 1,
      exhaustedProbeIntervalMs: 300,
    });
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const c = client(url);
      const spend = await c.send(INIT, { Authorization: 'Bearer mcpat_spend' });
      expect(spend.status).toBe(401);
      await spend.text();

      // Ten in a row within one interval: exactly one reaches the platform.
      let before = probes();
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await c.send(INIT, { Authorization: `Bearer mcpat_invented${i}` });
        statuses.push(res.status);
        if (res.status === 429) expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
        await res.text();
      }
      expect(probes()).toBe(before + 1);
      expect(statuses[0]).toBe(401);
      expect(statuses.slice(1).every((st) => st === 429)).toBe(true);

      // The interval passes: one more is checked.
      await pause(350);
      before = probes();
      const later = await c.send(INIT, { Authorization: 'Bearer mcpat_invented10' });
      expect(later.status).toBe(401);
      await later.text();
      expect(probes()).toBe(before + 1);

      // And at the next interval a valid new bearer gets in.
      await pause(350);
      platform.state.onlyAccept = 'mcpat_new';
      expect(await c.open('mcpat_new')).toBeTruthy();
    } finally {
      await stop(server);
    }
  });

  it('does not spend a spent address’s interval on a request the full probe cap turned away', async () => {
    platform = platformWithRefusals();
    platform.state.onlyAccept = 'mcpat_good';
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxFailedInitializes: 1,
      maxSessions: 64,
    });
    const from = (ip: string, token: string) => ({
      Authorization: `Bearer ${token}`,
      'X-Forwarded-For': ip,
    });
    // Released in `finally` too, before the server stops: a failed assertion
    // with the gate shut would leave 32 requests held and stall the suite.
    let release = () => {};
    try {
      const c = client(url);
      const spend = await c.send(INIT, from('10.9.0.1', 'mcpat_spend'));
      expect(spend.status).toBe(401);
      await spend.text();

      // Fill the process-wide cap from other addresses: every probe is held
      // at the platform until all 32 have arrived and the turned-away request
      // has been answered, so the cap is full by construction, not by timing.
      platform.state.probeGate = new Promise<void>((r) => {
        release = r;
      });
      const base = probes();
      const fill = Array.from({ length: 32 }, (_, i) =>
        c.send(INIT, from(`10.9.1.${i + 1}`, `mcpat_fill${i}`)),
      );
      // Well inside the test's own timeout below, so the error and the gate's
      // release happen before vitest gives up on the test.
      const deadline = Date.now() + 8000;
      while (probes() < base + 32) {
        if (Date.now() > deadline) throw new Error(`only ${probes() - base} of 32 probes arrived`);
        await new Promise((r) => setTimeout(r, 5));
      }
      const before = probes();
      const turned = await c.send(INIT, from('10.9.0.1', 'mcpat_invented'));
      expect(turned.status).toBe(503);
      await turned.text();
      expect(probes()).toBe(before);
      platform.state.probeGate = undefined;
      release();
      for (const res of await Promise.all(fill)) await res.text();

      // A slot is free: the spent address is probed at once, not told to wait.
      platform.state.onlyAccept = 'mcpat_new';
      const res = await c.send(INIT, from('10.9.0.1', 'mcpat_new'));
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      platform.state.probeGate = undefined;
      release();
      await stop(server);
    }
  }, 15_000);

  it('refuses a request on a token revoked since it was last checked, before dispatch', async () => {
    platform = platformWithRefusals();
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      bearerCheckTtlMs: 0,
    });
    try {
      const c = client(url);
      const session = await c.open('mcpat_alice');
      platform.refused.add('mcpat_alice');
      // tools/list reaches no platform route itself: only the check can refuse it.
      const res = await c.send(LIST, {
        Authorization: 'Bearer mcpat_alice',
        'mcp-session-id': session,
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
      await res.text();
    } finally {
      await stop(server);
    }
  });

  it('ends a call refused after the keep-alive as a tool error, and 401s the next request unsent', async () => {
    platform = platformWithRefusals();
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      // The SDK's 15 s keep-alive, shortened so it fires well before the
      // platform's refusal below arrives.
      sseKeepAliveMs: 20,
    });
    try {
      const c = client(url);
      const session = await c.open('mcpat_alice');
      platform.slowRefusals.set('mcpat_alice', 200);
      const res = await c.send(ACCOUNT, {
        Authorization: 'Bearer mcpat_alice',
        'mcp-session-id': session,
      });
      // The stream was already committed, so this one call cannot be a 401.
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain(': keepalive');
      const result = text
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice(6)) as { result?: { isError?: boolean } })
        .find((m) => m.result);
      expect(result?.result?.isError).toBe(true);

      platform.seen.length = 0;
      const next = await c.send(LIST, {
        Authorization: 'Bearer mcpat_alice',
        'mcp-session-id': session,
      });
      expect(next.status).toBe(401);
      expect(next.headers.get('www-authenticate')).toBe(CHALLENGE);
      await next.text();
      expect(platform.seen).toHaveLength(0);
    } finally {
      await stop(server);
    }
  });
});

// OPL-5447: the session cap was per bearer, so one account holding many keys
// held one bearer's share on each of them, and could fill the whole pool; a
// suspended account held one session on each key. Sessions now count against
// the account the platform's whoami names for each bearer.
describe('hosted: one account, however many bearers', () => {
  let platform: ReturnType<typeof platformWithRefusals>;
  afterEach(() => platform.restore());

  const sessions = async (url: string) =>
    ((await (await fetch(url.replace(/\/mcp$/, '/healthz'))).json()) as { sessions: number })
      .sessions;
  const as = (token: string, session?: string) => ({
    Authorization: `Bearer ${token}`,
    ...(session ? { 'mcp-session-id': session } : {}),
  });
  const active = (id: string) => ({ id, name: id, plan: 'team', status: 'active' });
  const suspended = (id: string) => ({ id, name: id, plan: 'team', status: 'suspended' });
  /** Resolve once the platform has seen `n` more requests than `before`. */
  const reached = async (before: number, n = 1) => {
    const deadline = Date.now() + 5000;
    while (platform.seen.length < before + n) {
      if (Date.now() > deadline) throw new Error('a probe never reached the platform');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const status = async (res: Response) => {
    await res.text();
    return res.status;
  };
  const message = async (res: Response) =>
    ((await res.json()) as { error: { message: string } }).error.message;

  it('refuses an account at its ceiling 429 with Retry-After, whichever key asks, and leaves another account alone', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {};
    for (let i = 0; i < 6; i++) platform.state.accounts[`mcpat_a${i}`] = active('acc-a');
    platform.state.accounts.mcpat_b = active('acc-b');
    // The default ceiling is half the pool: 4 of 8.
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxSessions: 8,
    });
    try {
      const c = client(url);
      const held: Array<[string, string]> = [];
      for (let i = 0; i < 4; i++) held.push([`mcpat_a${i}`, await c.open(`mcpat_a${i}`)]);

      for (const token of ['mcpat_a4', 'mcpat_a5']) {
        const over = await c.send(INIT, as(token));
        expect(over.status).toBe(429);
        expect(over.headers.get('retry-after')).toBe('30');
        expect(over.headers.get('mcp-session-id')).toBeNull();
        const said = await message(over);
        expect(said).toBe(
          'This account has reached its maximum of 4 sessions on this server, across all its tokens. Close one (DELETE /mcp) or retry shortly.',
        );
      }
      // Refused, never made room for: every session the account held is kept.
      expect(await sessions(url)).toBe(4);
      for (const [token, session] of held) {
        expect(await status(await c.send(LIST, as(token, session)))).toBe(200);
      }

      // Another account is not held to the first one's ceiling.
      await c.open('mcpat_b');
      await c.open('mcpat_b');
      expect(await sessions(url)).toBe(6);

      // A slot the account gives back is its own again.
      const del = await c.send(undefined, as(...held[0]), 'DELETE');
      expect(del.status).toBe(200);
      await del.text();
      await c.open('mcpat_a5');
      expect(await sessions(url)).toBe(6);

      // A key under its own cap whose account is at the ceiling makes room
      // from its own idle session, as it would at its own cap (review round 1:
      // it was refused until the sweep). Nothing of another key's is closed.
      const again = await c.open('mcpat_a1');
      expect(await sessions(url)).toBe(6);
      expect(await status(await c.send(LIST, as(...held[1])))).toBe(404);
      expect(await status(await c.send(LIST, as('mcpat_a1', again)))).toBe(200);
      for (const [token, session] of held.slice(2)) {
        expect(await status(await c.send(LIST, as(token, session)))).toBe(200);
      }
    } finally {
      await stop(server);
    }
  });

  it('still admits at the ceiling when the bearer makes room from its own idle session', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {
      mcpat_one: active('acc-a'),
      mcpat_two: active('acc-a'),
      mcpat_three: active('acc-a'),
    };
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxSessionsPerBearer: 1,
      maxSessionsPerAccount: 2,
    });
    try {
      const c = client(url);
      const first = await c.open('mcpat_one');
      const second = await c.open('mcpat_two');
      // At the ceiling, but the bearer's own idle session makes the room.
      const again = await c.open('mcpat_one');
      expect(await sessions(url)).toBe(2);
      expect(await status(await c.send(LIST, as('mcpat_one', first)))).toBe(404);
      expect(await status(await c.send(LIST, as('mcpat_one', again)))).toBe(200);
      expect(await status(await c.send(LIST, as('mcpat_two', second)))).toBe(200);
      // A third key has nothing of its own to give back.
      const third = await c.send(INIT, as('mcpat_three'));
      expect(third.status).toBe(429);
      expect(await message(third)).toContain('This account has reached its maximum of 2 sessions');
      expect(await sessions(url)).toBe(2);
    } finally {
      await stop(server);
    }
  });

  it('never lets concurrent initializes across an account’s keys pass its ceiling', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {};
    for (let i = 0; i < 5; i++) platform.state.accounts[`mcpat_c${i}`] = active('acc-c');
    // Held before the transport answers, so every admission is still pending
    // and none is a session yet: only the per-account reservations stand
    // between the burst and the ceiling.
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
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxSessionsPerAccount: 2,
    });
    try {
      const c = client(url);
      const answered: number[] = [];
      const burst = Array.from({ length: 5 }, (_, i) =>
        c.send(INIT, as(`mcpat_c${i}`)).then(async (r) => {
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
      expect(await sessions(url)).toBe(2);
    } finally {
      open();
      StreamableHTTPServerTransport.prototype.handleRequest = original;
      await stop(server);
    }
  });

  it('holds a suspended account to one session across all its keys, never closing a busy one', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {
      mcpat_s1: active('acc-s'),
      mcpat_s2: active('acc-s'),
      mcpat_s3: active('acc-s'),
      mcpat_s4: active('acc-s'),
      mcpat_s5: active('acc-s'),
      mcpat_other: active('acc-o'),
    };
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      // Every request probes, so the suspension is seen at once.
      bearerCheckTtlMs: 0,
    });
    let release = () => {};
    try {
      const c = client(url);
      const s1 = await c.open('mcpat_s1');
      const s2 = await c.open('mcpat_s2');
      const s3 = await c.open('mcpat_s3');
      const s4 = await c.open('mcpat_s4');
      const other = await c.open('mcpat_other');
      expect(await sessions(url)).toBe(5);
      for (const t of ['mcpat_s1', 'mcpat_s2', 'mcpat_s3', 'mcpat_s4', 'mcpat_s5']) {
        platform.state.accounts[t] = suspended('acc-s');
      }

      // s2 is in flight: its request waits on its probe at the platform.
      platform.state.probeGates = new Map([
        [
          'mcpat_s2',
          new Promise<void>((r) => {
            release = r;
          }),
        ],
      ]);
      const before = platform.seen.length;
      const busy = c.send(LIST, as('mcpat_s2', s2));
      await reached(before);

      // A request on s1 learns of the suspension: s1 is kept (it is serving
      // this), s2 is kept (busy), and the account's other idle sessions go,
      // whichever key opened them. Another account's session is untouched.
      expect(await status(await c.send(LIST, as('mcpat_s1', s1)))).toBe(200);
      expect(await sessions(url)).toBe(3);
      for (const [t, s] of [
        ['mcpat_s3', s3],
        ['mcpat_s4', s4],
      ] as const) {
        expect(await status(await c.send(LIST, as(t, s)))).toBe(404);
      }
      expect(await status(await c.send(LIST, as('mcpat_other', other)))).toBe(200);

      // Its keys cannot open more: not a new one, and not one whose session
      // was just closed.
      for (const t of ['mcpat_s5', 'mcpat_s3']) {
        const refused = await c.send(INIT, as(t));
        expect(refused.status).toBe(429);
        expect(refused.headers.get('retry-after')).toBe('30');
        expect(await message(refused)).toContain(
          'This account has reached its maximum of 1 session on this server, across all its tokens.',
        );
      }

      // s2 finishes with s1 idle now, so s1 goes and s2 is the one left.
      release();
      expect(await status(await busy)).toBe(200);
      expect(await sessions(url)).toBe(2);
      expect(await status(await c.send(LIST, as('mcpat_s1', s1)))).toBe(404);
      expect(await status(await c.send(LIST, as('mcpat_s2', s2)))).toBe(200);
    } finally {
      release();
      await stop(server);
    }
  });

  it('trims a newly suspended account at an initialize on any of its keys, keeping the most recent, and refuses further initializes', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {
      mcpat_t1: active('acc-t'),
      mcpat_t2: active('acc-t'),
      mcpat_t3: active('acc-t'),
      mcpat_t4: active('acc-t'),
    };
    const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
    try {
      const c = client(url);
      const t1 = await c.open('mcpat_t1');
      const t2 = await c.open('mcpat_t2');
      await new Promise((r) => setTimeout(r, 5));
      const t3 = await c.open('mcpat_t3');
      platform.state.accounts.mcpat_t4 = suspended('acc-t');

      // A key with no session learns of the suspension at initialize: the
      // account's idle sessions go down to one, the most recently seen, and
      // it holds that one, so this key is refused. Another key's session is
      // never closed to admit it, idle or not (review round 2: spec §2, §4).
      const refused = await c.send(INIT, as('mcpat_t4'));
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('30');
      expect(await message(refused)).toContain(
        'This account has reached its maximum of 1 session on this server, across all its tokens.',
      );
      expect(await sessions(url)).toBe(1);
      expect(await status(await c.send(LIST, as('mcpat_t3', t3)))).toBe(200);
      for (const [t, s] of [
        ['mcpat_t1', t1],
        ['mcpat_t2', t2],
      ] as const) {
        expect(await status(await c.send(LIST, as(t, s)))).toBe(404);
      }
      // Further initializes, on the account's other keys, are refused too,
      // and the one session it holds is left alone.
      for (const t of ['mcpat_t1', 'mcpat_t4']) {
        const again = await c.send(INIT, as(t));
        expect(again.status).toBe(429);
        await again.text();
      }
      expect(await sessions(url)).toBe(1);
      expect(await status(await c.send(LIST, as('mcpat_t3', t3)))).toBe(200);
    } finally {
      await stop(server);
    }
  });

  it('does not let a stale active answer, sent before a suspension, undo it', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {
      mcpat_late: active('acc-l'),
      mcpat_now: active('acc-l'),
    };
    const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
    let release = () => {};
    try {
      const c = client(url);
      // mcpat_late's probe is sent while the account is active, and held.
      platform.state.probeGates = new Map([
        [
          'mcpat_late',
          new Promise<void>((r) => {
            release = r;
          }),
        ],
      ]);
      const before = platform.seen.length;
      const late = c.send(INIT, as('mcpat_late'));
      await reached(before);

      // The account is suspended, and a probe sent after that says so.
      platform.state.accounts.mcpat_now = suspended('acc-l');
      const now = await c.open('mcpat_now');
      expect(await sessions(url)).toBe(1);

      // The held probe answers active, but it started before the suspension
      // was seen: the account stays held to the one session it has, which is
      // another key's and is not closed for it.
      release();
      const refused = await late;
      expect(refused.status).toBe(429);
      expect(await message(refused)).toContain(
        'This account has reached its maximum of 1 session on this server',
      );
      expect(await sessions(url)).toBe(1);
      expect(await status(await c.send(LIST, as('mcpat_now', now)))).toBe(200);
    } finally {
      release();
      await stop(server);
    }
  });

  it('holds a key whose own active answer is still cached to a suspension another key found', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = { mcpat_cached: active('acc-k'), mcpat_fresh: active('acc-k') };
    // The default window: mcpat_cached's `ok` is not asked again below.
    const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
    let release = () => {};
    try {
      const c = client(url);
      const first = await c.open('mcpat_cached');
      // Busy: a whoami call on it is held at the platform.
      platform.state.probeGates = new Map([
        [
          'mcpat_cached',
          new Promise<void>((r) => {
            release = r;
          }),
        ],
      ]);
      const before = platform.seen.length;
      const call = c.send(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
        as('mcpat_cached', first),
      );
      await reached(before);

      // A probe on the other key finds the account suspended; the account
      // holds one session already, so that key is refused.
      platform.state.accounts.mcpat_fresh = suspended('acc-k');
      const fresh = await c.send(INIT, as('mcpat_fresh'));
      expect(fresh.status).toBe(429);
      await fresh.text();

      // mcpat_cached is answered from its cache, and held to one all the
      // same: its one session is busy, so it is refused before anything is
      // built, not admitted and then dropped.
      const probes = platform.seen.length;
      const refused = await c.send(INIT, as('mcpat_cached'));
      expect(platform.seen.length).toBe(probes);
      expect(refused.status).toBe(429);
      expect(await message(refused)).toContain(
        'This token already holds its maximum of 1 session on this server',
      );
      release();
      expect(await status(await call)).toBe(200);
      expect(await sessions(url)).toBe(1);
    } finally {
      release();
      await stop(server);
    }
  });

  /**
   * Hold every initialize before its session exists, until `open`. Returns
   * the count of those held so far, and a restore for `finally`.
   */
  const holdInitializes = () => {
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
    const waitHeld = async () => {
      const deadline = Date.now() + 5000;
      while (held.count === 0) {
        if (Date.now() > deadline) throw new Error('the initialize never reached the transport');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    return {
      open: () => open(),
      waitHeld,
      restore: () => {
        open();
        StreamableHTTPServerTransport.prototype.handleRequest = original;
      },
    };
  };

  it('drops at birth a session admitted before its account was suspended, while its one is busy', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {
      mcpat_d1: active('acc-d'),
      mcpat_d2: active('acc-d'),
      mcpat_d3: suspended('acc-d'),
    };
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      bearerCheckTtlMs: 0,
    });
    let hold: ReturnType<typeof holdInitializes> | undefined;
    let release = () => {};
    try {
      const c = client(url);
      const first = await c.open('mcpat_d1');
      hold = holdInitializes();
      // mcpat_d2's initialize is admitted while the account is active, and
      // held before its session exists.
      const late = c.send(INIT, as('mcpat_d2'));
      await hold.waitHeld();
      // d1 is put to work: its request waits on its probe at the platform.
      platform.state.accounts.mcpat_d1 = suspended('acc-d');
      platform.state.probeGates = new Map([
        [
          'mcpat_d1',
          new Promise<void>((r) => {
            release = r;
          }),
        ],
      ]);
      const before = platform.seen.length;
      const busy = c.send(LIST, as('mcpat_d1', first));
      await reached(before);
      // A third key finds the account suspended, and its one session busy.
      const third = await c.send(INIT, as('mcpat_d3'));
      expect(third.status).toBe(429);
      await third.text();

      hold.open();
      const dropped = await late;
      expect(dropped.status).toBe(404);
      expect(dropped.headers.get('mcp-session-id')).toBeNull();
      await dropped.text();
      expect(await sessions(url)).toBe(1);
      release();
      expect(await status(await busy)).toBe(200);
      expect(await status(await c.send(LIST, as('mcpat_d1', first)))).toBe(200);
    } finally {
      release();
      hold?.restore();
      await stop(server);
    }
  });

  // Review round 2: a session admitted before its account was suspended used
  // to replace the account's one session at birth when that one was idle,
  // closing another key's session for it. It is dropped instead, idle or not.
  it('drops at birth a session admitted before its account was suspended, while its one is idle', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = { mcpat_d1: active('acc-d'), mcpat_d2: active('acc-d') };
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      bearerCheckTtlMs: 0,
    });
    let hold: ReturnType<typeof holdInitializes> | undefined;
    try {
      const c = client(url);
      const first = await c.open('mcpat_d1');
      hold = holdInitializes();
      const late = c.send(INIT, as('mcpat_d2'));
      await hold.waitHeld();
      // Suspended now, and a request on the other key's session says so.
      platform.state.accounts.mcpat_d1 = suspended('acc-d');
      expect(await status(await c.send(LIST, as('mcpat_d1', first)))).toBe(200);

      // d1 is idle again when d2's session is made, and is still not closed
      // for it: d2's session is dropped at birth.
      hold.open();
      const dropped = await late;
      expect(dropped.status).toBe(404);
      expect(dropped.headers.get('mcp-session-id')).toBeNull();
      await dropped.text();
      expect(await sessions(url)).toBe(1);
      expect(await status(await c.send(LIST, as('mcpat_d1', first)))).toBe(200);
    } finally {
      hold?.restore();
      await stop(server);
    }
  });

  const NOTE = { jsonrpc: '2.0', method: 'notifications/initialized' };
  /** Open the event stream, return its status, and hang up. */
  const stream = async (url: string, token: string, session: string) => {
    const abort = new AbortController();
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...as(token, session) },
      signal: abort.signal,
    });
    const challenge = res.headers.get('www-authenticate');
    if (res.status === 200) abort.abort();
    else await res.text();
    return { status: res.status, challenge };
  };

  // Review round 1: only a POST carrying a request had its token checked, and
  // a notification or the stream still stamped the session as heard from. A
  // revoked key could keep its sessions from ever idling out that way, and
  // since the account ceiling never closes another key's live session, its
  // account's other keys were refused for as long as it kept sending. Review
  // round 2: its refused sessions still count until closed, and an idle one
  // is closed to make room, so the account never holds more than its ceiling.
  it('makes room from a revoked key’s idle sessions once its notifications or its stream are refused', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = { mcpat_bad: active('acc-x'), mcpat_owner: active('acc-x') };
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxSessionsPerAccount: 2,
      bearerCheckTtlMs: 100,
    });
    try {
      const c = client(url);
      const one = await c.open('mcpat_bad');
      const two = await c.open('mcpat_bad');
      // Revoked: its whoami is a 401 from now on.
      delete platform.state.accounts.mcpat_bad;
      platform.refused.add('mcpat_bad');
      const blocked = await c.send(INIT, as('mcpat_owner'));
      expect(blocked.status).toBe(429);
      await blocked.text();

      // Past the revoked key's cached acceptance.
      await new Promise((r) => setTimeout(r, 150));
      const note = await c.send(NOTE, as('mcpat_bad', one));
      expect(note.status).toBe(401);
      expect(note.headers.get('www-authenticate')).toBe(CHALLENGE);
      await note.text();
      expect(await stream(url, 'mcpat_bad', two)).toEqual({ status: 401, challenge: CHALLENGE });

      // Neither holds the account's ceiling against its other key now, well
      // before any sweep: each is closed to make room for one of the owner's.
      await c.open('mcpat_owner');
      await c.open('mcpat_owner');
      expect(await sessions(url)).toBe(2);
      expect(await status(await c.send(NOTE, as('mcpat_bad', two)))).toBe(404);
      expect((await stream(url, 'mcpat_bad', one)).status).toBe(404);
    } finally {
      await stop(server);
    }
  });

  // Review round 1: a suspension was acted on only by a POST carrying a
  // request, and notifications kept the other sessions from idling out, so a
  // suspended account that sent nothing else held all of them.
  for (const via of ['a notification', 'the event stream'] as const) {
    it(`holds a newly suspended account to one session on ${via} alone`, async () => {
      platform = platformWithRefusals();
      platform.state.accounts = {
        mcpat_y1: active('acc-y'),
        mcpat_y2: active('acc-y'),
        mcpat_y3: active('acc-y'),
      };
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        bearerCheckTtlMs: 0,
      });
      try {
        const c = client(url);
        const y1 = await c.open('mcpat_y1');
        const y2 = await c.open('mcpat_y2');
        const y3 = await c.open('mcpat_y3');
        expect(await sessions(url)).toBe(3);
        for (const t of ['mcpat_y1', 'mcpat_y2', 'mcpat_y3']) {
          platform.state.accounts[t] = suspended('acc-y');
        }
        if (via === 'a notification') {
          expect(await status(await c.send(NOTE, as('mcpat_y1', y1)))).toBe(202);
        } else {
          expect((await stream(url, 'mcpat_y1', y1)).status).toBe(200);
        }
        expect(await sessions(url)).toBe(1);
        expect(await status(await c.send(NOTE, as('mcpat_y2', y2)))).toBe(404);
        expect(await status(await c.send(NOTE, as('mcpat_y3', y3)))).toBe(404);
        expect(await status(await c.send(LIST, as('mcpat_y1', y1)))).toBe(200);
      } finally {
        await stop(server);
      }
    });
  }

  // Review round 2: round 1 let a suspended account's other token replace
  // its one session while idle, so two of its clients closed each other's
  // sessions in turn without bound. Spec §2, §4: never another bearer's.
  it('refuses a suspended account’s other tokens while its one session lasts, idle or busy', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {
      mcpat_old: suspended('acc-z'),
      mcpat_new: suspended('acc-z'),
    };
    const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
    let release = () => {};
    try {
      const c = client(url);
      const old = await c.open('mcpat_old');
      // Idle, and not closed for another token.
      const idle = await c.send(INIT, as('mcpat_new'));
      expect(idle.status).toBe(429);
      expect(idle.headers.get('retry-after')).toBe('30');
      expect(await message(idle)).toContain(
        'This account has reached its maximum of 1 session on this server, across all its tokens.',
      );
      expect(await sessions(url)).toBe(1);
      expect(await status(await c.send(LIST, as('mcpat_old', old)))).toBe(200);

      // Busy: a whoami call on it is held at the platform.
      platform.state.probeGates = new Map([
        [
          'mcpat_old',
          new Promise<void>((r) => {
            release = r;
          }),
        ],
      ]);
      const before = platform.seen.length;
      const call = c.send(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
        as('mcpat_old', old),
      );
      await reached(before);
      const busy = await c.send(INIT, as('mcpat_new'));
      expect(busy.status).toBe(429);
      await busy.text();
      release();
      expect(await status(await call)).toBe(200);
      expect(await sessions(url)).toBe(1);
      // The token that holds it still replaces its own idle session.
      const again = await c.open('mcpat_old');
      expect(await sessions(url)).toBe(1);
      expect(await status(await c.send(LIST, as('mcpat_old', old)))).toBe(404);
      expect(await status(await c.send(LIST, as('mcpat_old', again)))).toBe(200);
    } finally {
      release();
      await stop(server);
    }
  });

  // Review round 2: sessions whose token was refused stopped counting against
  // their account, but kept their slot in the pool until the sweep, so an
  // account that revoked and re-minted its keys held more than its ceiling,
  // up to the whole pool, and every other account was answered 503.
  it('never lets an account pass its ceiling by revoking its own keys', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {
      mcpat_k1: active('acc-r'),
      mcpat_k2: active('acc-r'),
      mcpat_other: active('acc-o'),
    };
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxSessions: 4,
      maxSessionsPerAccount: 2,
      bearerCheckTtlMs: 0,
    });
    try {
      const c = client(url);
      const k1 = [await c.open('mcpat_k1'), await c.open('mcpat_k1')];
      delete platform.state.accounts.mcpat_k1;
      platform.refused.add('mcpat_k1');
      for (const s of k1) expect(await status(await c.send(NOTE, as('mcpat_k1', s)))).toBe(401);

      await c.open('mcpat_k2');
      await c.open('mcpat_k2');
      expect(await sessions(url)).toBe(2);
      for (const s of k1) expect(await status(await c.send(NOTE, as('mcpat_k1', s)))).toBe(404);
      // At its ceiling with nothing refused left to give back, it only
      // replaces its own idle session.
      const k2 = await c.open('mcpat_k2');
      expect(await sessions(url)).toBe(2);

      // Another account is not locked out of the pool.
      const other = await c.send(INIT, as('mcpat_other'));
      expect(other.status).toBe(200);
      await other.text();
      expect(await sessions(url)).toBe(3);
      expect(await status(await c.send(LIST, as('mcpat_k2', k2)))).toBe(200);
    } finally {
      await stop(server);
    }
  });

  // Review round 3: a key's cached `suspended` answer outlived a newer `ok`
  // for its account, so once the account was reinstated a request on that
  // key closed the account's other keys' idle sessions until its cache ran
  // out. A cached answer counts only if its probe started after the
  // account's latest confirmed `ok`.
  it('does not let a key’s cached suspended answer, older than the account’s reinstatement, trim its other keys', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = { mcpat_s1: suspended('acc-v'), mcpat_s2: active('acc-v') };
    // The default window: mcpat_s1's suspended answer stays cached below.
    const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
    try {
      const c = client(url);
      const a1 = await c.open('mcpat_s1');
      // Reinstated. mcpat_s2's probe starts after the suspension was seen,
      // and says the account is active.
      platform.state.accounts.mcpat_s1 = active('acc-v');
      const c1 = await c.open('mcpat_s2');
      const c2 = await c.open('mcpat_s2');
      expect(await sessions(url)).toBe(3);

      expect(await status(await c.send(LIST, as('mcpat_s1', a1)))).toBe(200);
      expect(await sessions(url)).toBe(3);
      for (const s of [c1, c2])
        expect(await status(await c.send(LIST, as('mcpat_s2', s)))).toBe(200);
      // Nor at an initialize on that key.
      await c.open('mcpat_s1');
      expect(await sessions(url)).toBe(4);
      for (const s of [c1, c2])
        expect(await status(await c.send(LIST, as('mcpat_s2', s)))).toBe(200);
    } finally {
      await stop(server);
    }
  });

  // Review round 3: trimming a suspended account kept the most recently seen
  // idle session even when its token had been refused, and closed a live one
  // older than it; room was then made from the refused one, so another token
  // was admitted in place of the live session.
  it('closes a suspended account’s refused sessions before its live ones, and still refuses another token', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {
      mcpat_la: active('acc-s'),
      mcpat_lr: active('acc-s'),
      mcpat_lb: active('acc-s'),
    };
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      bearerCheckTtlMs: 0,
    });
    try {
      const c = client(url);
      const a = await c.open('mcpat_la');
      await new Promise((r) => setTimeout(r, 5));
      const r = await c.open('mcpat_lr');
      delete platform.state.accounts.mcpat_lr;
      platform.refused.add('mcpat_lr');
      expect(await status(await c.send(LIST, as('mcpat_lr', r)))).toBe(401);

      platform.state.accounts.mcpat_lb = suspended('acc-s');
      const refused = await c.send(INIT, as('mcpat_lb'));
      expect(refused.status).toBe(429);
      expect(await message(refused)).toContain(
        'This account has reached its maximum of 1 session on this server, across all its tokens.',
      );
      expect(await sessions(url)).toBe(1);
      expect(await status(await c.send(LIST, as('mcpat_la', a)))).toBe(200);
      expect(await status(await c.send(NOTE, as('mcpat_lr', r)))).toBe(404);
    } finally {
      await stop(server);
    }
  });

  // Review round 2: the stream's GET awaits the bearer check before the SDK
  // sees it. A client that hung up during that wait had its stream registered
  // against the dead response, and every later GET on the session was 409.
  it('does not register a stream whose client hung up while its token was being checked', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = { mcpat_g: active('acc-g') };
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      bearerCheckTtlMs: 0,
    });
    let release = () => {};
    try {
      const c = client(url);
      const session = await c.open('mcpat_g');
      platform.state.probeGates = new Map([
        [
          'mcpat_g',
          new Promise<void>((r) => {
            release = r;
          }),
        ],
      ]);
      const before = platform.seen.length;
      const abort = new AbortController();
      const gone = fetch(url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...as('mcpat_g', session) },
        signal: abort.signal,
      }).catch(() => undefined);
      await reached(before);
      abort.abort();
      await gone;
      await new Promise((r) => setTimeout(r, 100));
      release();
      await new Promise((r) => setTimeout(r, 100));
      expect((await stream(url, 'mcpat_g', session)).status).toBe(200);
    } finally {
      release();
      await stop(server);
    }
  });

  it('answers a stream whose session was closed while its token was being checked 404', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = { mcpat_h: active('acc-h') };
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      bearerCheckTtlMs: 0,
    });
    let release = () => {};
    try {
      const c = client(url);
      const session = await c.open('mcpat_h');
      platform.state.probeGates = new Map([
        [
          'mcpat_h',
          new Promise<void>((r) => {
            release = r;
          }),
        ],
      ]);
      const before = platform.seen.length;
      const waiting = fetch(url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...as('mcpat_h', session) },
      });
      await reached(before);
      const del = await fetch(url, { method: 'DELETE', headers: as('mcpat_h', session) });
      expect(del.status).toBe(200);
      await del.text();
      release();
      // This server's own answer, not whatever the closed transport would
      // make of a request handed to it.
      const answer = await waiting;
      expect(answer.status).toBe(404);
      expect(await message(answer)).toBe('Unknown session.');
    } finally {
      release();
      await stop(server);
    }
  });

  it('counts a bearer whose whoami names no account as an account of its own', async () => {
    platform = platformWithRefusals();
    platform.state.accounts = {
      mcpat_noid1: { name: 'nameless', status: 'active' },
      mcpat_noid2: { id: '', name: 'blank', status: 'active' },
      mcpat_id: active('acc-1'),
    };
    const { server, url } = await start({
      resourceMetadataUrl: METADATA,
      serviceSecret: SECRET,
      maxSessionsPerAccount: 1,
    });
    let release = () => {};
    try {
      const c = client(url);
      const first = await c.open('mcpat_noid1');
      // Busy (a whoami call held at the platform), so it cannot make room.
      platform.state.probeGates = new Map([
        [
          'mcpat_noid1',
          new Promise<void>((r) => {
            release = r;
          }),
        ],
      ]);
      const before = platform.seen.length;
      const call = c.send(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
        as('mcpat_noid1', first),
      );
      await reached(before);
      const again = await c.send(INIT, as('mcpat_noid1'));
      expect(again.status).toBe(429);
      expect(await message(again)).toBe(
        'This token has reached the per-account maximum of 1 session on this server, as an account of its own. Close one (DELETE /mcp) or retry shortly.',
      );
      release();
      expect(await status(await call)).toBe(200);
      // Neither lumped with the other nameless bearer nor with a named account.
      await c.open('mcpat_noid2');
      await c.open('mcpat_id');
      expect(await sessions(url)).toBe(3);
    } finally {
      release();
      await stop(server);
    }
  });
});
