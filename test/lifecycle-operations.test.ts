/**
 * get_operation, list_operations and wait_for_operation (platform OPL-5055),
 * and the operation_id the lifecycle tools now say out loud.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, installFakePlatform, OPERATION } from './harness.js';

const OP_ID = OPERATION.id;
const COMPUTER = { id: 'vm-1', name: 'demo', status: 'running', os: 'linux', cpu: 2, ram_mb: 4096 };
const RUNNING = { ...OPERATION, state: 'running', finished_at: null };
const FAILED = {
  ...OPERATION,
  kind: 'create',
  state: 'failed',
  error: { code: 'start_failed', message: 'The computer was created and would not start.' },
};

const connections: Awaited<ReturnType<typeof connect>>[] = [];
let platform: ReturnType<typeof installFakePlatform>;
beforeEach(() => {
  platform = installFakePlatform();
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  vi.useRealTimers();
  platform.restore();
  vi.restoreAllMocks();
});
async function open(cfg: Parameters<typeof connect>[0] = {}) {
  const connection = await connect(cfg);
  connections.push(connection);
  return connection;
}
const text = (result: CallToolResult) =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
const data = (result: CallToolResult) => JSON.parse(text(result).split('\n\n').at(-1) ?? '');

/**
 * Answers the requests `match` picks with the next body in turn (the last one
 * forever), and hands every other request to the fake platform.
 */
function answer(match: (method: string, path: string) => boolean, ...bodies: unknown[]) {
  const record = globalThis.fetch;
  let served = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!match(method, path)) return record(input as never, init);
    await record(input as never, init);
    const body = bodies[Math.min(served++, bodies.length - 1)];
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
  return () => served;
}
const operationRead = (method: string, path: string) =>
  method === 'GET' && path.startsWith('/operations/');

describe('get_operation', () => {
  it('reads GET operations/:id, says where it got to, and is a read', async () => {
    const connection = await open();
    const tool = (await connection.client.listTools()).tools.find(
      (t) => t.name === 'get_operation',
    );
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const result = await connection.call('get_operation', { operation_id: OP_ID });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toMatch(new RegExp(`^${OP_ID}: clone of vm-2 — succeeded`));
    expect(data(result)).toEqual(OPERATION);
    expect(platform.calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', `/operations/${OP_ID}`],
    ]);
  });

  it('keeps a kind and a state it does not know, and projects only the public fields', async () => {
    answer(operationRead, { ...OPERATION, kind: 'delete', state: 'queued', owner: 'acc-x' });
    const result = await (await open()).call('get_operation', { operation_id: OP_ID });
    expect(result.isError).not.toBe(true);
    expect(data(result)).toMatchObject({ kind: 'delete', state: 'queued' });
    expect(text(result)).not.toContain('acc-x');
  });

  it.each([
    ['no id', { ...OPERATION, id: '' }],
    ['no state', { ...OPERATION, state: 7 }],
    ['an error with no message', { ...FAILED, error: { code: 'start_failed' } }],
  ])('refuses an answer with %s', async (_name, body) => {
    answer(operationRead, body);
    const result = await (await open()).call('get_operation', { operation_id: OP_ID });
    expect(result.isError).toBe(true);
  });
});

describe('list_operations', () => {
  it('sends every parameter it was given and says where the next page is', async () => {
    answer((m, p) => m === 'GET' && p === '/operations', {
      operations: [OPERATION, RUNNING],
      next_cursor: 'op_00000000000000000000000a',
    });
    const result = await (await open()).call('list_operations', {
      computer_id: 'vm-2',
      limit: 2,
      cursor: 'op_00000000000000000000000b',
    });
    expect(result.isError).not.toBe(true);
    const sent = platform.calls.find((c) => c.path === '/operations');
    expect(Object.fromEntries(sent?.query ?? [])).toEqual({
      computer_id: 'vm-2',
      limit: '2',
      cursor: 'op_00000000000000000000000b',
    });
    expect(text(result)).toContain(`${OP_ID}: clone of vm-2 — running`);
    expect(text(result)).toContain('cursor=op_00000000000000000000000a');
  });

  it('does not default computer_id to the selected computer', async () => {
    await (await open({ computerId: 'vm-1' })).call('list_operations');
    const sent = platform.calls.find((c) => c.path === '/operations');
    expect([...(sent?.query ?? [])]).toEqual([]);
  });
});

describe('wait_for_operation', () => {
  it('polls through live states and answers on succeeded, saying it is not a booted desktop', async () => {
    const served = answer(operationRead, { ...RUNNING, state: 'pending' }, RUNNING, OPERATION);
    vi.useFakeTimers();
    const pending = (await open()).call('wait_for_operation', {
      operation_id: OP_ID,
      timeout_s: 30,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(served()).toBe(3);
    expect(text(result)).toContain('succeeded');
    expect(text(result)).toContain('not that the desktop has booted');
  });

  it('is an error carrying the code and the sentence on failed', async () => {
    answer(operationRead, FAILED);
    const result = await (await open()).call('wait_for_operation', { operation_id: OP_ID });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('start_failed: The computer was created and would not start.');
    expect(data(result)).toEqual(FAILED);
  });

  it('refuses a finished state it does not know rather than polling it to the deadline', async () => {
    const served = answer(operationRead, { ...OPERATION, state: 'cancelled' });
    const result = await (await open()).call('wait_for_operation', { operation_id: OP_ID });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not know');
    expect(served()).toBe(1);
  });

  it('rides out a transient failure', async () => {
    const served = answer(
      operationRead,
      Response.json({ error: 'down for a moment' }, { status: 503 }),
      OPERATION,
    );
    vi.useFakeTimers();
    const pending = (await open()).call('wait_for_operation', { operation_id: OP_ID });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(served()).toBe(2);
  });

  it('stops at once on an id it cannot see', async () => {
    const served = answer(
      operationRead,
      Response.json({ error: 'operation not found' }, { status: 404 }),
    );
    const result = await (await open()).call('wait_for_operation', { operation_id: OP_ID });
    expect(result.isError).toBe(true);
    expect(served()).toBe(1);
  });

  it('hands back at its deadline, saying the operation has not stopped', async () => {
    answer(operationRead, RUNNING);
    vi.useFakeTimers();
    const pending = (await open()).call('wait_for_operation', {
      operation_id: OP_ID,
      timeout_s: 3,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Still running after 3s');
    expect(text(result)).toContain('not stopped');
  });
});

describe('operation_id on the lifecycle tools', () => {
  it.each(['start', 'stop', 'suspend', 'restart'])(
    '%s_computer says the operation its acknowledgement carried',
    async (action) => {
      answer((m, p) => m === 'POST' && p === `/computers/vm-1/${action}`, {
        ok: true,
        operation_id: `op_${action.padEnd(24, '0')}`,
      });
      const result = await (await open()).call(`${action}_computer`, { computer_id: 'vm-1' });
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain(`(operation op_${action.padEnd(24, '0')})`);
      expect(data(result)).toMatchObject({ operation_id: `op_${action.padEnd(24, '0')}` });
    },
  );

  it('an acknowledgement without one says nothing about it', async () => {
    answer((m, p) => m === 'POST' && p === '/computers/vm-1/start', { ok: true });
    const result = await (await open()).call('start_computer', { computer_id: 'vm-1' });
    expect(text(result)).not.toContain('operation');
  });

  it('update_computer says the operation a resize carried', async () => {
    answer((m, p) => m === 'PATCH' && p === '/computers/vm-1', {
      ...COMPUTER,
      status: 'stopped',
      cpu: 4,
      operation_id: 'op_000000000000000000000006',
    });
    const result = await (await open()).call('update_computer', { computer_id: 'vm-1', cpu: 4 });
    expect(result.isError).not.toBe(true);
    expect(text(result).split('\n\n')[0]).toContain('(operation op_000000000000000000000006)');
    expect(data(result)).toMatchObject({ operation_id: 'op_000000000000000000000006' });
  });

  it('update_computer says nothing about an operation when a rename carried none', async () => {
    answer((m, p) => m === 'PATCH' && p === '/computers/vm-1', { ...COMPUTER, name: 'renamed' });
    const result = await (await open()).call('update_computer', {
      computer_id: 'vm-1',
      name: 'renamed',
    });
    expect(result.isError).not.toBe(true);
    expect(text(result)).not.toContain('operation');
  });

  it('create_computer keeps the operation off the envelope of a create that would not boot', async () => {
    answer((m, p) => m === 'POST' && p === '/computers', {
      computer: { ...COMPUTER, status: 'stopped' },
      start_error: 'no',
      operation_id: 'op_000000000000000000000002',
    });
    const result = await (await open({ computerId: undefined })).call('create_computer', {});
    expect(text(result)).toContain('(operation op_000000000000000000000002)');
    expect(data(result)).toMatchObject({ operation_id: 'op_000000000000000000000002' });
  });

  it('clone_computer names the wait for its disk copy', async () => {
    answer((m, p) => m === 'POST' && p === '/computers/vm-1/clone', {
      ...COMPUTER,
      id: 'vm-9',
      status: 'building',
      operation_id: 'op_000000000000000000000003',
    });
    const result = await (await open()).call('clone_computer', { computer_id: 'vm-1' });
    expect(text(result)).toContain(
      'wait_for_operation with op_000000000000000000000003 answers when its disk has been copied',
    );
  });

  it('restore_snapshot says the operation it recorded', async () => {
    answer((m, p) => m === 'POST' && p === '/snapshots/snap-1/restore', {
      ok: true,
      operation_id: 'op_000000000000000000000004',
    });
    const result = await (await open()).call('restore_snapshot', {
      snapshot_id: 'snap-1',
      confirm: true,
    });
    expect(text(result)).toContain('Restored snap-1 (operation op_000000000000000000000004).');
  });

  it('move_computer carries the operation onto the outcome it read from the listing', async () => {
    const started = { computer_id: 'vm-1', state: 'moving', live: true, ram_mb: 26000 };
    answer((m, p) => m === 'POST' && p === '/computers/vm-1/move', {
      ...started,
      operation_id: 'op_000000000000000000000005',
    });
    answer((m, p) => m === 'GET' && p === '/moves', {
      moves: [{ ...started, state: 'done', live: false }],
    });
    const result = await (await open()).call('move_computer', {
      computer_id: 'vm-1',
      ram_mb: 26000,
      timeout_s: 5,
    });
    expect(result.isError).not.toBe(true);
    expect(data(result)).toMatchObject({
      state: 'done',
      operation_id: 'op_000000000000000000000005',
    });
  });
});
