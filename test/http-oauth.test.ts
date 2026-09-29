import { once } from 'node:events';
import {
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
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
    /** The account id whoami names per token; unnamed tokens share the fixture's. */
    accounts?: Record<string, string>;
    /** Whoami names no account id at all, for any token. */
    noAccountId?: boolean;
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
    // A suspended account's whoami says so, as the platform's does, and it
    // names the account the token belongs to.
    const accountId = state.accounts?.[token];
    if ((state.suspended || accountId || state.noAccountId) && url.pathname.endsWith('/whoami')) {
      const { id: _fixtureId, ...unnamed } = WHOAMI.account;
      const account = {
        ...(state.noAccountId ? unnamed : WHOAMI.account),
        ...(accountId && !state.noAccountId ? { id: accountId } : {}),
        ...(state.suspended ? { status: 'suspended' } : {}),
      };
      return new Response(JSON.stringify({ ...WHOAMI, account }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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

  // OPL-5447: the cap was per bearer and the pool first come, first served,
  // so one account with many keys filled the pool and every other tenant's
  // initialize was 503'd; and a suspended account kept one session per key.
  describe('sessions per account', () => {
    const pause = () => new Promise((r) => setTimeout(r, 5));
    const as = (token: string, session?: string) => ({
      Authorization: `Bearer ${token}`,
      ...(session ? { 'mcp-session-id': session } : {}),
    });
    const status = async (url: string, token: string, session: string) => {
      const res = await client(url).send(LIST, as(token, session));
      await res.text();
      return res.status;
    };
    const accounts = (heavy: string[], light: string[] = []) =>
      Object.fromEntries([
        ...heavy.map((t) => [t, 'acc-heavy'] as const),
        ...light.map((t) => [t, 'acc-light'] as const),
      ]);
    /** Put these sessions' requests in flight, each held at its bearer probe. */
    const holdAtProbe = async (url: string, pairs: Array<[string, string]>) => {
      let release = () => {};
      platform.state.probeGate = new Promise<void>((r) => {
        release = r;
      });
      const calls: Array<Promise<Response>> = [];
      for (const [token, session] of pairs) {
        const before = probes();
        calls.push(client(url).send(LIST, as(token, session)));
        const deadline = Date.now() + 5000;
        while (probes() === before) {
          if (Date.now() > deadline) throw new Error('a request never reached its probe');
          await pause();
        }
      }
      platform.state.probeGate = undefined;
      return { calls, release };
    };

    it('lets another account in by closing the heavy account’s least recently used idle session', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = accounts(['h1', 'h2', 'h3', 'h4'], ['l1']);
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        maxSessions: 4,
        // No ceiling below the pool, so one account can fill it with four keys.
        maxSessionsPerAccount: 4,
      });
      try {
        const c = client(url);
        const heavy: string[] = [];
        for (const token of ['h1', 'h2', 'h3', 'h4']) {
          heavy.push(await c.open(token));
          await pause();
        }
        expect(await sessions(url)).toBe(4);

        const light = await c.open('l1');
        expect(await sessions(url)).toBe(4);
        expect(await status(url, 'h1', heavy[0])).toBe(404);
        for (const [i, token] of ['h2', 'h3', 'h4'].entries()) {
          expect(await status(url, token, heavy[i + 1])).toBe(200);
        }
        expect(await status(url, 'l1', light)).toBe(200);
      } finally {
        await stop(server);
      }
    });

    it('holds an account to half the pool across all its tokens, 429 once nothing of it is idle', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = accounts(['h1', 'h2', 'h3', 'h4', 'h5'], ['l1']);
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        maxSessions: 6,
        bearerCheckTtlMs: 0,
      });
      let release = () => {};
      try {
        const c = client(url);
        const heavy: string[] = [];
        for (const token of ['h1', 'h2', 'h3']) {
          heavy.push(await c.open(token));
          await pause();
        }
        // At its ceiling of three, a fourth key's initialize closes the
        // account's own least recently used idle session, on another key.
        const h4 = await c.open('h4');
        expect(await sessions(url)).toBe(3);
        expect(await status(url, 'h1', heavy[0])).toBe(404);

        const held = await holdAtProbe(url, [
          ['h2', heavy[1]],
          ['h3', heavy[2]],
          ['h4', h4],
        ]);
        release = held.release;
        const over = await c.send(INIT, as('h5'));
        expect(over.status).toBe(429);
        expect(over.headers.get('retry-after')).toBe('30');
        expect(over.headers.get('mcp-session-id')).toBeNull();
        expect(((await over.json()) as { error: { message: string } }).error.message).toContain(
          'This account, across all its tokens, already holds its maximum of 3 sessions',
        );
        // The pool has room, and another account is not limited by this one.
        await c.open('l1');
        expect(await sessions(url)).toBe(4);

        release();
        for (const answer of await Promise.all(held.calls)) {
          expect(answer.status).toBe(200);
          await answer.text();
        }
      } finally {
        platform.state.probeGate = undefined;
        release();
        await stop(server);
      }
    });

    it('never admits past the ceiling from concurrent initializes on different keys', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = accounts(['h1', 'h2', 'h3']);
      const original = StreamableHTTPServerTransport.prototype.handleRequest;
      let open = () => {};
      const gate = new Promise<void>((r) => {
        open = r;
      });
      let held = 0;
      StreamableHTTPServerTransport.prototype.handleRequest = async function (...args) {
        if (!this.sessionId) {
          held++;
          await gate;
        }
        return original.apply(this, args);
      };
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        maxSessionsPerAccount: 2,
      });
      try {
        const answered: number[] = [];
        const burst = ['h1', 'h2', 'h3'].map((token) =>
          client(url)
            .send(INIT, as(token))
            .then(async (r) => {
              answered.push(r.status);
              await r.text();
              return r.status;
            }),
        );
        const deadline = Date.now() + 5000;
        while (held + answered.length < 3 && Date.now() < deadline) await pause();
        // Nothing is a session yet, so nothing can be closed: only the
        // account's pending count stands between the burst and the ceiling.
        expect(held).toBe(2);
        expect(answered).toEqual([429]);
        open();
        expect((await Promise.all(burst)).sort()).toEqual([200, 200, 429]);
        expect(await sessions(url)).toBe(2);
      } finally {
        open();
        StreamableHTTPServerTransport.prototype.handleRequest = original;
        await stop(server);
      }
    });

    it('holds a suspended account to one session across all its tokens', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = accounts(['s1', 's2', 's3', 's4']);
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        bearerCheckTtlMs: 0,
      });
      try {
        const c = client(url);
        const [a, b, d] = [await c.open('s1'), await c.open('s2'), await c.open('s3')];
        expect(await sessions(url)).toBe(3);
        platform.state.suspended = true;

        // A request on one key's session closes the idle sessions of the
        // account's other keys, not only its own key's.
        expect(await status(url, 's1', a)).toBe(200);
        expect(await sessions(url)).toBe(1);
        expect(await status(url, 's2', b)).toBe(404);
        expect(await status(url, 's3', d)).toBe(404);

        // A fourth key's initialize takes the account's one session, idle, for
        // itself, rather than opening a second.
        const e = await c.open('s4');
        expect(await sessions(url)).toBe(1);
        expect(await status(url, 's1', a)).toBe(404);
        expect(await status(url, 's4', e)).toBe(200);
      } finally {
        await stop(server);
      }
    });

    it('trims a suspended account at a new token’s initialize, before any request on the rest', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = accounts(['s1', 's2', 's3', 's4']);
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        bearerCheckTtlMs: 0,
      });
      let release = () => {};
      try {
        const c = client(url);
        const a = await c.open('s1');
        await pause();
        const b = await c.open('s2');
        await pause();
        const d = await c.open('s3');
        // One of the three is serving a request, so an initialize cannot make
        // room by closing the account's sessions: only the trim closes any.
        const held = await holdAtProbe(url, [['s1', a]]);
        release = held.release;
        platform.state.suspended = true;

        const over = await c.send(INIT, as('s4'));
        expect(over.status).toBe(429);
        expect(((await over.json()) as { error: { message: string } }).error.message).toContain(
          'This account, across all its tokens, already holds its maximum of 1 session',
        );
        // Closed at that initialize: nothing has been asked of them since.
        expect(await sessions(url)).toBe(1);
        expect(await status(url, 's2', b)).toBe(404);
        expect(await status(url, 's3', d)).toBe(404);

        release();
        const [answer] = await Promise.all(held.calls);
        expect(answer.status).toBe(200);
        await answer.text();
      } finally {
        platform.state.probeGate = undefined;
        release();
        await stop(server);
      }
    });

    // A verdict is cached per token. A suspension one token's probe found
    // left the account's other tokens their cached `ok`, and an initialize on
    // one of them was admitted under the active ceiling: a second session.
    it('holds a suspended account to one on a token whose active answer is still cached', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = accounts(['s1', 's2', 's3']);
      const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
      try {
        const c = client(url);
        await c.open('s1');
        await pause();
        await c.open('s2');
        expect(await sessions(url)).toBe(2);
        platform.state.suspended = true;

        // A new token's probe finds the account suspended.
        const d = await c.open('s3');
        expect(await sessions(url)).toBe(1);

        // s1's answer is cached from before, and is not asked again...
        const before = probes();
        const again = await c.open('s1');
        expect(probes()).toBe(before);
        // ...but the account's suspension stands over it.
        expect(await sessions(url)).toBe(1);
        expect(await status(url, 's3', d)).toBe(404);
        expect(await status(url, 's1', again)).toBe(200);
      } finally {
        await stop(server);
      }
    });

    it('forgets an account’s suspension once a probe finds it active again', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = accounts(['s1', 's2', 's3']);
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        maxSessions: 4,
        maxSessionsPerAccount: 4,
      });
      try {
        const c = client(url);
        await c.open('s2');
        platform.state.suspended = true;
        await c.open('s1');
        expect(await sessions(url)).toBe(1);
        platform.state.suspended = false;
        // A new token's probe finds the account active again...
        await c.open('s3');
        expect(await sessions(url)).toBe(2);
        // ...so s2's cached active answer, older than both, is believed again.
        const before = probes();
        await c.open('s2');
        expect(probes()).toBe(before);
        expect(await sessions(url)).toBe(3);
      } finally {
        await stop(server);
      }
    });

    /**
     * A tools/list POST on a session, sent raw so that the test holds its
     * connection: only the headers and five bytes of the body now, the rest
     * on `finish` (or at once, with `whole`), or never, on `abandon`. Returns
     * once the server has the request, with the server's side of it:
     * Express is the server's first `request` listener and runs its
     * middleware up to the body read synchronously, so whatever the request
     * marks on its session before its body is read is marked by then.
     */
    const post = async (
      server: Server,
      url: string,
      token: string,
      session: string,
      whole = false,
    ) => {
      const payload = JSON.stringify(LIST);
      const target = new URL(url);
      const seen = once(server, 'request') as Promise<[IncomingMessage, ServerResponse]>;
      const req = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          ...as(token, session),
        },
      });
      const done = new Promise<number>((resolve) => {
        req.on('response', (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', () => resolve(0));
        req.on('close', () => resolve(0));
      });
      if (whole) req.end(payload);
      else req.write(payload.slice(0, 5));
      const [, served] = await seen;
      return {
        done,
        served,
        finish: () => req.end(payload.slice(5)),
        abandon: () => req.destroy(),
      };
    };

    // Marked before the body was read, an upload kept its session out of a
    // suspended account's trim for as long as the body took to arrive, which
    // is the sender's to choose: an account held to one session kept three.
    it('holds a suspended account to one session while requests on the others are still uploading', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = accounts(['s1', 's2', 's3', 's4']);
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        bearerCheckTtlMs: 0,
      });
      const calls: Array<Awaited<ReturnType<typeof post>>> = [];
      try {
        const c = client(url);
        const a = await c.open('s1');
        await pause();
        const b = await c.open('s2');
        await pause();
        const d = await c.open('s3');
        calls.push(await post(server, url, 's2', b), await post(server, url, 's3', d));
        platform.state.suspended = true;

        expect(await status(url, 's1', a)).toBe(200);
        expect(await sessions(url)).toBe(1);
        // A fourth key's initialize takes the one left, idle, for itself.
        const e = await c.open('s4');
        expect(await sessions(url)).toBe(1);
        expect(await status(url, 's1', a)).toBe(404);
        expect(await status(url, 's4', e)).toBe(200);

        // The uploads find their sessions closed once they arrive.
        for (const call of calls) call.finish();
        expect(await Promise.all(calls.map((call) => call.done))).toEqual([404, 404]);
      } finally {
        for (const call of calls) call.abandon();
        await stop(server);
      }
    });

    // A token the platform refused is answered 401 on every later request
    // before anything is dispatched; an upload on it must not keep its
    // session from being closed to make room for somebody else.
    it('does not spare a refused token’s session from room-making for an upload on it', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = { r1: 'acc-r', x1: 'acc-x', y1: 'acc-y' };
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        maxSessions: 2,
        bearerCheckTtlMs: 0,
      });
      let call: Awaited<ReturnType<typeof post>> | undefined;
      try {
        const c = client(url);
        const r = await c.open('r1');
        await pause();
        const x = await c.open('x1');
        platform.refused.add('r1');
        expect(await status(url, 'r1', r)).toBe(401);
        call = await post(server, url, 'r1', r);

        // The refused token's session is the older idle one, and it goes.
        const y = await c.open('y1');
        expect(await sessions(url)).toBe(2);
        expect(await status(url, 'x1', x)).toBe(200);
        expect(await status(url, 'y1', y)).toBe(200);
        call.finish();
        expect(await call.done).toBe(404);
      } finally {
        call?.abandon();
        await stop(server);
      }
    });

    // An upload that began before the platform refused the token was still
    // counted once it had: the refused account's sessions were all spared,
    // so its largest share had nothing idle and the pool 503'd a newcomer.
    it('stops sparing a session for an upload once its token is refused mid-upload', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = { r1: 'acc-r', x1: 'acc-x', y1: 'acc-y', z1: 'acc-z' };
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        maxSessions: 4,
        bearerCheckTtlMs: 0,
      });
      const calls: Array<Awaited<ReturnType<typeof post>>> = [];
      try {
        const c = client(url);
        const r = [await c.open('r1')];
        await pause();
        r.push(await c.open('r1'));
        await pause();
        const x = await c.open('x1');
        await pause();
        const z = await c.open('z1');
        expect(await sessions(url)).toBe(4);
        // Marked while the token was still good.
        for (const session of r) calls.push(await post(server, url, 'r1', session));
        platform.refused.add('r1');
        for (const session of r) expect(await status(url, 'r1', session)).toBe(401);

        // acc-r holds the most; its uploads no longer spare its sessions.
        const y = await c.open('y1');
        expect(await sessions(url)).toBe(4);
        expect(await status(url, 'x1', x)).toBe(200);
        expect(await status(url, 'z1', z)).toBe(200);
        expect(await status(url, 'y1', y)).toBe(200);
        for (const call of calls) call.finish();
        expect(await Promise.all(calls.map((call) => call.done))).toContain(404);
      } finally {
        for (const call of calls) call.abandon();
        await stop(server);
      }
    });

    // Once the route has taken a request over, releasing its pin is the
    // route's job, whenever the response closes: a client that went away
    // while its bearer was being checked left the session looking idle to
    // an initialize making room, which closed it under the route.
    it('keeps a session busy while its route waits on the bearer check, though its client has gone', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = { t1: 'acc-1', t2: 'acc-2', t3: 'acc-3' };
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        maxSessions: 2,
        bearerCheckTtlMs: 0,
      });
      let release = () => {};
      let call: Awaited<ReturnType<typeof post>> | undefined;
      try {
        const c = client(url);
        const a = await c.open('t1');
        await pause();
        const b = await c.open('t2');

        platform.state.probeGate = new Promise<void>((r) => {
          release = r;
        });
        const before = probes();
        call = await post(server, url, 't1', a, true);
        const deadline = Date.now() + 5000;
        while (probes() === before) {
          if (Date.now() > deadline) throw new Error('the request never reached its probe');
          await pause();
        }
        platform.state.probeGate = undefined;
        const closed = once(call.served, 'close');
        call.abandon();
        await closed;

        // The older idle session is a's, but its route is still running: b's goes.
        const d = await c.open('t3');
        expect(await sessions(url)).toBe(2);
        expect(await status(url, 't2', b)).toBe(404);
        expect(await status(url, 't1', a)).toBe(200);
        expect(await status(url, 't3', d)).toBe(200);
      } finally {
        platform.state.probeGate = undefined;
        release();
        call?.abandon();
        await stop(server);
      }
    });

    it('lands an initialize admitted before its account was suspended under the suspended limit', async () => {
      platform = platformWithRefusals();
      platform.state.accounts = accounts(['s1', 's2', 's3']);
      const original = StreamableHTTPServerTransport.prototype.handleRequest;
      let open = () => {};
      const gate = new Promise<void>((r) => {
        open = r;
      });
      let held = 0;
      const { server, url } = await start({ resourceMetadataUrl: METADATA, serviceSecret: SECRET });
      try {
        const c = client(url);
        await c.open('s1');
        await pause();
        const b = await c.open('s2');

        // s1's second initialize is admitted on its cached active answer and
        // held before it lands.
        StreamableHTTPServerTransport.prototype.handleRequest = async function (...args) {
          if (!this.sessionId && held === 0) {
            held++;
            await gate;
          }
          return original.apply(this, args);
        };
        const late = c.send(INIT, as('s1'));
        const deadline = Date.now() + 5000;
        while (held === 0) {
          if (Date.now() > deadline) throw new Error('the initialize was never held');
          await pause();
        }

        // Meanwhile a new token's probe finds the account suspended.
        platform.state.suspended = true;
        const over = await c.send(INIT, as('s3'));
        expect(over.status).toBe(429);
        await over.text();

        open();
        const landed = await late;
        expect(landed.status).toBe(200);
        await landed.text();
        expect(await sessions(url)).toBe(1);
        expect(await status(url, 's2', b)).toBe(404);
        expect(await status(url, 's1', landed.headers.get('mcp-session-id') as string)).toBe(200);
      } finally {
        open();
        StreamableHTTPServerTransport.prototype.handleRequest = original;
        await stop(server);
      }
    });

    // Whoami named no account id, so the token's session counted against its
    // own bucket; later the same token was confirmed as an account, and the
    // session closed under its per-token cap was subtracted from the
    // account's count, which it had never been part of.
    it('counts a token’s session from before its account was confirmed against the token alone', async () => {
      platform = platformWithRefusals();
      platform.state.noAccountId = true;
      const { server, url } = await start({
        resourceMetadataUrl: METADATA,
        serviceSecret: SECRET,
        maxSessions: 4,
        maxSessionsPerBearer: 1,
        bearerCheckTtlMs: 0,
      });
      try {
        const c = client(url);
        const early = await c.open('k0');
        await pause();
        platform.state.noAccountId = false;
        platform.state.accounts = accounts(['k0', 'k1', 'k2']);
        const k1 = await c.open('k1');
        await pause();
        const k2 = await c.open('k2');
        expect(await sessions(url)).toBe(3);

        // k0, now confirmed, is at its per-token cap, and its account at its
        // ceiling of two: its own old session goes for the one, and the
        // account's least recently used for the other.
        const k0 = await c.open('k0');
        expect(await sessions(url)).toBe(2);
        expect(await status(url, 'k0', early)).toBe(404);
        expect(await status(url, 'k1', k1)).toBe(404);
        expect(await status(url, 'k2', k2)).toBe(200);
        expect(await status(url, 'k0', k0)).toBe(200);
      } finally {
        await stop(server);
      }
    });
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
