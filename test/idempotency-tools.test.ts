/**
 * `idempotency_key` on every lifecycle tool (platform OPL-5127): the header each
 * one sends, the key a caller passes, what an unknown outcome says, and the
 * list_operations filter that finds a call whose answer was lost.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorForStatus, isTransient } from '../src/errors.js';
import { connect, installFakePlatform, OPERATION } from './harness.js';

const KEY_SYNTAX = /^[\x21-\x7e]{1,255}$/;

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
  const connection = await connect();
  connections.push(connection);
  return connection;
}
const text = (result: CallToolResult) =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
/** The Idempotency-Key of every request that was not a read, in order. */
const keyed = () =>
  platform.calls.filter((c) => c.method !== 'GET').map((c) => c.headers['idempotency-key']);

/** Answer the requests `match` picks with `response`, and everything else as the fake platform does. */
function answer(match: (method: string, path: string) => boolean, response: () => Response) {
  const record = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const recorded = await record(input as never, init);
    return match(method, path) ? response() : recorded;
  }) as typeof fetch;
}

/** Every lifecycle tool, once each. */
const LIFECYCLE: [string, Record<string, unknown>][] = [
  ['create_computer', { template: 'base' }],
  ['start_computer', {}],
  ['stop_computer', {}],
  ['suspend_computer', {}],
  ['restart_computer', {}],
  ['update_computer', { ram_mb: 4096 }],
  ['clone_computer', { name: 'copy' }],
  ['move_computer', { ram_mb: 26000, timeout_s: 5 }],
  ['delete_computer', { computer_id: 'vm-1', confirm: true }],
  ['restore_snapshot', { snapshot_id: 'snap-1', confirm: true }],
  ['clone_snapshot', { snapshot_id: 'snap-1' }],
];

describe('a lifecycle tool', () => {
  it.each(LIFECYCLE)('%s sends an Idempotency-Key the platform accepts', async (tool, args) => {
    await (await open()).call(tool, args);
    const sent = keyed();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]).toMatch(KEY_SYNTAX);
  });

  it.each(LIFECYCLE)('%s sends a caller’s key verbatim', async (tool, args) => {
    await (await open()).call(tool, { ...args, idempotency_key: 'order-4711:step' });
    expect(keyed()[0]).toBe('order-4711:step');
  });

  it('sends a different key on each call', async () => {
    const connection = await open();
    await connection.call('start_computer', {});
    await connection.call('start_computer', {});
    const sent = keyed();
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]);
  });

  it.each([
    ['empty', ''],
    ['256 characters', 'k'.repeat(256)],
    ['a space', 'a b'],
    ['non-ASCII', 'café'],
  ])('refuses a key that is %s before sending anything', async (_, key) => {
    const result = await (await open()).call('start_computer', { idempotency_key: key });
    expect(result.isError).toBe(true);
    expect(keyed()).toEqual([]);
  });
});

describe('an unknown outcome', () => {
  it('ends with the retry that cannot do it twice, naming the key', async () => {
    answer(
      (method, path) => method === 'POST' && path === '/computers/vm-1/start',
      () => Response.json({ error: 'No hypervisor could answer that right now.' }, { status: 503 }),
    );
    const result = await (await open()).call('start_computer', { idempotency_key: 'k-503' });
    expect(result.isError).toBe(true);
    expect(text(result).trimEnd()).toMatch(
      /To retry without risking a second start, call start_computer again with idempotency_key "k-503"\.$/,
    );
  });

  it('names the key the server made when the caller gave none', async () => {
    answer(
      (method, path) => method === 'POST' && path === '/computers',
      () => Response.json({ error: 'boom' }, { status: 500 }),
    );
    const result = await (await open()).call('create_computer', { template: 'base' });
    const sent = keyed()[0];
    expect(text(result).trimEnd()).toMatch(
      new RegExp(
        `To retry without risking a second computer, call create_computer again with idempotency_key "${sent}"\\.$`,
      ),
    );
  });

  it('says a keyed call still running is worth waiting on, and how', async () => {
    answer(
      (method, path) => method === 'POST' && path === '/computers/vm-1/restart',
      () =>
        Response.json(
          {
            error: 'The call with this Idempotency-Key is still in progress.',
            code: 'idempotency_in_progress',
            reason: 'contention',
            operation_id: OPERATION.id,
          },
          { status: 409 },
        ),
    );
    const result = await (await open()).call('restart_computer', { idempotency_key: 'k-busy' });
    expect(text(result)).toContain('still running');
    expect(text(result)).toContain(`get_operation ${OPERATION.id}`);
    expect(text(result)).toContain('idempotency_key "k-busy"');
  });

  it('says an outcome the platform never heard is not to be resent blindly', async () => {
    answer(
      (method, path) => method === 'DELETE' && path === '/computers/vm-1',
      () =>
        Response.json(
          { error: 'The platform did not hear how it ended.', code: 'idempotency_outcome_unknown' },
          { status: 409 },
        ),
    );
    const result = await (await open()).call('delete_computer', {
      computer_id: 'vm-1',
      confirm: true,
      idempotency_key: 'k-lost',
    });
    expect(text(result)).toContain('do not send it again blindly');
    expect(text(result)).not.toContain('To retry without risking');
  });

  it('does not offer the key on a refusal that released it', async () => {
    answer(
      (method, path) => method === 'POST' && path === '/computers/vm-1/stop',
      () => Response.json({ error: 'busy', reason: 'contention' }, { status: 409 }),
    );
    const result = await (await open()).call('stop_computer', { idempotency_key: 'k-4xx' });
    expect(text(result)).not.toContain('k-4xx');
  });
});

describe('isTransient on the keyed refusals', () => {
  const refusal = (status: number, body: Record<string, unknown>) =>
    errorForStatus(status, 'x', body, undefined, { method: 'POST' });
  it('is true while the keyed call is still running, and false otherwise', () => {
    expect(
      isTransient(
        refusal(409, { error: 'x', code: 'idempotency_in_progress', reason: 'contention' }),
      ),
    ).toBe(true);
    expect(isTransient(refusal(409, { error: 'x', code: 'idempotency_outcome_unknown' }))).toBe(
      false,
    );
    expect(isTransient(refusal(422, { error: 'x', code: 'idempotency_key_reused' }))).toBe(false);
  });
});

describe('list_operations', () => {
  it('passes the idempotency_key filter', async () => {
    await (await open()).call('list_operations', { idempotency_key: 'order-4711:step' });
    const read = platform.calls.find((c) => c.path === '/operations');
    expect(read?.query.get('idempotency_key')).toBe('order-4711:step');
  });
});
