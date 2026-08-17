import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/**
 * The snapshot purge, and the interlock on it (OPL-3636).
 *
 * `expect` is what binds an irreversible sweep to the set somebody was shown.
 * Every test here is about the ways that binding can be lost while the call
 * still looks like it worked.
 */
describe('deleting a computer', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const lastDelete = () => platform.calls.filter((c) => c.method === 'DELETE').at(-1);

  it('keeps the snapshots unless asked, and says so', async () => {
    const { call, close } = await connect();
    const res = await call('delete_computer', { computer_id: 'vm-1', confirm: true });
    await close();
    // Not merely absent from the query — absent is what the platform reads as
    // "keep them", and this asserts we are not sending the opt-in by accident.
    expect(lastDelete()?.query.get('snapshots')).toBeNull();
    expect(textOf(res)).toContain('snapshots it had remain');
  });

  it('refuses a purge that names no fingerprint, and deletes nothing', async () => {
    const { call, close } = await connect();
    const res = await call('delete_computer', {
      computer_id: 'vm-1',
      confirm: true,
      delete_snapshots: true,
    });
    await close();
    expect(textOf(res)).toContain('snapshot_holdings');
    expect(textOf(res)).toContain('Nothing has been deleted');
    // The point of refusing locally is that the request never leaves. A purge
    // sent and then refused upstream has already told the platform to try.
    expect(platform.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('binds the purge to the fingerprint it was given', async () => {
    const { call, close } = await connect();
    const held = await call('snapshot_holdings', {});
    expect(textOf(held)).toContain('2 snapshot(s), 6.10 GB');

    await call('delete_computer', {
      computer_id: 'vm-1',
      confirm: true,
      delete_snapshots: true,
      expect: 'fp-abc123',
    });
    await close();

    const del = lastDelete();
    expect(del?.query.get('snapshots')).toBe('delete');
    expect(del?.query.get('expect')).toBe('fp-abc123');
  });

  it('does not smuggle a fingerprint onto a delete that is not purging', async () => {
    const { call, close } = await connect();
    await call('delete_computer', {
      computer_id: 'vm-1',
      confirm: true,
      expect: 'fp-abc123',
    });
    await close();
    // A stale fingerprint on a non-purge would refuse a delete for a reason
    // that has nothing to do with what was asked.
    expect(lastDelete()?.query.get('expect')).toBeNull();
  });

  it("passes on the platform's refusal when the set moved underneath it", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error:
            "this computer's snapshots changed while you were deciding; read them again and retry",
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    const { call, close } = await connect();
    const res = await call('delete_computer', {
      computer_id: 'vm-1',
      confirm: true,
      delete_snapshots: true,
      expect: 'fp-stale',
    });
    await close();
    globalThis.fetch = real;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('changed while you were deciding');
  });
});

describe('the two snapshot reads', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('answer different questions and are not interchangeable', async () => {
    const { call, close } = await connect();
    // Holdings is a summary of one computer.
    const held = textOf(await call('snapshot_holdings', {}));
    expect(held).toContain('fp-abc123');

    // The listing is the snapshots themselves, filtered off the account list —
    // the holdings route cannot answer this, whatever its path suggests.
    const listed = textOf(await call('list_snapshots', { computer_id: 'vm-1' }));
    expect(listed).toContain('snap-1');
    await close();

    const paths = platform.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('GET /computers/vm-1/snapshots');
    expect(paths).toContain('GET /snapshots');
  });
});
