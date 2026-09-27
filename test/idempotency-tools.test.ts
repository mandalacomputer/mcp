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

/** The lifecycle tools that make a new computer or overwrite a disk. */
const BUILDS = new Set(['create_computer', 'clone_computer', 'restore_snapshot', 'clone_snapshot']);

/** The lifecycle tools whose step no read of the computer shows. */
const UNSEEN = new Set(['restart_computer']);

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

  it.each(LIFECYCLE.filter(([tool]) => BUILDS.has(tool)))(
    '%s describes the spent-key route as wait-for-the-operation first',
    async (tool) => {
      const { client } = await open();
      const found = (await client.listTools()).tools.find((t) => t.name === tool);
      const props = found?.inputSchema.properties as Record<string, { description?: string }>;
      const said = props.idempotency_key?.description ?? '';
      expect(said).toContain('wait while it is pending or running and do not resend meanwhile');
      expect(said).toContain('only once the operation is final as failed or not found AND');
    },
  );

  // A spent key's operation stays pending for an hour however quickly the host
  // gave up (platform OPL-5304), so a step a read of the computer shows is read
  // off the computer and resent, not held to that hour.
  it.each(LIFECYCLE.filter(([tool]) => !BUILDS.has(tool) && !UNSEEN.has(tool)))(
    '%s describes the spent-key route as read the computer, then resend',
    async (tool) => {
      const { client } = await open();
      const found = (await client.listTools()).tools.find((t) => t.name === tool);
      const props = found?.inputSchema.properties as Record<string, { description?: string }>;
      const said = props.idempotency_key?.description ?? '';
      expect(said).toContain('read get_computer');
      expect(said).toContain('pending alone is no reason to wait');
      expect(said).toContain('if the step did not take effect, send the call again with a new key');
      expect(said).not.toContain('do not resend meanwhile');
    },
  );

  // A restart reads running before and after one, so "read get_computer and
  // resend if the step did not take effect" can only ever say resend, and a
  // resend resets the guest a second time.
  it('restart_computer describes the spent-key route as the operation, then the user', async () => {
    const { client } = await open();
    const found = (await client.listTools()).tools.find((t) => t.name === 'restart_computer');
    const props = found?.inputSchema.properties as Record<string, { description?: string }>;
    const said = props.idempotency_key?.description ?? '';
    expect(said).toContain('A restart cannot be seen in get_computer');
    expect(said).toContain('do not read the computer to decide');
    expect(said).toContain('ask the user before sending it again with a new key');
    expect(said).not.toContain('read get_computer');
    expect(said).not.toContain('if the step did not take effect');
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
  // The platform settles a keyed call it answered with a 5xx as lost
  // (OPL-5304), so the same key sent again can only be answered
  // idempotency_outcome_unknown. The advice is to read first, then resend with
  // a new key or none — never the same key.
  it('after a 5xx the platform answered on a start, says to read the computer, then resend with a new key', async () => {
    answer(
      (method, path) => method === 'POST' && path === '/computers/vm-1/start',
      () =>
        Response.json(
          {
            error: 'No hypervisor could answer that right now.',
            reason: 'contention',
            operation_id: OPERATION.id,
          },
          { status: 503 },
        ),
    );
    const result = await (await open()).call('start_computer', { idempotency_key: 'k-503' });
    expect(result.isError).toBe(true);
    const said = text(result);
    expect(said).not.toContain('To retry without risking');
    expect(said).toContain(
      'resending with that key will answer idempotency_outcome_unknown, not do it',
    );
    expect(said).toContain(`get_operation ${OPERATION.id}`);
    // The operation of a spent key stays pending for an hour whatever
    // happened, and a start a read of the computer shows: so the route is that
    // read, then a new key, not an hour of waiting on the operation.
    expect(said).toContain(`Read get_computer and get_operation ${OPERATION.id} first`);
    expect(said).toContain('is no reason to wait');
    expect(said).toContain(
      'If get_computer shows the step did not take effect, call start_computer again with a new idempotency_key, or none',
    );
    expect(said).not.toContain('do NOT resend it meanwhile, with any key');
    expect(said).not.toContain('a slow create or clone may still land');
  });

  it('after a 5xx the platform answered on a restart, never makes get_computer the resend condition', async () => {
    // get_computer reads running whether or not the reset happened, so the
    // read-then-resend route would reset the guest a second time.
    answer(
      (method, path) => method === 'POST' && path === '/computers/vm-1/restart',
      () =>
        Response.json(
          { error: 'The host did not answer.', reason: 'contention', operation_id: OPERATION.id },
          { status: 503 },
        ),
    );
    const result = await (await open()).call('restart_computer', { idempotency_key: 'k-503' });
    expect(result.isError).toBe(true);
    const said = text(result);
    expect(said).toContain(
      'resending with that key will answer idempotency_outcome_unknown, not do it',
    );
    expect(said).not.toContain('If get_computer shows the step did not take effect');
    expect(said).not.toContain('Read get_computer');
    expect(said).not.toContain('To retry without risking');
    expect(said).toContain('A restart cannot be seen in get_computer');
    expect(said).toContain(`Read get_operation ${OPERATION.id} instead`);
    expect(said).toContain(`wait_for_operation ${OPERATION.id} rather than resending`);
    expect(said).toContain('treat the restart as possibly done');
    expect(said).toContain(
      'Ask the user before you call restart_computer again with a new idempotency_key, or none',
    );
  });

  it('after a 5xx on a restart with no operation named, finds it by the key', async () => {
    answer(
      (method, path) => method === 'POST' && path === '/computers/vm-1/restart',
      () => Response.json({ error: 'boom' }, { status: 500 }),
    );
    const said = text(await (await open()).call('restart_computer', { idempotency_key: 'k-500' }));
    expect(said).toContain('list_operations with idempotency_key "k-500"');
    expect(said).not.toContain('If get_computer shows the step did not take effect');
    expect(said).toContain('Ask the user before you call restart_computer again');
  });

  it('after a 5xx the platform answered on a create, waits for the operation to be final', async () => {
    // A create a read made at once cannot see may still land, and a second
    // one is a second computer: the resend waits for the operation.
    answer(
      (method, path) => method === 'POST' && path === '/computers',
      () => Response.json({ error: 'boom', operation_id: OPERATION.id }, { status: 500 }),
    );
    const said = text(await (await open()).call('create_computer', { template: 'base' }));
    expect(said).toMatch(new RegExp(`Read get_operation ${OPERATION.id} .*first`));
    expect(said).toContain(`wait_for_operation ${OPERATION.id}`);
    expect(said).toContain('While it is pending or running the call may still be carried out');
    expect(said).toContain('do NOT resend it meanwhile, with any key');
    expect(said).toMatch(/Only once it is final as failed .* AND get_computer/);
    expect(said.indexOf('do NOT resend')).toBeLessThan(said.indexOf('with a new idempotency_key'));
    expect(said).toContain('call create_computer again with a new idempotency_key, or none');
  });

  it('after a 5xx on an egress update, reads the computer and does not talk of a slow create', async () => {
    answer(
      (method, path) => method === 'PATCH' && path === '/computers/vm-1',
      () => Response.json({ error: 'boom' }, { status: 500 }),
    );
    const said = text(
      await (await open()).call('update_computer', {
        egress_proxy: null,
        idempotency_key: 'k-patch',
      }),
    );
    expect(said).toContain('Read get_computer first');
    expect(said).toContain('call update_computer again with a new idempotency_key, or none');
    expect(said).not.toContain('a slow create or clone may still land');
    expect(said).not.toContain('do NOT resend it meanwhile');
  });

  it('says the same after a platform 500 on a create, naming the key the server made', async () => {
    answer(
      (method, path) => method === 'POST' && path === '/computers',
      () => Response.json({ error: 'boom' }, { status: 500 }),
    );
    const result = await (await open()).call('create_computer', { template: 'base' });
    const sent = keyed()[0];
    expect(text(result)).toContain(`settled idempotency_key "${sent}"`);
    expect(text(result)).toContain('list_computers after a create');
    expect(text(result)).not.toContain('To retry without risking');
    // No operation_id in the body: the operation is found by the key, and a
    // slow create may still land, so nothing is resent on a first read alone.
    expect(text(result)).toContain(`list_operations with idempotency_key "${sent}"`);
    expect(text(result)).toContain('do NOT resend it meanwhile');
    expect(text(result)).toContain('a slow create or clone may still land');
  });

  it('ends with the same-key retry when the connection died after the request went out', async () => {
    const record = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      await record(input as never, init);
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') throw new Error('socket hang up');
      return record(input as never, init);
    }) as typeof fetch;
    const result = await (await open()).call('start_computer', { idempotency_key: 'k-lost' });
    expect(result.isError).toBe(true);
    expect(text(result).trimEnd()).toMatch(
      /To retry without risking a second start, call start_computer again with idempotency_key "k-lost"\.$/,
    );
  });

  it.each([
    [502, 'text/html', '<html><body>502 Bad Gateway</body></html>'],
    [504, 'text/html', '<html><body>504 Gateway Time-out</body></html>'],
    [520, 'application/json', '{"error":"origin said nothing readable"}'],
  ])(
    'ends with the same-key retry on an edge %i the platform never wrote',
    async (status, type, body) => {
      answer(
        (method, path) => method === 'POST' && path === '/computers/vm-1/start',
        () => new Response(body, { status, headers: { 'Content-Type': type } }),
      );
      const result = await (await open()).call('start_computer', { idempotency_key: 'k-edge' });
      expect(result.isError).toBe(true);
      expect(text(result).trimEnd()).toMatch(
        /To retry without risking a second start, call start_computer again with idempotency_key "k-edge"\.$/,
      );
      expect(text(result)).not.toContain('settled idempotency_key');
    },
  );

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

  it('says an outcome the platform never heard is read first, then resent with a new key', async () => {
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
    expect(text(result)).toContain('do not send it again with this key');
    expect(text(result)).toContain('Read get_computer first');
    expect(text(result)).toContain(
      'If get_computer shows the step did not take effect, call delete_computer again with a new idempotency_key, or none',
    );
    expect(text(result)).not.toContain('do NOT resend it meanwhile, with any key');
    expect(text(result)).not.toContain('To retry without risking');
  });

  it('says an unheard outcome on a restart is read off its operation, then left to the user', async () => {
    answer(
      (method, path) => method === 'POST' && path === '/computers/vm-1/restart',
      () =>
        Response.json(
          { error: 'The platform did not hear how it ended.', code: 'idempotency_outcome_unknown' },
          { status: 409 },
        ),
    );
    const result = await (await open()).call('restart_computer', { idempotency_key: 'k-lost' });
    const said = text(result);
    expect(said).toContain('do not send it again with this key');
    expect(said).toContain('A restart cannot be seen in get_computer');
    expect(said).toContain('list_operations with idempotency_key set to this key');
    expect(said).toContain('Ask the user before you call restart_computer again');
    expect(said).not.toContain('If get_computer shows the step did not take effect');
    expect(said).not.toContain('To retry without risking');
  });

  it('says an unheard outcome on a clone waits for the operation before a new key', async () => {
    answer(
      (method, path) => method === 'POST' && path === '/computers/vm-1/clone',
      () =>
        Response.json(
          { error: 'The platform did not hear how it ended.', code: 'idempotency_outcome_unknown' },
          { status: 409 },
        ),
    );
    const result = await (await open()).call('clone_computer', { idempotency_key: 'k-lost' });
    expect(text(result)).toContain('list_operations with idempotency_key set to this key');
    expect(text(result)).toContain('do NOT resend it meanwhile, with any key');
    expect(text(result)).toMatch(
      /Only once it is final as failed .* AND get_computer .* shows the step did not take effect, call clone_computer again with a new idempotency_key, or none/,
    );
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
