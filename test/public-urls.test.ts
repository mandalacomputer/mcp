import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publicUrlBody } from '../src/paths.js';
import { connect, installFakePlatform, PUBLIC_URL } from './harness.js';

// Public URLs (platform OPL-3753): a port inside a computer served on
// `https://<label>.<base_domain>`. What is pinned is what a model acts on: the
// first line of each answer — above all that a public URL is open to anyone
// with the link, and that the app must listen on 0.0.0.0 — the refusals that
// save a round trip which could only fail, and the bodies that are not public
// URLs and must not be described as one.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('public URL tools', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('creates on the selected computer, sending only what was given, and says who can open it', async () => {
    const { call, close } = await connect();
    const res = await call('create_public_url', { port: 3000 });
    const sent = platform.calls.find(
      (c) => c.method === 'POST' && c.path === '/computers/vm-1/public-urls',
    );
    expect(sent?.body).toEqual({ port: 3000 });
    const text = textOf(res);
    expect(text).toContain(
      'Created https://cool-thing.mandala.dev, serving port 3000 inside vm-1.',
    );
    expect(text).toContain('PUBLIC: anyone with the link can open it');
    expect(text).toContain('0.0.0.0:3000, not 127.0.0.1');
    expect(text).toContain('mandala-skip-warning: 1');
    await close();
  });

  it('says a private one opens only with this account’s key, which never reaches the app', async () => {
    const { call, close } = await connect();
    const res = await call('create_public_url', {
      computer_id: 'vm-2',
      port: 8080,
      label: '  my-demo ',
      access: 'private',
    });
    const sent = platform.calls.find((c) => c.method === 'POST');
    expect(sent?.path).toBe('/computers/vm-2/public-urls');
    expect(sent?.body).toEqual({ port: 8080, label: 'my-demo', access: 'private' });
    const text = textOf(res);
    expect(text).toContain('https://my-demo.mandala.dev');
    expect(text).toContain('private: only requests with an API key of this account');
    expect(text).not.toContain('anyone with the link');
    await close();
  });

  it('refuses port 22, a port out of range and an empty label before any request', async () => {
    expect(() => publicUrlBody({ port: 22 })).toThrow(/computer’s own SSH/);
    expect(() => publicUrlBody({ port: 0 })).toThrow(/1 to 65535/);
    expect(() => publicUrlBody({ port: 65536 })).toThrow(/1 to 65535/);
    expect(() => publicUrlBody({ port: 3000, label: '   ' })).toThrow(/must not be empty/);
    const { call, close } = await connect();
    const res = await call('create_public_url', { port: 22 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/computer’s own SSH/);
    expect(platform.calls.filter((c) => c.method === 'POST')).toEqual([]);
    await close();
  });

  it('refuses an empty update without a round trip, and sends only the named field', async () => {
    const { call, close } = await connect();
    const empty = await call('update_public_url', { url_id: PUBLIC_URL.id });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toMatch(/name a port, an access, or both/);
    expect(platform.calls.filter((c) => c.method === 'PATCH')).toEqual([]);

    const res = await call('update_public_url', { url_id: PUBLIC_URL.id, access: 'private' });
    const sent = platform.calls.find((c) => c.method === 'PATCH');
    expect(sent?.path).toBe(`/computers/vm-1/public-urls/${PUBLIC_URL.id}`);
    expect(sent?.body).toEqual({ access: 'private' });
    expect(textOf(res)).toContain('Updated https://cool-thing.mandala.dev: port 3000. private:');
    await close();
  });

  it('lists with the limit, and marks a URL the platform turned off', async () => {
    const { call, close } = await connect();
    const text = textOf(await call('list_public_urls', {}));
    expect(text).toContain('1 public URL on vm-1 (this computer may have 2), oldest first:');
    expect(text).toContain('https://cool-thing.mandala.dev → port 3000, public');
    await close();

    const off = await over(
      {
        enabled: false,
        reason: 'Public URLs are not enabled here.',
        base_domain: 'mandala.dev',
        limit: 2,
        public_urls: [{ ...PUBLIC_URL, disabled: true }],
      },
      200,
      'list_public_urls',
      {},
    );
    expect(textOf(off)).toContain(
      'PUBLIC URLS DO NOT ANSWER HERE: Public URLs are not enabled here.',
    );
    expect(textOf(off)).toContain('TURNED OFF BY THE PLATFORM');
  });

  it('says an empty listing is empty, and how many the computer may have', async () => {
    const res = await over(
      { enabled: true, base_domain: 'mandala.dev', limit: 5, public_urls: [] },
      200,
      'list_public_urls',
      {},
    );
    expect(textOf(res).split('\n')[0]).toBe(
      'No public URLs on vm-1. create_public_url makes one; this computer may have 5.',
    );
  });

  it('does not read a body that is not a listing as a computer with no URLs', async () => {
    for (const body of [[], { public_urls: 'nope' }, { enabled: true, public_urls: [] }]) {
      const res = await over(body, 200, 'list_public_urls', {});
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('This is not a computer with no public URLs');
    }
    const malformed = await over(
      { enabled: true, base_domain: 'mandala.dev', limit: 2, public_urls: [{ id: 'pu-x' }] },
      200,
      'list_public_urls',
      {},
    );
    expect(malformed.isError).toBe(true);
    expect(textOf(malformed)).toContain('ignored 1 malformed public URL entry');
  });

  it('says a create MAY have happened when the answer is not a public URL', async () => {
    for (const body of [
      {},
      { ...PUBLIC_URL, url: 'http://cool-thing.mandala.dev' },
      // Codex, round 2 on #212: a link that is https only by its prefix.
      { ...PUBLIC_URL, url: 'https://' },
      { ...PUBLIC_URL, url: 'https://other-thing.mandala.dev' },
      { ...PUBLIC_URL, url: 'https://cool-thing.mandala.dev:8443' },
      { ...PUBLIC_URL, url: 'https://user:pw@cool-thing.mandala.dev' },
      { ...PUBLIC_URL, access: 'everyone' },
      { ...PUBLIC_URL, disabled: undefined },
    ]) {
      const res = await over(body, 201, 'create_public_url', { port: 3000 });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('THE URL MAY HAVE BEEN CREATED');
      // A warning about what it would be, never a claim about what it is.
      expect(textOf(res)).not.toContain('can open it');
    }
  });

  it('reads a malformed link as no public URL on an update or in a listing too', async () => {
    const update = await over({ ...PUBLIC_URL, url: 'https://' }, 200, 'update_public_url', {
      url_id: PUBLIC_URL.id,
      port: 8000,
    });
    expect(update.isError).toBe(true);
    expect(textOf(update)).toContain('THE CHANGE MAY HAVE LANDED');
    const list = await over(
      {
        enabled: true,
        base_domain: 'mandala.dev',
        limit: 2,
        public_urls: [PUBLIC_URL, { ...PUBLIC_URL, id: 'pu-1111111111111111', url: 'https://' }],
      },
      200,
      'list_public_urls',
      {},
    );
    expect(textOf(list)).toContain('ignored 1 malformed public URL entry');
    expect(textOf(list)).toContain('1 public URL on vm-1');
  });

  it('deletes, and reads a 404 as nothing deleted rather than as a deletion', async () => {
    const { call, close } = await connect();
    const res = await call('delete_public_url', { url_id: PUBLIC_URL.id, confirm: true });
    expect(platform.calls.find((c) => c.method === 'DELETE')?.path).toBe(
      `/computers/vm-1/public-urls/${PUBLIC_URL.id}`,
    );
    expect(textOf(res)).toContain(`Deleted ${PUBLIC_URL.id} from vm-1.`);
    await close();

    const gone = await over(
      { error: 'public URL not found on this computer' },
      404,
      'delete_public_url',
      { url_id: PUBLIC_URL.id, confirm: true },
    );
    expect(gone.isError).toBeFalsy();
    expect(textOf(gone)).toContain('Nothing was deleted');
    expect(textOf(gone)).not.toMatch(/^Deleted/);
  });

  // Codex, round 1 on #212: an unknown key was stripped, so a misspelled
  // `access: "private"` created a URL anyone can open.
  it('refuses an argument it does not know, sending nothing', async () => {
    const { call, close } = await connect();
    for (const [tool, args] of [
      ['create_public_url', { port: 3000, acess: 'private' }],
      ['list_public_urls', { computer: 'vm-2' }],
      ['update_public_url', { url_id: PUBLIC_URL.id, port: 8000, acces: 'private' }],
      ['delete_public_url', { url_id: PUBLIC_URL.id, confirm: true, computerid: 'vm-2' }],
    ] as const) {
      const res = await call(tool, args as Record<string, unknown>).catch((err: unknown) => ({
        isError: true,
        content: [{ type: 'text' as const, text: String(err) }],
      }));
      expect(res.isError, tool).toBe(true);
    }
    expect(platform.calls.filter((c) => c.path.includes('public-urls'))).toEqual([]);
    await close();
  });

  it('says a URL the platform turned off opens for nobody, on a create or an update', async () => {
    for (const [tool, args, status] of [
      ['create_public_url', { port: 3000 }, 201],
      ['update_public_url', { url_id: PUBLIC_URL.id, port: 8000 }, 200],
    ] as const) {
      const res = await over({ ...PUBLIC_URL, disabled: true }, status, tool, args);
      const text = textOf(res);
      expect(text).toContain('TURNED OFF BY THE PLATFORM');
      expect(text).not.toContain('anyone with the link can open it');
    }
  });

  it('does not say a URL stopped answering on a delete the platform did not acknowledge', async () => {
    for (const body of [{ ok: false }, {}, 'OK']) {
      const res = await over(body, 200, 'delete_public_url', {
        url_id: PUBLIC_URL.id,
        confirm: true,
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('MAY OR MAY NOT HAVE BEEN DELETED');
      expect(textOf(res)).not.toMatch(/^Deleted/);
    }
  });

  // Codex, round 3 on #212: a 2xx whose body cannot be read threw before the
  // check, and the change was reported as a plain failure — inviting a blind
  // retry of a create that may have made a URL open to anyone.
  it('says a change may have happened when its answer cannot be read at all', async () => {
    for (const raw of ['', 'null', '{not json']) {
      const create = await overRaw(raw, 201, 'create_public_url', { port: 3000 });
      expect(create.isError, `create ${JSON.stringify(raw)}`).toBe(true);
      expect(textOf(create)).toContain('THE URL MAY HAVE BEEN CREATED');
      expect(textOf(create)).toContain('open to anyone with the link');
      expect(textOf(create)).toContain('list_public_urls');

      const update = await overRaw(raw, 200, 'update_public_url', {
        url_id: PUBLIC_URL.id,
        access: 'private',
      });
      expect(update.isError, `update ${JSON.stringify(raw)}`).toBe(true);
      expect(textOf(update)).toContain('THE CHANGE MAY HAVE LANDED');

      const del = await overRaw(raw, 200, 'delete_public_url', {
        url_id: PUBLIC_URL.id,
        confirm: true,
      });
      expect(del.isError, `delete ${JSON.stringify(raw)}`).toBe(true);
      expect(textOf(del)).toContain('MAY OR MAY NOT HAVE BEEN DELETED');
    }
    // A private create is said to be private if it was made.
    const priv = await overRaw('', 201, 'create_public_url', { port: 3000, access: 'private' });
    expect(textOf(priv)).toContain('it is private');
  });

  it('marks the listing read-only, the update idempotent and the delete destructive', async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations ?? {};
    expect(hints('list_public_urls').readOnlyHint).toBe(true);
    expect(hints('create_public_url').readOnlyHint).toBeFalsy();
    expect(hints('create_public_url').idempotentHint).toBeFalsy();
    expect(hints('update_public_url').idempotentHint).toBe(true);
    expect(hints('delete_public_url')).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
    const create = tools.find((t) => t.name === 'create_public_url');
    expect(create?.description).toContain('PUBLIC BY DEFAULT');
    await close();
  });
});

// A variant of the platform's answer, swapped in over the fake the way
// webhooks.test.ts reads its own: these cases are about shapes it does not carry.
async function over(body: unknown, status: number, tool: string, args: Record<string, unknown>) {
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
}

/** The same, with a raw body: an empty one, JSON null, or one that is not JSON. */
async function overRaw(raw: string, status: number, tool: string, args: Record<string, unknown>) {
  const restore = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(raw, { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const { call, close } = await connect();
    const res = await call(tool, args);
    await close();
    return res;
  } finally {
    globalThis.fetch = restore;
  }
}
