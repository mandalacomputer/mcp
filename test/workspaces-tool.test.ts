/**
 * list_workspaces, get_workspace and list_workspace_members (platform
 * OPL-5057, exposed by OPL-5323): read only, projected to the public fields.
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
