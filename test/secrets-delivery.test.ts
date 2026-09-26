import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretsOnTheirWay } from '../src/format.js';
import { namedSecret, SECRET_SET_RETRIES } from '../src/tools/secrets.js';
import { connect, installFakePlatform, SECRET, SECRET_LIST } from './harness.js';

// OPL-5048: set_secret, the upsert by name the SDKs and both CLIs already had,
// and wait_for_computer "guest" waiting for a bound computer's secrets to land.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const VALUE = 'sk-live-0123456789-do-not-echo';

type Seen = { method: string; path: string; body?: unknown };

/** A platform answering from `respond`, recording every request, for the length of `fn`. */
async function platform<T>(
  respond: (seen: Seen, n: number) => [number, unknown],
  fn: (seen: Seen[]) => Promise<T>,
): Promise<T> {
  const restore = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const call: Seen = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname.replace(/^\/api\/v1/, ''),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(call);
    const [status, body] = respond(call, seen.length);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = restore;
  }
}

describe('set_secret', () => {
  let fake: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    fake = installFakePlatform();
  });
  afterEach(() => fake.restore());

  it('replaces the secret the scope holds, matched ignoring ASCII case', async () => {
    const { call, close } = await connect();
    const res = await call('set_secret', { name: ' openai_api_key ', value: VALUE });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(`Replaced the value of ${SECRET.name} (${SECRET.id})`);
    expect(textOf(res)).not.toContain(VALUE);
    expect(fake.calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/secrets'],
      ['PUT', `/secrets/${SECRET.id}`],
    ]);
    expect(fake.calls[1]?.body).toEqual({ value: VALUE, revision_id: SECRET.revision_id });
    expect(textOf(res)).toContain('"created": false');
    await close();
  });

  it('creates a name the scope does not hold, trimmed as the platform trims it', async () => {
    const { call, close } = await connect();
    const res = await call('set_secret', {
      name: '  GITHUB_TOKEN ',
      value: VALUE,
      workspace_id: 'ws-1',
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Stored GITHUB_TOKEN as');
    expect(textOf(res)).toContain('"created": true');
    expect(textOf(res)).not.toContain(VALUE);
    expect(fake.calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/secrets'],
      ['POST', '/secrets'],
    ]);
    expect(fake.calls[1]?.body).toEqual({
      name: 'GITHUB_TOKEN',
      value: VALUE,
      workspace_id: 'ws-1',
    });
    await close();
  });
});

describe('set_secret against a platform that moves underneath it', () => {
  it('reads again after a conflict and sends the fresh revision', async () => {
    const fresh = 'csr-ffffffffffffffffffffffff';
    const res = await platform(
      (seen, n) => {
        if (seen.method === 'GET')
          return [
            200,
            {
              ...SECRET_LIST,
              secrets: [{ ...SECRET, revision_id: n === 1 ? SECRET.revision_id : fresh }],
            },
          ];
        return n === 2
          ? [409, { error: 'This secret changed since you read it.' }]
          : [200, { ...SECRET, revision_id: 'csr-0123456789abcdef01234599' }];
      },
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('set_secret', { name: SECRET.name, value: VALUE });
        await close();
        expect(
          seen.map((c) => [c.method, (c.body as { revision_id?: string })?.revision_id]),
        ).toEqual([
          ['GET', undefined],
          ['PUT', SECRET.revision_id],
          ['GET', undefined],
          ['PUT', fresh],
        ]);
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toContain(VALUE);
  });

  it('gives up after reading again three times, and says nothing changed', async () => {
    const res = await platform(
      (seen) => (seen.method === 'GET' ? [200, SECRET_LIST] : [409, { error: `nope ${VALUE}` }]),
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('set_secret', { name: SECRET.name, value: VALUE });
        await close();
        expect(seen.filter((c) => c.method === 'PUT')).toHaveLength(SECRET_SET_RETRIES + 1);
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('HTTP 409');
    expect(textOf(res)).not.toContain(VALUE);
  });

  it('never sends a write again after a 503', async () => {
    const res = await platform(
      (seen) =>
        seen.method === 'GET'
          ? [200, { ...SECRET_LIST, secrets: [] }]
          : [503, { error: 'the store could not answer' }],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('set_secret', { name: 'NEW_ONE', value: VALUE });
        await close();
        expect(seen.filter((c) => c.method === 'POST')).toHaveLength(1);
        return r;
      },
    );
    expect(res.isError).toBe(true);
  });

  it('matches names the way the platform keeps them unique', () => {
    const rows = [{ ...SECRET, name: 'OpenAI_Key' }];
    expect(namedSecret(rows, ' openai_key ')?.id).toBe(SECRET.id);
    expect(namedSecret(rows, 'openai-key')).toBeUndefined();
  });
});

describe('wait_for_computer on a computer with secrets bound', () => {
  const BINDING = { secret_id: SECRET.id, revision_id: SECRET.revision_id, env: 'TOKEN' };
  const bound = (extra: Record<string, unknown>) => ({
    id: 'vm-1',
    name: 'box',
    status: 'running',
    running_ram_mb: 2048,
    secrets: [BINDING],
    secrets_generation: 1,
    ...extra,
  });

  it('waits, with "guest", until the secrets have landed', async () => {
    let gets = 0;
    const res = await platform(
      (seen) => {
        if (seen.path.endsWith('/exec'))
          return [200, { exit_code: 0, stdout_b64: '', stderr_b64: '' }];
        gets++;
        return [200, bound({ secrets_delivering: gets === 1 })];
      },
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        // No guest probe while the values were still on their way.
        expect(seen.map((c) => [c.method, c.path])).toEqual([
          ['GET', '/computers/vm-1'],
          ['GET', '/computers/vm-1'],
          ['POST', '/computers/vm-1/exec'],
        ]);
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Guest is answering');
  });

  it('reads the receipt on a platform that predates secrets_delivering', async () => {
    let gets = 0;
    const res = await platform(
      (seen) => {
        if (seen.path.endsWith('/exec'))
          return [200, { exit_code: 0, stdout_b64: '', stderr_b64: '' }];
        gets++;
        // No secrets_delivering at all: the receipt trails the generation
        // until the values land, then names it.
        return [
          200,
          bound(
            gets === 1
              ? { secrets_applied: { generation: 0 } }
              : { secrets_applied: { generation: 1, applied_at: '2026-09-25T00:00:00Z' } },
          ),
        ];
      },
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        expect(seen.map((c) => [c.method, c.path])).toEqual([
          ['GET', '/computers/vm-1'],
          ['GET', '/computers/vm-1'],
          ['POST', '/computers/vm-1/exec'],
        ]);
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Guest is answering');
  });

  it('decides "on their way" from the field first, then the receipt', () => {
    const base = { status: 'running', secrets: [BINDING], secrets_generation: 2 };
    expect(secretsOnTheirWay({ ...base, secrets_delivering: false })).toBe(false);
    expect(secretsOnTheirWay({ ...base, secrets_delivering: true })).toBe(true);
    expect(secretsOnTheirWay(base)).toBe(true);
    expect(secretsOnTheirWay({ ...base, secrets_applied: { generation: 1 } })).toBe(true);
    expect(secretsOnTheirWay({ ...base, secrets_applied: { generation: 2 } })).toBe(false);
    expect(secretsOnTheirWay({ status: 'running' })).toBe(false);
    expect(secretsOnTheirWay({ ...base, secrets_generation: 0 })).toBe(false);
  });

  it('waits, with "guest", for the secrets a restart delivers again', async () => {
    // A restart reads running before its secrets land; secrets_delivering is
    // true until they do, and the answer to the restart says to wait.
    let gets = 0;
    const res = await platform(
      (seen) => {
        if (seen.path.endsWith('/restart')) return [200, { ok: true }];
        if (seen.path.endsWith('/exec'))
          return [200, { exit_code: 0, stdout_b64: '', stderr_b64: '' }];
        gets++;
        return [200, bound({ secrets_delivering: gets === 1 })];
      },
      async (seen) => {
        const { call, close } = await connect();
        const restarted = await call('restart_computer', {});
        expect(textOf(restarted)).toContain('when they have been delivered again');
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        expect(seen.map((c) => [c.method, c.path])).toEqual([
          ['POST', '/computers/vm-1/restart'],
          ['GET', '/computers/vm-1'],
          ['GET', '/computers/vm-1'],
          ['POST', '/computers/vm-1/exec'],
        ]);
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Guest is answering');
  });

  it('does not wait for them with "running"', async () => {
    const res = await platform(
      () => [200, bound({ secrets_delivering: true })],
      async () => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'running', timeout_s: 30 });
        await close();
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('its secrets are still on their way in');
  });

  it('says why when the delivery failed and the platform stopped it', async () => {
    const res = await platform(
      () => [
        200,
        bound({
          status: 'stopped',
          running_ram_mb: 0,
          secrets_delivering: false,
          secrets_error: 'a secret could not be read',
        }),
      ],
      async () => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(
      'vm-1 is stopped. Its secrets were not delivered, so the platform stopped it: a secret could not be read. start_computer boots it.',
    );
  });
});
