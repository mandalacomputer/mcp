import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Api, SERVICE_HEADER } from '../src/api.js';
import { bearerChallenge, runHttp } from '../src/http.js';
import { BASE, installFakePlatform } from './harness.js';

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
    /** What `GET ssh-keys`, the bearer probe, answers instead of its list. */
    probeStatus?: number;
    probeDelayMs?: number;
    /** When set, every probe waits on this before answering. */
    probeGate?: Promise<void>;
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
    if (url.pathname.endsWith('/ssh-keys') && state.probeGate) await state.probeGate;
    if (url.pathname.endsWith('/ssh-keys') && state.probeDelayMs) {
      await new Promise((r) => setTimeout(r, state.probeDelayMs));
    }
    if (url.pathname.endsWith('/ssh-keys') && state.probeStatus !== undefined) {
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
    try {
      const c = client(url);
      const spend = await c.send(INIT, from('10.9.0.1', 'mcpat_spend'));
      expect(spend.status).toBe(401);
      await spend.text();

      // Fill the process-wide cap from other addresses: every probe is held
      // at the platform until all 32 have arrived and the turned-away request
      // has been answered, so the cap is full by construction, not by timing.
      let release!: () => void;
      platform.state.probeGate = new Promise<void>((r) => {
        release = r;
      });
      const base = probes();
      const fill = Array.from({ length: 32 }, (_, i) =>
        c.send(INIT, from(`10.9.1.${i + 1}`, `mcpat_fill${i}`)),
      );
      while (probes() < base + 32) await new Promise((r) => setTimeout(r, 5));
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
      await stop(server);
    }
  });

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
