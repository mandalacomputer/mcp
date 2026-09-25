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

  it('shows none of a refusal\u2019s text, only the status, the reason word and its own sentence', async () => {
    const quoted = await answering(
      400,
      { error: `value "${VALUE}" is not allowed`, reason: 'unsupported' },
      async () => {
        const c = await connect();
        const r = await c.call('create_secret', { name: 'X_TOKEN', value: VALUE });
        await c.close();
        return r;
      },
    );
    expect(quoted.isError).toBe(true);
    const text = textOf(quoted);
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain('is not allowed');
    expect(text).toContain('HTTP 400, reason "unsupported"');
    expect(text).toContain('own message is not shown');

    // A platform that should never answer a value, answering one: the decoded
    // secret carries only the documented fields, so it goes no further.
    const echoed = await answering(200, { ...SECRET, value: VALUE }, async () => {
      const c = await connect();
      const r = await c.call('replace_secret', {
        secret_id: SECRET.id,
        value: 'x-other-value',
        revision_id: REV,
      });
      await c.close();
      return r;
    });
    expect(echoed.isError).toBeFalsy();
    expect(textOf(echoed)).not.toContain(VALUE);
  });

  // The Codex review's cases (OPL-5026): short values, a long value echoed in
  // an error the client would truncate, a JSON-escaped value, a reason that is
  // not a word, and a malformed success body. None may surface anywhere.
  const LONG = `sk-${'q'.repeat(600)}-tail`;
  const ESCAPED = 'pa"ss\\word\nwith-newline';
  const values = ['z', 'hunter', LONG, ESCAPED];
  it.each(values.map((v) => [v.length, v] as const))(
    'never shows a %i-character value in any answer',
    async (_n, v) => {
      const json = JSON.stringify(v).slice(1, -1);
      const bodies: [number, string][] = [
        [400, JSON.stringify({ error: `bad value ${v}` })],
        [409, JSON.stringify({ error: 'x', reason: v })],
        [400, `{"error":"${json}${' '.repeat(9000)}`],
        [502, `<html>${v}</html>`],
        [503, JSON.stringify({ error: v, request_id: v })],
        [200, `oops ${v}`],
        [201, JSON.stringify({ id: SECRET.id, echo: v })],
      ];
      for (const [status, raw] of bodies) {
        for (const tool of ['create_secret', 'replace_secret'] as const) {
          const restore = globalThis.fetch;
          globalThis.fetch = (async () =>
            new Response(raw, {
              status,
              headers: { 'Content-Type': 'application/json' },
            })) as typeof fetch;
          try {
            const c = await connect();
            const args =
              tool === 'create_secret'
                ? { name: 'A_TOKEN', value: v }
                : { secret_id: SECRET.id, value: v, revision_id: REV };
            const res = await c.call(tool, args);
            await c.close();
            const out = JSON.stringify(res);
            expect(res.isError, `${tool} ${status}`).toBe(true);
            expect(textOf(res).includes(v), `${tool} ${status} ${raw.slice(0, 40)}`).toBe(false);
            expect(out.includes(json), `${tool} ${status} escaped`).toBe(false);
            if (v.length > 20) expect(textOf(res)).not.toContain(v.slice(0, 20));
            // The Api itself: no thrown message or body carries it either.
            const api = new Api('com_test', BASE);
            const call =
              tool === 'create_secret'
                ? api.secrets.create({ name: 'A_TOKEN', value: v })
                : api.secrets.replace(SECRET.id, { value: v, revisionId: REV });
            const err = await call.then(
              () => undefined,
              (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(MandalaError);
            const thrown = `${(err as Error).message} ${JSON.stringify((err as { body?: unknown }).body ?? null)}`;
            if (v.length > 1) expect(thrown.includes(v), `Api ${status}`).toBe(false);
            if (v.length > 20) expect(thrown).not.toContain(v.slice(0, 20));
          } finally {
            globalThis.fetch = restore;
          }
        }
      }
    },
  );

  // The re-review (OPL-5026): a refusal whose `reason` or request id is a
  // PREFIX of the value passed a shape check and was shown. Only a documented
  // reason word and a platform-minted UUID get through, and neither if it
  // overlaps the value. No run of four characters of the value may surface.
  const LEAKY = `sk-${'qzxwvjk'.repeat(5)}qz`.slice(0, 36);
  const SHORT = 'qzxwvj';
  const ESCAPY = 'qz"xw\\vj-kq\nzx';
  const runs = (v: string) => {
    const out = new Set<string>();
    for (const form of [v, JSON.stringify(v).slice(1, -1)])
      for (let i = 0; i + 4 <= form.length; i++) out.add(form.slice(i, i + 4));
    return [...out];
  };
  const prefixCases = (
    v: string,
  ): [string, number, Record<string, unknown>, Record<string, string>][] => {
    const esc = JSON.stringify(v).slice(1, -1);
    const p32 = v.slice(0, 32);
    return [
      ['reason = a prefix', 409, { error: 'x', reason: p32 }, {}],
      ['reason = an escaped prefix', 409, { error: 'x', reason: esc.slice(0, 32) }, {}],
      ['request_id = a prefix', 400, { error: 'x', request_id: p32 }, {}],
      [
        'headers = prefixes',
        400,
        { error: 'x', reason: 'contention' },
        { 'X-Request-ID': v.slice(0, 20), Allow: p32, 'WWW-Authenticate': p32 },
      ],
      ['a short prefix as the reason', 409, { error: 'x', reason: v.slice(0, 4) }, {}],
    ];
  };

  it.each([
    ['a 36-character sk- value', LEAKY],
    ['a 6-character value', SHORT],
    ['a value that needs JSON escaping', ESCAPY],
  ])('lets no piece of %s through a refusal\u2019s metadata', async (_what, v) => {
    expect(LEAKY).toHaveLength(36);
    for (const [label, status, body, headers] of prefixCases(v)) {
      const restore = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json', ...headers },
        })) as typeof fetch;
      try {
        for (const tool of ['create_secret', 'replace_secret'] as const) {
          const c = await connect();
          const res = await c.call(
            tool,
            tool === 'create_secret'
              ? { name: 'A_TOKEN', value: v }
              : { secret_id: SECRET.id, value: v, revision_id: REV },
          );
          await c.close();
          const out = `${textOf(res)}\n${JSON.stringify(res)}`;
          for (const run of runs(v))
            expect(out.includes(run), `${tool} ${label}: ${run}`).toBe(false);
        }
        const api = new Api('com_test', BASE);
        for (const call of [
          () => api.secrets.create({ name: 'A_TOKEN', value: v }),
          () => api.secrets.replace(SECRET.id, { value: v, revisionId: REV }),
        ]) {
          const err = (await call().then(
            () => undefined,
            (e: unknown) => e,
          )) as Record<string, unknown> & Error;
          expect(err).toBeInstanceOf(MandalaError);
          const thrown = [
            err.message,
            JSON.stringify(err.body ?? null),
            String(err.reason),
            String(err.requestId),
            String(err.allow),
            String(err.wwwAuthenticate),
          ].join('\n');
          for (const run of runs(v))
            expect(thrown.includes(run), `Api ${label}: ${run}`).toBe(false);
        }
      } finally {
        globalThis.fetch = restore;
      }
    }
  });

  it('still shows a documented reason word and a platform request id', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const restore = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'x', reason: 'contention', request_id: 'not-it' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': id },
      })) as typeof fetch;
    try {
      const c = await connect();
      const res = await c.call('create_secret', { name: 'A_TOKEN', value: LEAKY });
      await c.close();
      expect(textOf(res)).toContain('reason "contention"');
      expect(textOf(res)).toContain(`Request id ${id}`);
      expect(textOf(res)).not.toContain('not-it');
    } finally {
      globalThis.fetch = restore;
    }
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

  it('answers a stale revision in its own words, not the platform’s', async () => {
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
    expect(textOf(res)).not.toContain(error);
    expect(textOf(res)).toContain('revision_id is no longer the current one');
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
