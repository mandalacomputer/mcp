/**
 * list_workspaces, get_workspace and list_workspace_members (platform
 * OPL-5057, exposed by OPL-5323), projected to the public fields; and
 * create_workspace, rename_workspace and delete_workspace (OPL-5473).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
