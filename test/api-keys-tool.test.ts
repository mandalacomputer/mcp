/**
 * whoami and list_api_keys (platform OPL-5053), and the two key operations
 * this server deliberately does not offer.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { API_KEY, connect, installFakePlatform, WHOAMI } from './harness.js';

const NO_PERMISSION =
  'This API key cannot manage API keys. Turn on “Manage keys” for it under Credentials in the dashboard, or use a key that has it.';

const connections: Awaited<ReturnType<typeof connect>>[] = [];
let platform: ReturnType<typeof installFakePlatform>;
beforeEach(() => {
  platform = installFakePlatform();
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  platform.restore();
  vi.restoreAllMocks();
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

it('whoami reads GET whoami and says who the key is', async () => {
  const connection = await open();
  const tool = (await connection.client.listTools()).tools.find((t) => t.name === 'whoami');
  expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  const result = await connection.call('whoami');
  expect(result.isError).not.toBe(true);
  expect(text(result)).toMatch(
    /^dana@example\.com as owner on Acme \(active\), acting on the whole account\./,
  );
  expect(data(result)).toEqual(WHOAMI);
  expect(platform.calls.map((c) => [c.method, c.path])).toEqual([['GET', '/whoami']]);
});

it('whoami says when the account is suspended, and names a workspace', async () => {
  respond({
    ...WHOAMI,
    account: { ...WHOAMI.account, status: 'suspended' },
    workspace: { id: 'wsp-1', name: 'ci', created_at: '2026-09-01T00:00:00Z' },
    key: null,
  });
  const result = await (await open()).call('whoami');
  expect(result.isError).not.toBe(true);
  expect(text(result)).toContain('confined to workspace ci (wsp-1)');
  expect(text(result)).toContain('SUSPENDED');
});

// The platform withholds the holder's email and name and the account's name
// and plan from a workspace-scoped key: the answer is still an answer.
it('whoami renders a workspace-scoped key the platform withholds the email and plan from', async () => {
  const scoped = {
    ...WHOAMI,
    user: { ...WHOAMI.user, email: null, name: null },
    account: { ...WHOAMI.account, name: null, plan: null },
    workspace: { id: 'wsp-1', name: 'ci', created_at: '2026-09-01T00:00:00Z' },
  };
  respond(scoped);
  const result = await (await open()).call('whoami');
  expect(result.isError).not.toBe(true);
  expect(text(result)).toMatch(
    /^usr-1 as owner on acc-1 \(active\), confined to workspace ci \(wsp-1\)\./,
  );
  expect(text(result).split('\n\n')[0]).not.toContain('null');
  expect(data(result)).toEqual(scoped);
});

it('whoami projects only the public fields', async () => {
  respond({ ...WHOAMI, extra: 'UNEXPECTED', key: { ...WHOAMI.key, raw: 'com_secret' } });
  const result = await (await open()).call('whoami');
  expect(result.isError).not.toBe(true);
  expect(text(result)).not.toContain('UNEXPECTED');
  expect(text(result)).not.toContain('com_secret');
});

it.each([
  ['no role', { ...WHOAMI, role: '' }],
  ['no user id', { ...WHOAMI, user: { email: 'x@example.com', name: null } }],
  [
    'a key that cannot say whether it manages keys',
    { ...WHOAMI, key: { ...API_KEY, manage_keys: 'yes' } },
  ],
])('whoami refuses an answer with %s', async (_what, body) => {
  respond(body);
  const result = await (await open()).call('whoami');
  expect(result.isError).toBe(true);
  expect(text(result)).toContain('Malformed metadata response');
});

it('list_api_keys lists the keys, and never a raw key', async () => {
  respond([{ ...API_KEY, raw: 'com_should_not_appear' }]);
  const connection = await open();
  const tool = (await connection.client.listTools()).tools.find((t) => t.name === 'list_api_keys');
  expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  const result = await connection.call('list_api_keys');
  expect(result.isError).not.toBe(true);
  expect(text(result)).toMatch(/^1 API key this key can reach/);
  expect(data(result)).toEqual([API_KEY]);
  expect(text(result)).not.toContain('com_should_not_appear');
  expect(platform.calls.map((c) => [c.method, c.path])).toEqual([['GET', '/api-keys']]);
});

// OPL-5261: the key that minted a key, which the platform always sends.
it('list_api_keys and whoami keep minted_by_key_id', async () => {
  const minted = { ...API_KEY, id: 'key-0a0b0c0d0e0f', minted_by_key_id: 'key-a1b2c3d4e5f6' };
  respond([minted, API_KEY]);
  const listed = await (await open()).call('list_api_keys');
  expect(listed.isError).not.toBe(true);
  expect(data(listed)).toEqual([minted, API_KEY]);
  respond({ ...WHOAMI, key: { ...WHOAMI.key, minted_by_key_id: 'key-a1b2c3d4e5f6' } });
  const who = await (await open()).call('whoami');
  expect(data(who).key.minted_by_key_id).toBe('key-a1b2c3d4e5f6');
});

it('list_api_keys says what minted_by_key_id means', async () => {
  const tool = (await (await open()).client.listTools()).tools.find(
    (t) => t.name === 'list_api_keys',
  );
  expect(tool?.description).toContain('revoking a key does not revoke the keys it minted');
});

it('list_api_keys says so when there are none', async () => {
  respond([]);
  const result = await (await open()).call('list_api_keys');
  expect(text(result)).toMatch(/^No API keys this key can reach\./);
});

it("list_api_keys relays the platform's 403 sentence as an error", async () => {
  respond({ error: NO_PERMISSION, request_id: 'r1' }, 403);
  const result = await (await open()).call('list_api_keys');
  expect(result.isError).toBe(true);
  expect(text(result)).toContain(NO_PERMISSION);
  expect(text(result)).toContain('403');
});

it('offers no tool that mints or revokes a key', async () => {
  const names = (await (await open()).client.listTools()).tools.map((t) => t.name);
  expect(names).toContain('list_api_keys');
  expect(names.filter((n) => /api_key/.test(n))).toEqual(['list_api_keys']);
});

it.each(['whoami', 'list_api_keys'])(
  '%s refuses undeclared input before any request',
  async (name) => {
    const result = await (await open()).call(name, { account_id: 'another-account' });
    expect(result.isError).toBe(true);
    expect(platform.calls).toEqual([]);
  },
);
