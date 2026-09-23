import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform, SECRET_BINDINGS } from './harness.js';

// The secret-binding tools: what a computer is bound to, and replacing that
// list. What is pinned is the request sent, the sentence a model acts on —
// including WHEN a change reaches the guest — and the refusals that stop it
// acting on a body this server could not read.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const BOUND = SECRET_BINDINGS.secrets[0];

describe('the secret-binding tools', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('reads one computer’s bindings by env, secret and revision', async () => {
    const { call, close } = await connect();
    const res = await call('get_computer_secrets', { computer_id: 'vm-7' });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain('vm-7 is bound to 1 secret (version 3');
    expect(text).toContain(`${BOUND.env} = ${BOUND.secret_id} @ ${BOUND.revision_id}`);
    expect(platform.calls.at(-1)).toMatchObject({
      method: 'GET',
      path: '/computers/vm-7/secrets',
    });
    await close();
  });

  it('sends the list as given, and the version only when there is one', async () => {
    const { call, close } = await connect();
    const keep = { ...BOUND };
    const fresh = { secret_id: 'csec-fedcba9876543210', env: 'GITHUB_TOKEN' };
    const first = await call('set_computer_secrets', {
      computer_id: 'vm-7',
      secrets: [keep, fresh],
    });
    expect(first.isError).toBeFalsy();
    await call('set_computer_secrets', { computer_id: 'vm-7', secrets: [], version: 3 });
    const puts = platform.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => [c.path, c.body])).toEqual([
      ['/computers/vm-7/secrets', { secrets: [keep, fresh] }],
      ['/computers/vm-7/secrets', { secrets: [], version: 3 }],
    ]);
    expect(puts[0].body).not.toHaveProperty('version');
    await close();
  });

  it('answers what the computer is now bound to, and when the guest gets it', async () => {
    const { call, close } = await connect();
    const set = textOf(
      await call('set_computer_secrets', {
        computer_id: 'vm-7',
        secrets: [{ secret_id: 'csec-fedcba9876543210', env: 'GITHUB_TOKEN' }],
      }),
    );
    expect(set).toContain('vm-7 is now bound to 1 secret (version 4');
    expect(set).toContain('GITHUB_TOKEN = csec-fedcba9876543210 @ csr-latest');
    expect(set).toContain('NEXT START OR RESTART');
    const cleared = textOf(
      await call('set_computer_secrets', { computer_id: 'vm-7', secrets: [] }),
    );
    expect(cleared).toMatch(/^vm-7 is now bound to no secrets \(version 4\)\./);
    expect(cleared).toContain('NEXT START OR RESTART');
    await close();
  });

  it('says in the description that the list is replaced and values are never shown', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const set = tools.find((t) => t.name === 'set_computer_secrets');
    const get = tools.find((t) => t.name === 'get_computer_secrets');
    expect(set?.description).toContain('WHOLE list');
    expect(set?.description).toContain('`secrets: []` removes every binding');
    expect(set?.description).toContain('NEXT START OR RESTART');
    expect(set?.description).toContain('409');
    expect(set?.description).toContain('NEVER shown');
    expect(set?.annotations?.readOnlyHint).not.toBe(true);
    expect(set?.annotations?.destructiveHint).toBe(true);
    expect(get?.description).toContain('NEVER shown');
    expect(get?.annotations?.readOnlyHint).toBe(true);
    await close();
  });
});

describe('the secret-binding tools over answers they cannot trust', () => {
  const over = async (
    body: unknown,
    status: number,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    const restore = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call(tool, args);
      await close();
      return res;
    } finally {
      globalThis.fetch = restore;
    }
  };

  it('surfaces a 409 with the platform’s own sentence', async () => {
    const error =
      'The secrets on this computer were changed since you read them. Read them again and save your change.';
    const res = await over({ error }, 409, 'set_computer_secrets', {
      computer_id: 'vm-1',
      secrets: [],
      version: 2,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(error);
    expect(textOf(res)).toContain('409');
    expect(textOf(res)).not.toContain('now bound');
  });

  it('reads a computer never bound as none, at version 0', async () => {
    const res = await over({ secrets: [], version: 0 }, 200, 'get_computer_secrets', {
      computer_id: 'vm-1',
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('vm-1 is bound to no secrets (version 0)');
  });

  it('does not call an unreadable listing an empty one', async () => {
    for (const body of [
      {},
      { secrets: [] },
      { secrets: 'none', version: 1 },
      { secrets: [null], version: 1 },
      { secrets: [{ ...BOUND, revision_id: 7 }], version: 1 },
      { secrets: [], version: -1 },
    ]) {
      const res = await over(body, 200, 'get_computer_secrets', { computer_id: 'vm-1' });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('This does not mean the computer has none');
    }
  });

  it('says a change may have been made when the answer cannot be read', async () => {
    const res = await over({ ok: true }, 200, 'set_computer_secrets', {
      computer_id: 'vm-1',
      secrets: [],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('THE CHANGE MAY HAVE BEEN MADE');
  });
});
