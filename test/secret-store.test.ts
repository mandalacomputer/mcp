import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';
import { MandalaError } from '../src/errors.js';
import { BASE, connect, installFakePlatform, SECRET, SECRET_LIST } from './harness.js';

// The account's secret store (OPL-4984 part 2, tools in OPL-5026). What is
// pinned: the requests sent, that a value goes in and never comes back out —
// in a success, a refusal, or an answer that should not have carried it — and
// that a malformed answer to a change says the change may have been made.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const VALUE = 'sk-live-0123456789-do-not-echo';
const REV = 'csr-0123456789abcdef01234567';

/** Answer every request with one status and body, for the length of `fn`. */
async function answering<T>(status: number, body: unknown, fn: () => Promise<T>): Promise<T> {
  const restore = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = restore;
  }
}

describe('the secret store tools', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('lists names, ids, revisions and limits, and says when binding is off', async () => {
    const { call, close } = await connect();
    const res = await call('list_secrets', {});
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain(`${SECRET.name}  ${SECRET.id}  revision ${SECRET.revision_id}`);
    expect(text).toContain('account-wide');
    expect(text).toContain('never delivered');
    expect(text).toContain('at most 100 secrets held at once');
    expect(platform.calls.at(-1)).toMatchObject({ method: 'GET', path: '/secrets' });
    expect([...(platform.calls.at(-1)?.query.keys() ?? [])]).toEqual([]);
    await close();

    const off = await answering(200, { ...SECRET_LIST, delivery: false }, async () => {
      const c = await connect();
      const r = await c.call('list_secrets', { workspace_id: 'ws-1' });
      await c.close();
      return r;
    });
    expect(textOf(off)).toContain('Binding secrets to computers is OFF');
  });

  it('sends the value once and never shows it, on a create and a replace', async () => {
    const { call, close } = await connect();
    const created = await call('create_secret', { name: 'OPENAI_API_KEY', value: VALUE });
    expect(created.isError).toBeFalsy();
    expect(textOf(created)).toContain(`Stored OPENAI_API_KEY as ${SECRET.id}`);
    expect(textOf(created)).not.toContain(VALUE);
    expect(platform.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/secrets',
      body: { name: 'OPENAI_API_KEY', value: VALUE },
    });

    const replaced = await call('replace_secret', {
      secret_id: SECRET.id,
      value: VALUE,
      revision_id: REV,
      workspace_id: 'ws-1',
    });
    expect(replaced.isError).toBeFalsy();
    expect(textOf(replaced)).toContain('now at revision csr-0123456789abcdef01234599');
    expect(textOf(replaced)).not.toContain(VALUE);
    expect(platform.calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: `/secrets/${SECRET.id}`,
      body: { value: VALUE, revision_id: REV, workspace_id: 'ws-1' },
    });
    await close();
  });

  it('keeps a value out of a refusal that quotes it, and out of an answer that carries it', async () => {
    const quoted = await answering(400, { error: `value "${VALUE}" is not allowed` }, async () => {
      const c = await connect();
      const r = await c.call('create_secret', { name: 'X_TOKEN', value: VALUE });
      await c.close();
      return r;
    });
    expect(quoted.isError).toBe(true);
    expect(textOf(quoted)).not.toContain(VALUE);
    expect(textOf(quoted)).toContain('[secret value withheld]');

    // A platform that should never answer a value, answering one: the decoded
    // secret carries only the documented fields, so it goes no further.
    const echoed = await answering(200, { ...SECRET, value: VALUE }, async () => {
      const c = await connect();
      const r = await c.call('replace_secret', {
        secret_id: SECRET.id,
        value: 'x',
        revision_id: REV,
      });
      await c.close();
      return r;
    });
    expect(echoed.isError).toBeFalsy();
    expect(textOf(echoed)).not.toContain(VALUE);
  });

  it('refuses an oversized value before sending, without quoting it', async () => {
    const { call, close } = await connect();
    const big = `secret-${'x'.repeat(4096)}`;
    const before = platform.calls.length;
    let res: CallToolResult | undefined;
    try {
      res = await call('create_secret', { name: 'BIG', value: big });
    } catch (err) {
      expect(String(err)).not.toContain(big.slice(0, 64));
    }
    if (res) {
      expect(res.isError).toBe(true);
      expect(textOf(res)).not.toContain(big.slice(0, 64));
    }
    expect(platform.calls.slice(before)).toEqual([]);
    await close();
  });

  it('says a create answered with something unreadable may have happened', async () => {
    const res = await answering(201, { id: SECRET.id }, async () => {
      const c = await connect();
      const r = await c.call('create_secret', { name: 'X_TOKEN', value: VALUE });
      await c.close();
      return r;
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('THE CHANGE MAY HAVE BEEN MADE');
    expect(textOf(res)).not.toContain(VALUE);
  });

  it('surfaces a stale revision with the platform’s sentence', async () => {
    const error = 'This secret was changed since you read it. Read it again and retry.';
    const res = await answering(409, { error }, async () => {
      const c = await connect();
      const r = await c.call('replace_secret', {
        secret_id: SECRET.id,
        value: VALUE,
        revision_id: REV,
      });
      await c.close();
      return r;
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(error);
  });

  it('deletes only with the revision and confirm, and names a miss', async () => {
    const { call, close } = await connect();
    const res = await call('delete_secret', {
      secret_id: SECRET.id,
      revision_id: REV,
      workspace_id: 'ws-1',
      confirm: true,
    });
    expect(res.isError).toBeFalsy();
    const sent = platform.calls.at(-1);
    expect(sent).toMatchObject({ method: 'DELETE', path: `/secrets/${SECRET.id}` });
    expect(Object.fromEntries(sent?.query ?? [])).toEqual({
      revision_id: REV,
      workspace_id: 'ws-1',
    });
    const before = platform.calls.length;
    let unconfirmed: CallToolResult | undefined;
    try {
      unconfirmed = await call('delete_secret', { secret_id: SECRET.id, revision_id: REV });
    } catch {
      unconfirmed = undefined;
    }
    if (unconfirmed) expect(unconfirmed.isError).toBe(true);
    expect(platform.calls.slice(before)).toEqual([]);
    await close();

    const missing = await answering(404, { error: 'no such secret' }, async () => {
      const c = await connect();
      const r = await c.call('delete_secret', {
        secret_id: SECRET.id,
        revision_id: REV,
        confirm: true,
      });
      await c.close();
      return r;
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('Nothing was deleted');
  });

  it('describes delete as destructive and what it breaks', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const del = tools.find((t) => t.name === 'delete_secret');
    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(del?.description).toContain('cannot be undone');
    expect(del?.description).toContain('next start is refused');
    for (const name of ['list_secrets', 'get_secret']) {
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of ['create_secret', 'replace_secret']) {
      expect(tools.find((t) => t.name === name)?.description).toContain('NEVER shown');
    }
    await close();
  });
});

describe('the Api secret store methods', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const api = () => new Api('com_test', BASE);

  it('reaches every store route with its documented parameters', async () => {
    const a = api();
    const list = await a.secrets.list({ workspaceId: 'ws-1' });
    expect(list.secrets[0]).toEqual({ ...SECRET, workspace_id: 'ws-1' });
    expect(list.limits.value_max_bytes).toBe(4096);
    const created = await a.secrets.create({ name: 'N', value: VALUE, workspaceId: null });
    expect(created).not.toHaveProperty('value');
    await a.secrets.get(SECRET.id);
    await a.secrets.replace(SECRET.id, { value: VALUE, revisionId: REV });
    await a.secrets.delete(SECRET.id, { revisionId: REV });
    expect(platform.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /secrets',
      'POST /secrets',
      `GET /secrets/${SECRET.id}`,
      `PUT /secrets/${SECRET.id}`,
      `DELETE /secrets/${SECRET.id}`,
    ]);
    expect(platform.calls[1].body).toEqual({ name: 'N', value: VALUE, workspace_id: null });
    expect(platform.calls[4].query.get('revision_id')).toBe(REV);
  });

  it('decodes strictly: a missing field is an error, an extra one is dropped', async () => {
    const bad = { ...SECRET, revision_id: undefined };
    await answering(200, bad, async () => {
      await expect(api().secrets.get(SECRET.id)).rejects.toBeInstanceOf(MandalaError);
    });
    await answering(200, { ...SECRET, value: VALUE, extra: 1 }, async () => {
      const got = await api().secrets.get(SECRET.id);
      expect(Object.keys(got).sort()).toEqual(Object.keys(SECRET).sort());
    });
    await answering(200, { ...SECRET_LIST, limits: { name_max_chars: 60 } }, async () => {
      await expect(api().secrets.list()).rejects.toThrow('not the documented secret shape');
    });
  });
});
