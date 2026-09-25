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
