/**
 * Agents on AI credits (OPL-5866): get_credits, run_agent registered without a
 * model key when GET /credits says the account can pay, and what a run on
 * credits reports — its cost, the balance left, and credits running out.
 */
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fundedAccount, topUpUrl } from '../src/credits.js';
import { runHttp } from '../src/http.js';
import { BASE, CREDITS, connect, FUNDED_CREDITS, installFakePlatform } from './harness.js';

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);
const sse = (frames: [string, unknown][], status = 200) =>
  new Response(
    frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
    {
      status,
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let platform: ReturnType<typeof installFakePlatform>;
const originalFetch = globalThis.fetch;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  platform = installFakePlatform();
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  platform.restore();
  globalThis.fetch = originalFetch;
});
async function open(cfg: Parameters<typeof connect>[0] = {}) {
  const connection = await connect(cfg);
  closers.push(connection.close);
  return connection;
}

/** Replace the platform's answer for the agent route, recording every request. */
function agentAnswers(answer: () => Response) {
  const seen: { url: URL; init?: RequestInit }[] = [];
  const fake = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, init });
    if (url.pathname.endsWith('/agent')) return answer();
    return fake(input as never, init);
  }) as typeof fetch;
  return seen;
}

describe('get_credits', () => {
  it('reads the ledger with its paging parameters and says what is available', async () => {
    platform.state.credits = FUNDED_CREDITS;
    const { call } = await open();
    const result = await call('get_credits', { before: 8, limit: 10 });
    expect(result.isError).toBeFalsy();
    const request = platform.calls.at(-1)!;
    expect(request.path).toBe('/credits');
    expect(Object.fromEntries(request.query)).toEqual({ before: '8', limit: '10' });
    const said = textOf(result);
    expect(said.split('\n')[0]).toBe(
      '$4.50 available (balance $4.75, held $0.25, debt $0.00). Older journal entries: before=8.',
    );
    expect(said).toContain('"granted_micros": 5000000');
  });

  it('says a frozen account cannot spend what it holds', async () => {
    platform.state.credits = { ...FUNDED_CREDITS, available_micros: 0, frozen: true };
    const { call } = await open();
    expect(textOf(await call('get_credits'))).toContain('FROZEN');
    expect(platform.calls.at(-1)?.query.toString()).toBe('');
  });

  it('refuses a ledger it cannot read rather than reporting zero', async () => {
    platform.state.credits = { ...CREDITS, available_micros: '4500000' };
    const { call } = await open();
    const result = await call('get_credits');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Malformed');
  });

  it('relays the platform refusing a workspace-scoped key', async () => {
    globalThis.fetch = (async () =>
      json(
        {
          error:
            'AI credits belong to the whole account. Use an account-wide API key to read its credit ledger.',
        },
        403,
      )) as typeof fetch;
    const { call } = await open();
    const result = await call('get_credits');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('account-wide API key');
  });

  it('refuses a page size past the platform maximum before any request', async () => {
    const { call } = await open();
    const before = platform.calls.length;
    expect((await call('get_credits', { limit: 101 })).isError).toBe(true);
    expect(platform.calls).toHaveLength(before);
  });
});

describe('deciding whether the account is funded', () => {
  it('is funded only when not frozen and a first model call can be reserved', async () => {
    for (const [credits, expected] of [
      [FUNDED_CREDITS, true],
      [{ ...FUNDED_CREDITS, available_micros: 250_000 }, true],
      [{ ...FUNDED_CREDITS, available_micros: 249_999 }, false],
      [{ ...FUNDED_CREDITS, available_micros: -1_000_000 }, false],
      [{ ...FUNDED_CREDITS, frozen: true }, false],
      [CREDITS, false],
    ] as const) {
      platform.state.credits = credits;
      expect(await fundedAccount('com_test', BASE)).toBe(expected);
    }
    // One journal entry: only the summary decides.
    expect(platform.calls.at(-1)?.query.get('limit')).toBe('1');
    expect(platform.calls.at(-1)?.headers.authorization).toBe('Bearer com_test');
  });

  it.each([
    ['a malformed record', () => json({ ...FUNDED_CREDITS, frozen: 'no' })],
    ['a non-object', () => json([FUNDED_CREDITS])],
    ['a workspace-scoped refusal', () => json({ error: 'account-wide key needed' }, 403)],
    ['a refused credential', () => json({ error: 'nope', reason: 'invalid' }, 401)],
    ['a server error', () => json({ error: 'down' }, 503)],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    [
      'an HTML page',
      () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
    ],
  ])('fails closed on %s', async (_label, answer) => {
    globalThis.fetch = (async () => answer()) as typeof fetch;
    expect(await fundedAccount('com_test', BASE)).toBe(false);
  });

  it('fails closed when the platform does not answer in time', async () => {
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
    const started = Date.now();
    expect(await fundedAccount('com_test', BASE, {}, { timeoutMs: 50 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('run_agent on credits', () => {
  it('is registered without a model key only for a funded session, and run_agent_chat never is', async () => {
    expect(await names((await open()).client)).not.toContain('run_agent');
    const funded = await names((await open({ funded: true })).client);
    expect(funded).toContain('run_agent');
    expect(funded).not.toContain('run_agent_chat');
    expect(funded).toContain('get_credits');
  });

  it('takes max_cost_usd and not system or provider, and says credits pay', async () => {
    const { client } = await open({ funded: true });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'run_agent')!;
    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual(
      // thread_id and store keep and continue a conversation (OPL-6085).
      ['computer_id', 'max_cost_usd', 'max_steps', 'model', 'prompt', 'store', 'thread_id'].sort(),
    );
    expect(props.max_cost_usd).toMatchObject({ minimum: 0.25, maximum: 20 });
    expect(tool.description).toContain("account's Mandala AI credits");
    expect(tool.description).not.toContain('configured with');
  });

  it('keeps the keyed tool as it was when a model key is present, funded or not', async () => {
    const { client } = await open({ modelKey: 'sk-test', funded: true });
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === 'run_agent')!;
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('system');
    expect(props).toHaveProperty('provider');
    expect(props).not.toHaveProperty('max_cost_usd');
    expect(tools.map((t) => t.name)).toContain('run_agent_chat');
  });

  it('sends no model key and the cost cap, and reports cost and credits left', async () => {
    const seen = agentAnswers(() =>
      sse([
        [
          'step',
          {
            n: 1,
            tool: 'computer',
            action: 'screenshot',
            detail: 'took a screenshot',
            cost_usd: 0.031,
            credits_remaining_usd: 4.469,
          },
        ],
        [
          'step',
          {
            n: 2,
            tool: 'computer',
            action: 'left_click',
            detail: 'clicked',
            cost_usd: 0.062,
            credits_remaining_usd: 4.438,
          },
        ],
        ['done', { steps: 2, stop: 'end_turn', text: 'Done.', usage: {}, cost_usd: 0.062 }],
      ]),
    );
    const { call } = await open({ funded: true });
    const result = await call('run_agent', { prompt: 'open firefox', max_cost_usd: 1.5 });
    expect(result.isError).toBeFalsy();
    const request = seen.find((s) => s.url.pathname.endsWith('/agent'))!;
    const headers = new Headers(request.init?.headers);
    expect(headers.has('x-model-key')).toBe(false);
    expect(JSON.parse(String(request.init?.body))).toEqual({
      prompt: 'open firefox',
      max_steps: 20,
      max_cost_usd: 1.5,
      stream: true,
    });
    const said = textOf(result);
    expect(said).toContain('Cost: $0.06 of AI credits spent; $4.44 left on the account.');
    expect(said).toContain('"cost_usd": 0.062');
    expect(said).toContain('"credits_remaining_usd": 4.438');
  });

  it('leaves max_cost_usd to the platform when it is not given', async () => {
    const seen = agentAnswers(() =>
      sse([['done', { steps: 0, stop: 'end_turn', text: 'ok', usage: {} }]]),
    );
    const { call } = await open({ funded: true });
    await call('run_agent', { prompt: 'go' });
    const body = JSON.parse(
      String(seen.find((s) => s.url.pathname.endsWith('/agent'))!.init?.body),
    );
    expect(body).not.toHaveProperty('max_cost_usd');
  });

  it.each([0.2, 20.5])('refuses max_cost_usd %s before any request', async (max_cost_usd) => {
    const { call } = await open({ funded: true });
    const before = platform.calls.length;
    expect((await call('run_agent', { prompt: 'go', max_cost_usd })).isError).toBe(true);
    expect(platform.calls).toHaveLength(before);
  });

  it.each([
    ['credits_exhausted', 'RAN OUT OF AI CREDITS'],
    ['max_cost', 'REACHED max_cost_usd'],
  ])('reads stop %s as a run that did not finish', async (stop, verdict) => {
    agentAnswers(() =>
      sse([['done', { steps: 3, stop, text: 'partway', usage: {}, cost_usd: 1.52 }]]),
    );
    const { call } = await open({ funded: true });
    const result = await call('run_agent', { prompt: 'go' });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith(verdict)).toBe(true);
    expect(textOf(result)).toContain('Cost: $1.52 of AI credits spent.');
  });

  it('calls a 402 naming a top-up page credits exhausted, not a plan or provider limit', async () => {
    agentAnswers(() => json({ error: 'Insufficient AI credits', top_up_url: '/billing' }, 402));
    const { call } = await open({ funded: true });
    const result = await call('run_agent', { prompt: 'go' });
    expect(result.isError).toBe(true);
    const said = textOf(result);
    expect(said).toContain('Insufficient AI credits (HTTP 402)');
    expect(said).toContain('AI credits cannot cover the run');
    expect(said).toContain('https://api.test/billing');
    expect(said).not.toContain('plan on this account');
    expect(said).not.toContain('billing_error');
  });

  it('calls a streamed 402 naming a top-up page credits exhausted, with what it cost', async () => {
    agentAnswers(() =>
      sse([
        [
          'error',
          {
            error: 'Insufficient AI credits',
            status: 402,
            top_up_url: '/billing',
            cost_usd: 0,
            usage: {},
            steps: [],
          },
        ],
      ]),
    );
    const { call } = await open({ funded: true });
    const result = await call('run_agent', { prompt: 'go' });
    expect(result.isError).toBe(true);
    const said = textOf(result);
    expect(said).toContain("HTTP 402: this Mandala account's AI credits cannot cover the run");
    expect(said).toContain('https://api.test/billing');
    expect(said).not.toContain('billing_error');
    expect(said).toContain('"cost_usd": 0');
  });

  it('still reads a streamed 402 without a top-up page as the model provider on a keyed run', async () => {
    agentAnswers(() =>
      sse([['error', { error: 'credit balance too low', status: 402, usage: {}, steps: [] }]]),
    );
    const { call } = await open({ modelKey: 'sk-test' });
    const said = textOf(await call('run_agent', { prompt: 'go' }));
    expect(said).toContain('billing_error');
    expect(said).not.toContain('AI credits cannot cover');
  });
});

describe('run_agent on credits: what a failure means (parity with the SDKs)', () => {
  const failing = (frame: Record<string, unknown>, steps: [string, unknown][] = []) =>
    agentAnswers(() => sse([...steps, ['error', { usage: {}, steps: [], ...frame }]]));

  it.each([401, 403, 404, 413, 429, 503, 529])(
    'reads a funded %i in the platform AI-service words as that service failing',
    async (status) => {
      failing({ status, error: 'Mandala AI is unavailable' }, [
        [
          'step',
          { n: 1, tool: 'computer', action: 'left_click', detail: 'clicked', cost_usd: 0.03 },
        ],
      ]);
      const { call } = await open({ funded: true });
      const result = await call('run_agent', { prompt: 'go' });
      expect(result.isError).toBe(true);
      const said = textOf(result);
      expect(said).toContain(`HTTP ${status}: the platform's AI service could not serve this run`);
      expect(said).toContain('send only what is left');
      // Not the readings the same status gets elsewhere.
      expect(said).not.toContain('credential was refused');
      expect(said).not.toContain('configured model key');
      expect(said).not.toContain('Mandala account no longer permits');
    },
  );

  it('reads a funded 402 without a top-up page as the AI service, not a provider billing error', async () => {
    failing({ status: 402, error: 'payment required' });
    const { call } = await open({ funded: true });
    const said = textOf(await call('run_agent', { prompt: 'go' }));
    expect(said).toContain("the platform's AI service could not serve this run");
    expect(said).not.toContain('billing_error');
  });

  it.each([
    ['an empty body', () => new Response(null, { status: 402 })],
    [
      'a plain-text body',
      () =>
        new Response('Payment Required', {
          status: 402,
          headers: { 'Content-Type': 'text/plain' },
        }),
    ],
    ['a JSON null', () => json(null, 402)],
  ])('reads a funded 402 before the stream with %s as the AI service', async (_label, answer) => {
    agentAnswers(answer);
    const { call } = await open({ funded: true });
    const said = textOf(await call('run_agent', { prompt: 'go' }));
    expect(said).toContain("the platform's AI service could not serve this run");
    expect(said).not.toContain('plan on this account');
  });

  it('keeps the revoked reading of the platform credential check on a funded run', async () => {
    failing({ status: 403, error: 'API key revoked', reason: 'revoked' });
    const { call } = await open({ funded: true });
    const said = textOf(await call('run_agent', { prompt: 'go' }));
    expect(said).toContain('Mandala account no longer permits the run');
    expect(said).not.toContain('AI service');
  });

  it('keeps the model-key readings on a keyed run, whatever the words', async () => {
    failing({ status: 401, error: 'Mandala AI is unavailable' });
    const { call } = await open({ modelKey: 'sk-test' });
    const said = textOf(await call('run_agent', { prompt: 'go' }));
    expect(said).not.toContain('AI service');
    expect(said).toContain('credential was refused');
  });

  it('reads a funded refusal before the stream as the AI service, not a change that may have happened', async () => {
    agentAnswers(() => json({ error: 'Mandala AI is unavailable' }, 503));
    const { call } = await open({ funded: true });
    const said = textOf(await call('run_agent', { prompt: 'go' }));
    expect(said).toContain('Mandala AI is unavailable (HTTP 503)');
    expect(said).toContain("the platform's AI service could not serve this run");
    expect(said).not.toContain('MAY OR MAY NOT HAVE HAPPENED');
  });

  it('names the insufficient_credits code and the resolved top-up page on both 402 paths', async () => {
    agentAnswers(() => json({ error: 'Insufficient AI credits', top_up_url: '/billing' }, 402));
    const first = await open({ funded: true });
    const before = textOf(await first.call('run_agent', { prompt: 'go' }));
    expect(before).toContain('"code": "insufficient_credits"');
    expect(before).toContain('"top_up_url": "https://api.test/billing"');
    globalThis.fetch = originalFetch;
    platform.restore();
    platform = installFakePlatform();
    failing({ status: 402, error: 'Insufficient AI credits', top_up_url: '/billing' });
    const second = await open({ funded: true });
    const streamed = textOf(await second.call('run_agent', { prompt: 'go' }));
    expect(streamed).toContain('"code": "insufficient_credits"');
    expect(streamed).toContain('"top_up_url": "https://api.test/billing"');
  });

  it.each([
    ['pause_turn', 'kept pausing its turn'],
    ['incomplete', 'response was incomplete'],
    ['safety_check', 'STOPPED FOR A SAFETY CHECK'],
  ])('reads stop %s as a run that did not finish', async (stop, verdict) => {
    agentAnswers(() => sse([['done', { steps: 1, stop, text: '', usage: {} }]]));
    const { call } = await open({ funded: true });
    const result = await call('run_agent', { prompt: 'go' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(verdict);
  });

  it('reports only a finite, non-negative cost, and a balance that may be negative', async () => {
    agentAnswers(() =>
      sse([
        ['step', { n: 1, tool: 'computer', detail: 'clicked', credits_remaining_usd: -0.12 }],
        ['done', { steps: 1, stop: 'end_turn', text: 'ok', usage: {}, cost_usd: -1 }],
      ]),
    );
    const { call } = await open({ funded: true });
    const said = textOf(await call('run_agent', { prompt: 'go' }));
    expect(said).toContain('Cost: -$0.12 left on the account.');
    expect(said).not.toContain('of AI credits spent');
    expect(said).not.toContain('"cost_usd"');
    expect(said).toContain('"credits_remaining_usd": -0.12');
  });
});

describe('topUpUrl', () => {
  it('resolves the platform page against the API origin, and only for a 402', () => {
    expect(topUpUrl(402, { top_up_url: '/billing' }, 'https://app.mandala.computer/api/v1')).toBe(
      'https://app.mandala.computer/billing',
    );
    expect(topUpUrl(400, { top_up_url: '/billing' }, BASE)).toBeUndefined();
    expect(topUpUrl(402, { top_up_url: '' }, BASE)).toBeUndefined();
    expect(topUpUrl(402, { top_up_url: 'javascript:alert(1)' }, BASE)).toBeUndefined();
    expect(topUpUrl(402, { error: 'billing_error' }, BASE)).toBeUndefined();
    expect(topUpUrl(402, null, BASE)).toBeUndefined();
  });
});

describe('the hosted transport', () => {
  async function serve(extra: Record<string, unknown> = {}) {
    const server = await runHttp({
      port: 0,
      host: '127.0.0.1',
      baseUrl: BASE,
      modelKey: 'sk-operator',
      ...extra,
    });
    closers.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  }
  async function session(url: URL, headers: Record<string, string>) {
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    const client = new Client({ name: 'credits-test', version: '0' });
    await client.connect(transport);
    closers.unshift(async () => {
      if (transport.sessionId) await transport.terminateSession();
      await client.close();
    });
    return client;
  }

  it('asks about credits per session, on the caller bearer, never the operator key', async () => {
    const url = await serve();
    platform.state.credits = FUNDED_CREDITS;
    const funded = await session(url, { Authorization: 'Bearer com_funded' });
    platform.state.credits = CREDITS;
    const unfunded = await session(url, { Authorization: 'Bearer com_unfunded' });
    expect(await names(funded)).toContain('run_agent');
    expect(await names(funded)).not.toContain('run_agent_chat');
    expect(await names(unfunded)).not.toContain('run_agent');
    const asked = platform.calls.filter((c) => c.path === '/credits');
    expect(asked.map((c) => c.headers.authorization)).toEqual([
      'Bearer com_funded',
      'Bearer com_unfunded',
    ]);
    // The funded session's run carries no model key: not the operator's, and
    // not one it never sent.
    await funded.callTool({ name: 'run_agent', arguments: { prompt: 'go', computer_id: 'vm-1' } });
    const run = platform.calls.at(-1)!;
    expect(run.path).toBe('/computers/vm-1/agent');
    expect(run.headers.authorization).toBe('Bearer com_funded');
    expect(run.headers).not.toHaveProperty('x-model-key');
  });

  it('does not ask when the caller brings a model key, and runs on that key', async () => {
    const url = await serve();
    platform.state.credits = FUNDED_CREDITS;
    const keyed = await session(url, {
      Authorization: 'Bearer com_keyed',
      'X-Model-Key': 'sk-caller',
    });
    expect(await names(keyed)).toEqual(expect.arrayContaining(['run_agent', 'run_agent_chat']));
    expect(platform.calls.filter((c) => c.path === '/credits')).toEqual([]);
  });

  it('builds nothing for a caller that leaves during the credits read', async () => {
    // One session per bearer, so the second initialize has to make room by
    // closing the first, idle one — which it must not do for nobody.
    const url = await serve({ maxSessionsPerBearer: 1 });
    const kept = await session(url, { Authorization: 'Bearer com_same' });
    expect(await names(kept)).toContain('get_credits');

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const fake = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!new URL(String(input)).pathname.endsWith('/credits')) return fake(input as never, init);
      reached();
      const signal = init?.signal;
      await Promise.race([
        held,
        new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
      ]);
      return json(FUNDED_CREDITS);
    }) as typeof fetch;

    const gone = new AbortController();
    const initialize = fetch(url, {
      method: 'POST',
      signal: gone.signal,
      headers: {
        Authorization: 'Bearer com_same',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'gone', version: '0' },
        },
      }),
    }).catch(() => undefined);
    await arrived;
    gone.abort();
    await initialize;
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    globalThis.fetch = fake;

    // The first session is still there, and still the only one.
    expect(await names(kept)).toContain('get_credits');
    const health = (await (await fetch(url.toString().replace(/\/mcp$/, '/healthz'))).json()) as {
      sessions: number;
    };
    expect(health.sessions).toBe(1);
  });

  it('answers a hosted initialize 401 when the credits read refuses its bearer', async () => {
    const url = await serve({
      resourceMetadataUrl: 'https://app.mandala.computer/.well-known/oauth-protected-resource/mcp',
      serviceSecret: 'svc-0123456789abcdef',
    });
    // whoami accepts the token; the credits read, a moment later, refuses it.
    const fake = globalThis.fetch;
    let refuse = true;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      refuse && new URL(String(input)).pathname.endsWith('/credits')
        ? new Response(JSON.stringify({ error: 'invalid or expired access token' }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'WWW-Authenticate': 'Bearer error="invalid_token"',
            },
          })
        : fake(input as never, init)) as typeof fetch;
    const initialize = () =>
      fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer mcpat_revoked',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'revoked', version: '0' },
          },
        }),
      });
    const refused = await initialize();
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(refused.headers.get('mcp-session-id')).toBeNull();
    await refused.text();
    const health = async () =>
      (
        (await (await fetch(url.toString().replace(/\/mcp$/, '/healthz'))).json()) as {
          sessions: number;
        }
      ).sessions;
    expect(await health()).toBe(0);
    // Its acceptance was dropped: the next initialize asks whoami again.
    refuse = false;
    const asked = platform.calls.filter((c) => c.path === '/whoami').length;
    const admitted = await initialize();
    expect(admitted.status).toBe(200);
    await admitted.text();
    expect(platform.calls.filter((c) => c.path === '/whoami')).toHaveLength(asked + 1);
  });

  describe('a bearer the credits read refuses, hosted', () => {
    const hosted = () =>
      serve({
        resourceMetadataUrl:
          'https://app.mandala.computer/.well-known/oauth-protected-resource/mcp',
        serviceSecret: 'svc-0123456789abcdef',
      });
    const initialize = (url: URL, bearer: string, signal?: AbortSignal) =>
      fetch(url, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'refused', version: '0' },
          },
        }),
      });
    const whoamis = () => platform.calls.filter((c) => c.path === '/whoami').length;
    /** A credits 401 refusing the bearer; with `hang`, its body never ends until cancelled. */
    const refusing = (hang = false, onRefuse: () => void = () => {}) => {
      const fake = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (!new URL(String(input)).pathname.endsWith('/credits'))
          return fake(input as never, init);
        onRefuse();
        const body = hang
          ? new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  'abort',
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
            })
          : JSON.stringify({ error: 'invalid or expired access token' });
        return new Response(body, {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer error="invalid_token"',
          },
        });
      }) as typeof fetch;
      return () => {
        globalThis.fetch = fake;
      };
    };

    it('drops its acceptance even when the caller leaves mid-refusal', async () => {
      const url = await hosted();
      let reached = () => {};
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const restore = refusing(true, reached);
      const gone = new AbortController();
      const first = initialize(url, 'mcpat_stale', gone.signal).catch(() => undefined);
      await arrived;
      await new Promise((resolve) => setTimeout(resolve, 50));
      gone.abort();
      await first;
      await new Promise((resolve) => setTimeout(resolve, 100));
      restore();
      // The next initialize does not ride the stale acceptance: whoami is asked again.
      const asked = whoamis();
      const next = await initialize(url, 'mcpat_stale');
      expect(next.status).toBe(200);
      await next.text();
      expect(whoamis()).toBe(asked + 1);
    });

    it('lets no probe that started before the refusal restore the bearer', async () => {
      const url = await hosted();
      // The first whoami for this bearer is held until released; later ones answer.
      const fake = globalThis.fetch;
      let whoamiSeen = 0;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = () => {};
      const first = new Promise<void>((resolve) => {
        started = resolve;
      });
      let refuseCredits = true;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/whoami') && ++whoamiSeen === 1) {
          started();
          await held;
        }
        if (refuseCredits && path.endsWith('/credits'))
          return new Response(JSON.stringify({ error: 'invalid or expired access token' }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'WWW-Authenticate': 'Bearer error="invalid_token"',
            },
          });
        return fake(input as never, init);
      }) as typeof fetch;
      // Its own model key, so it makes no credits read of its own.
      const keyed = fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer mcpat_stale',
          'X-Model-Key': 'sk-caller',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'keyed', version: '0' },
          },
        }),
      });
      await first;
      // A second initialize is checked and then refused by its credits read.
      const refused = await initialize(url, 'mcpat_stale');
      expect(refused.status).toBe(401);
      await refused.text();
      // The first probe now answers: older than the refusal, it admits nothing.
      release();
      const late = await keyed;
      expect(late.status).toBe(401);
      expect(late.headers.get('mcp-session-id')).toBeNull();
      await late.text();
      // And the acceptance stays dropped: the next initialize asks whoami again.
      refuseCredits = false;
      const asked = whoamiSeen;
      const next = await initialize(url, 'mcpat_stale');
      expect(next.status).toBe(200);
      await next.text();
      expect(whoamiSeen).toBe(asked + 1);
      globalThis.fetch = fake;
    });

    it('commits no session for an initialize admitted before the refusal', async () => {
      const url = await hosted();
      const fake = globalThis.fetch;
      let creditsSeen = 0;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = () => {};
      const first = new Promise<void>((resolve) => {
        started = resolve;
      });
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (!new URL(String(input)).pathname.endsWith('/credits'))
          return fake(input as never, init);
        // The first read answers late, and well; the second refuses the bearer.
        if (++creditsSeen === 1) {
          started();
          await held;
          return json(FUNDED_CREDITS);
        }
        return new Response(JSON.stringify({ error: 'invalid or expired access token' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer error="invalid_token"',
          },
        });
      }) as typeof fetch;
      const early = initialize(url, 'mcpat_stale');
      await first;
      const refused = await initialize(url, 'mcpat_stale');
      expect(refused.status).toBe(401);
      await refused.text();
      release();
      const late = await early;
      await late.text();
      expect(late.status).not.toBe(200);
      const health = (await (await fetch(url.toString().replace(/\/mcp$/, '/healthz'))).json()) as {
        sessions: number;
      };
      expect(health.sessions).toBe(0);
      globalThis.fetch = fake;
    });

    it("marks the bearer's open sessions refused", async () => {
      const url = await hosted();
      const opened = await initialize(url, 'mcpat_stale');
      expect(opened.status).toBe(200);
      const id = opened.headers.get('mcp-session-id')!;
      await opened.text();
      const restore = refusing();
      const refused = await initialize(url, 'mcpat_stale');
      expect(refused.status).toBe(401);
      await refused.text();
      restore();
      // The open session's next request is answered as a refused bearer's.
      const call = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer mcpat_stale',
          'mcp-session-id': id,
          'mcp-protocol-version': '2025-06-18',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      expect(call.status).toBe(401);
      expect(call.headers.get('www-authenticate')).toContain('resource_metadata=');
      await call.text();
    });
  });

  it('never takes funded from the operator configuration', async () => {
    const url = await serve({ funded: true });
    const caller = await session(url, { Authorization: 'Bearer com_unfunded' });
    expect(await names(caller)).not.toContain('run_agent');
  });

  it('does not ask when the filters withhold run_agent', async () => {
    const url = await serve({ readOnly: true });
    platform.state.credits = FUNDED_CREDITS;
    const caller = await session(url, { Authorization: 'Bearer com_funded' });
    expect(await names(caller)).not.toContain('run_agent');
    expect(platform.calls.filter((c) => c.path === '/credits')).toEqual([]);
  });

  it('builds the session without run_agent when the credits read fails', async () => {
    const url = await serve();
    const fake = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname.endsWith('/credits')
        ? json({ error: 'down' }, 503)
        : fake(input as never, init)) as typeof fetch;
    const caller = await session(url, { Authorization: 'Bearer com_any' });
    const tools = await names(caller);
    expect(tools).not.toContain('run_agent');
    expect(tools).toContain('get_credits');
  });
});
