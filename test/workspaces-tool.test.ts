/**
 * list_workspaces, get_workspace and list_workspace_members (platform
 * OPL-5057, exposed by OPL-5323), projected to the public fields; and
 * create_workspace, rename_workspace and delete_workspace (OPL-5473).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reasonAdvice } from '../src/errors.js';
import { connect, installFakePlatform, WORKSPACE, WORKSPACE_MEMBER } from './harness.js';

const connections: Awaited<ReturnType<typeof connect>>[] = [];
let platform: ReturnType<typeof installFakePlatform>;
beforeEach(() => {
  platform = installFakePlatform();
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  platform.restore();
});
async function open() {
  const connection = await connect({ computerId: undefined, modelKey: undefined });
  connections.push(connection);
  return connection;
}
const text = (result: CallToolResult) =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
const data = (result: CallToolResult) => JSON.parse(text(result).split('\n\n')[1]);
function respond(value: unknown, status = 200) {
  const record = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await record(...args);
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

it('list_workspaces reads GET workspaces, and is a read', async () => {
  const connection = await open();
  const tool = (await connection.client.listTools()).tools.find(
    (t) => t.name === 'list_workspaces',
  );
  expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  const result = await connection.call('list_workspaces');
  expect(result.isError).not.toBe(true);
  expect(text(result)).toMatch(/^1 workspace, oldest first\./);
  expect(data(result)).toEqual([WORKSPACE]);
  expect(platform.calls.map((c) => [c.method, c.path])).toEqual([['GET', '/workspaces']]);
});

it('get_workspace reads one workspace by id', async () => {
  const result = await (await open()).call('get_workspace', { workspace_id: WORKSPACE.id });
  expect(result.isError).not.toBe(true);
  expect(text(result)).toMatch(new RegExp(`^Workspace ci \\(${WORKSPACE.id}\\)\\.`));
  expect(data(result)).toEqual(WORKSPACE);
  expect(platform.calls.map((c) => [c.method, c.path])).toEqual([
    ['GET', `/workspaces/${WORKSPACE.id}`],
  ]);
});

it('list_workspace_members reads the members and projects only the public fields', async () => {
  respond([{ ...WORKSPACE_MEMBER, self: true, password_hash: 'UNEXPECTED' }]);
  const result = await (await open()).call('list_workspace_members', {
    workspace_id: WORKSPACE.id,
  });
  expect(result.isError).not.toBe(true);
  expect(data(result)).toEqual([WORKSPACE_MEMBER]);
  expect(text(result)).not.toContain('UNEXPECTED');
  expect(platform.calls.map((c) => [c.method, c.path])).toEqual([
    ['GET', `/workspaces/${WORKSPACE.id}/members`],
  ]);
});

it('relays the 403 a workspace-scoped key gets for the members', async () => {
  const sentence = 'A key confined to a workspace cannot list members.';
  respond({ error: sentence }, 403);
  const result = await (await open()).call('list_workspace_members', {
    workspace_id: WORKSPACE.id,
  });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain(sentence);
  expect(text(result)).toContain('403');
});

it('refuses a malformed answer rather than inventing one', async () => {
  respond([{ id: WORKSPACE.id, name: 'ci' }]);
  const result = await (await open()).call('list_workspaces');
  expect(result.isError).toBe(true);
  expect(text(result)).toContain('Malformed metadata response');
});

// --- the writes (OPL-5473) ----------------------------------------------------

it('create_workspace posts { name } and answers the new workspace', async () => {
  const result = await (await open()).call('create_workspace', { name: 'customer-acme' });
  expect(result.isError).not.toBe(true);
  expect(text(result)).toMatch(new RegExp(`^Created workspace ci \\(${WORKSPACE.id}\\)\\.`));
  expect(data(result)).toEqual(WORKSPACE);
  expect(platform.calls.map((c) => [c.method, c.path, c.body])).toEqual([
    ['POST', '/workspaces', { name: 'customer-acme' }],
  ]);
});

it('rename_workspace patches { name } on the id it names', async () => {
  const result = await (await open()).call('rename_workspace', {
    workspace_id: WORKSPACE.id,
    name: 'ci-2',
  });
  expect(result.isError).not.toBe(true);
  expect(platform.calls.map((c) => [c.method, c.path, c.body])).toEqual([
    ['PATCH', `/workspaces/${WORKSPACE.id}`, { name: 'ci-2' }],
  ]);
});

it('delete_workspace needs confirm: true, and says how many keys were revoked', async () => {
  const connection = await open();
  const refused = await connection.call('delete_workspace', { workspace_id: WORKSPACE.id });
  expect(refused.isError).toBe(true);
  expect(platform.calls).toHaveLength(0);
  const result = await connection.call('delete_workspace', {
    workspace_id: WORKSPACE.id,
    confirm: true,
  });
  expect(result.isError).not.toBe(true);
  expect(text(result)).toMatch(/2 API keys confined to it were revoked/);
  // Only an empty workspace is deleted (OPL-5639): nothing is left to keep.
  expect(text(result)).not.toMatch(/kept/);
  expect(data(result)).toEqual({ ok: true, revoked_keys: 2 });
  expect(platform.calls.map((c) => [c.method, c.path])).toEqual([
    ['DELETE', `/workspaces/${WORKSPACE.id}`],
  ]);
});

it('describes the writes honestly and hides them from a read-only session', async () => {
  const connection = await open();
  const tools = (await connection.client.listTools()).tools;
  const byName = (name: string) => tools.find((t) => t.name === name);
  expect(byName('delete_workspace')?.description).toMatch(/REVOKES every API key confined to it/);
  // The platform refuses (409) a workspace that still holds computers, so the
  // description must not promise they survive the delete (OPL-5639).
  expect(byName('delete_workspace')?.description).toMatch(
    /Only an empty workspace can be deleted: one that still holds computers is refused \(409\)/,
  );
  expect(byName('delete_workspace')?.description).not.toMatch(/kept|NOT deleted|not touched/);
  expect(byName('delete_workspace')?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
  for (const name of ['create_workspace', 'rename_workspace', 'delete_workspace']) {
    expect(byName(name)?.description).toMatch(/not confined to a workspace/);
    expect(byName(name)?.annotations?.readOnlyHint).toBe(false);
  }
  const readOnly = await connect({ computerId: undefined, modelKey: undefined, readOnly: true });
  connections.push(readOnly);
  const shown = (await readOnly.client.listTools()).tools.map((t) => t.name);
  expect(shown).toContain('list_workspaces');
  for (const name of ['create_workspace', 'rename_workspace', 'delete_workspace'])
    expect(shown).not.toContain(name);
});

it("refuses a blank name before any request, and relays a scoped key's 403", async () => {
  const connection = await open();
  const blank = await connection.call('create_workspace', { name: '   ' });
  expect(blank.isError).toBe(true);
  expect(platform.calls).toHaveLength(0);
  const sentence =
    'Workspaces cannot be created, renamed or deleted with a workspace-scoped API key.';
  respond({ error: sentence }, 403);
  const result = await connection.call('delete_workspace', {
    workspace_id: WORKSPACE.id,
    confirm: true,
  });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain(sentence);
});

it('refuses a delete answer that does not say how many keys it revoked', async () => {
  respond({ ok: true });
  const result = await (await open()).call('delete_workspace', {
    workspace_id: WORKSPACE.id,
    confirm: true,
  });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain('Malformed metadata response');
});

// A 503 answered to a write leaves the change unknown, whatever reason word it
// carries: the tool says to read the state first, never to send it again.
it.each([
  ['create_workspace', { name: 'customer-acme' }],
  ['rename_workspace', { workspace_id: WORKSPACE.id, name: 'ci-2' }],
  ['delete_workspace', { workspace_id: WORKSPACE.id, confirm: true }],
] as const)('a 503 on %s says the change may or may not have happened', async (name, args) => {
  const retry = reasonAdvice('contention');
  expect(retry).toBeDefined();
  for (const body of [
    { error: 'The platform could not answer.' },
    { error: 'The platform could not answer.', reason: 'contention' },
  ]) {
    respond(body, 503);
    const result = await (await open()).call(name, { ...args });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('THIS CHANGE MAY OR MAY NOT HAVE HAPPENED');
    expect(text(result)).not.toContain('can be sent again shortly');
    expect(text(result)).not.toContain(retry as string);
  }
});

// Creating into a workspace and listing one (platform OPL-5543): an
// account-wide key names the workspace with workspace_id on create_computer,
// and narrows list_computers to one workspace or to 'unassigned'.

it('create_computer sends workspace_id on the create, and only when given', async () => {
  const { call } = await open();
  const made = await call('create_computer', { template: 'base', workspace_id: WORKSPACE.id });
  expect(made.isError).toBeFalsy();
  const creates = () =>
    platform.calls.filter((c) => c.method === 'POST' && c.path === '/computers');
  expect(creates()[0]?.body).toMatchObject({ template: 'base', workspace_id: WORKSPACE.id });
  await call('create_computer', { template: 'base' });
  expect(creates()[1]?.body).not.toHaveProperty('workspace_id');
});

it('list_computers sends workspace_id as the query, an id or unassigned', async () => {
  const { call } = await open();
  const lists = () => platform.calls.filter((c) => c.method === 'GET' && c.path === '/computers');
  await call('list_computers', { workspace_id: WORKSPACE.id });
  expect(lists().at(-1)?.query.get('workspace_id')).toBe(WORKSPACE.id);
  await call('list_computers', { workspace_id: 'unassigned', state: 'live' });
  expect(Object.fromEntries(lists().at(-1)!.query)).toEqual({
    workspace_id: 'unassigned',
    state: 'live',
  });
  await call('list_computers', {});
  expect(lists().at(-1)?.query.has('workspace_id')).toBe(false);
});

it('an empty workspace listing is not an empty account', async () => {
  const { call } = await open();
  respond([]);
  const res = await call('list_computers', { workspace_id: 'unassigned' });
  expect(text(res)).toContain('No computers on this account are in no workspace');
  expect(text(res)).toContain('without `workspace_id`');
  expect(text(res)).not.toContain('create_computer makes one');
});

it.each(['', ' wsp-0123456789ab'])(
  'refuses a workspace_id the platform would refuse (%j), sending nothing',
  async (bad) => {
    const { call } = await open();
    const made = await call('create_computer', { template: 'base', workspace_id: bad });
    const listed = await call('list_computers', { workspace_id: bad });
    expect(made.isError).toBe(true);
    expect(listed.isError).toBe(true);
    expect(platform.calls.filter((c) => c.path === '/computers')).toEqual([]);
  },
);

// The saved profile's default workspace from `mandala workspaces use`
// (OPL-5644): create_computer and list_computers apply it to a call that leaves
// workspace_id out, as `mandala computers create` and `computers list` do and as
// the secret tools here already did. Otherwise a secret created in the default
// workspace could not be bound to a computer this created in none.
describe("a saved profile's default workspace", () => {
  const OTHER = 'wsp-ba9876543210';
  async function withDefault(cfg: {
    defaultWorkspace?: { id: string; name: string } | null;
    defaultWorkspaceUnreadable?: string;
  }) {
    const connection = await connect({ computerId: undefined, modelKey: undefined, ...cfg });
    connections.push(connection);
    return connection;
  }
  const creates = () =>
    platform.calls.filter((c) => c.method === 'POST' && c.path === '/computers');
  const lists = () => platform.calls.filter((c) => c.method === 'GET' && c.path === '/computers');
  const described = async (connection: Awaited<ReturnType<typeof connect>>, name: string) => {
    const tool = (await connection.client.listTools()).tools.find((t) => t.name === name)!;
    const arg = (tool.inputSchema.properties as Record<string, { description?: string }>)
      .workspace_id;
    return { tool: tool.description ?? '', arg: arg?.description ?? '' };
  };

  it('create_computer creates in the default when workspace_id is left out, and says so', async () => {
    const connection = await withDefault({ defaultWorkspace: { id: WORKSPACE.id, name: 'ci' } });
    const made = await connection.call('create_computer', { template: 'base' });
    expect(made.isError).toBeFalsy();
    expect(creates()[0]?.body).toMatchObject({ template: 'base', workspace_id: WORKSPACE.id });
    expect(text(made)).toContain(
      `in workspace ${WORKSPACE.id} (the saved profile's default from mandala workspaces use)`,
    );
    // An explicit workspace_id always wins, and is not called the default.
    const elsewhere = await connection.call('create_computer', {
      template: 'base',
      workspace_id: OTHER,
    });
    expect(creates()[1]?.body).toMatchObject({ workspace_id: OTHER });
    expect(text(elsewhere)).not.toContain("the saved profile's default");
    const { tool, arg } = await described(connection, 'create_computer');
    for (const said of [tool, arg])
      expect(said).toContain(
        `Default when left out: the saved profile's workspace from \`mandala workspaces use\`, else this key's workspace, or none — here workspace ci (${WORKSPACE.id}).`,
      );
  });

  it('list_computers lists the default when workspace_id is left out, and says so', async () => {
    const connection = await withDefault({ defaultWorkspace: { id: WORKSPACE.id, name: 'ci' } });
    const listed = await connection.call('list_computers');
    expect(listed.isError).toBeFalsy();
    expect(lists().at(-1)?.query.get('workspace_id')).toBe(WORKSPACE.id);
    expect(text(listed)).toMatch(
      new RegExp(
        `^1 computer\\(s\\) in workspace ${WORKSPACE.id} \\(the saved profile's default from mandala workspaces use\\):`,
      ),
    );
    await connection.call('list_computers', { workspace_id: 'unassigned' });
    expect(lists().at(-1)?.query.get('workspace_id')).toBe('unassigned');
    const { tool, arg } = await described(connection, 'list_computers');
    for (const said of [tool, arg]) expect(said).toContain(`here workspace ci (${WORKSPACE.id})`);
  });

  it('an empty default listing names another workspace_id, not leaving it out', async () => {
    const connection = await withDefault({ defaultWorkspace: { id: WORKSPACE.id, name: 'ci' } });
    respond([]);
    const res = await connection.call('list_computers');
    expect(text(res)).toContain(
      `No computers on this account are in workspace ${WORKSPACE.id} (the saved profile's default`,
    );
    expect(text(res)).toContain("pass another workspace_id, or 'unassigned'");
    expect(text(res)).not.toContain('without `workspace_id`');
    expect(text(res)).not.toContain('create_computer makes one');
  });

  it('create_computer is refused with nothing sent on an unreadable defaults.json; list_computers goes on unfiltered', async () => {
    const why = 'it is not valid JSON';
    const connection = await withDefault({
      defaultWorkspace: null,
      defaultWorkspaceUnreadable: why,
    });
    const refused = await connection.call('create_computer', { template: 'base' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(`~/.mandala/defaults.json cannot be read (${why})`);
    expect(text(refused)).toContain('Pass workspace_id explicitly');
    expect(platform.calls).toEqual([]);
    // Named explicitly, it goes through.
    const made = await connection.call('create_computer', {
      template: 'base',
      workspace_id: WORKSPACE.id,
    });
    expect(made.isError).toBeFalsy();
    expect(creates()[0]?.body).toMatchObject({ workspace_id: WORKSPACE.id });
    const listed = await connection.call('list_computers');
    expect(listed.isError).toBeFalsy();
    expect(lists().at(-1)?.query.has('workspace_id')).toBe(false);
    expect((await described(connection, 'create_computer')).arg).toContain(
      'create_computer refuses a call without workspace_id',
    );
    expect((await described(connection, 'list_computers')).arg).toContain('cannot be read');
  });

  it.each([
    ['no saved default', { defaultWorkspace: null }],
    ['an explicit or environment key', {}],
  ])('changes nothing with %s', async (_label, cfg) => {
    const connection = await withDefault(cfg);
    const made = await connection.call('create_computer', { template: 'base' });
    expect(creates()[0]?.body).not.toHaveProperty('workspace_id');
    expect(text(made)).not.toContain("the saved profile's default");
    const listed = await connection.call('list_computers');
    expect(lists().at(-1)?.query.has('workspace_id')).toBe(false);
    expect(text(listed)).toMatch(/^1 computer\(s\):/);
  });

  it('no default leaves the descriptions as they were', async () => {
    const connection = await withDefault({});
    for (const name of ['create_computer', 'list_computers']) {
      const { tool, arg } = await described(connection, name);
      expect(tool + arg).not.toContain('mandala workspaces use');
    }
  });
});
