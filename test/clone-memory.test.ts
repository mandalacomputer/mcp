import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

// Platform OPL-4964, MCP OPL-4965: clone_snapshot's memory options, and the
// reply when the platform built the copy from the disk instead.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('clone_snapshot and a memory snapshot', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  // What the clone route answers when a test wants something other than the
  // fake platform's ordinary computer.
  let answer: Record<string, unknown> | undefined;
  beforeEach(() => {
    platform = installFakePlatform();
    const fake = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fake(input as never, init);
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (answer && url.pathname.endsWith('/snapshots/snap-1/clone')) {
        return new Response(JSON.stringify(answer), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return res;
    }) as typeof fetch;
  });
  afterEach(() => {
    answer = undefined;
    platform.restore();
  });

  const bodies = () =>
    platform.calls.filter((c) => c.path === '/snapshots/snap-1/clone').map((c) => c.body);

  it('sends each option only when set, and consent only when given', async () => {
    const { call, close } = await connect();
    await call('clone_snapshot', { snapshot_id: 'snap-1', select: false });
    await call('clone_snapshot', { snapshot_id: 'snap-1', memory: false, select: false });
    await call('clone_snapshot', { snapshot_id: 'snap-1', inherit_secrets: true, select: false });
    await call('clone_snapshot', {
      snapshot_id: 'snap-1',
      memory: true,
      inherit_secrets: false,
      select: false,
    });
    await close();
    expect(bodies()).toEqual([{}, { memory: false }, { inherit_secrets: true }, { memory: true }]);
  });

  it('says plainly when the session was not resumed, and why', async () => {
    const { call, close } = await connect();
    answer = {
      id: 'vm-9',
      name: 'copy',
      status: 'building',
      memory_dropped: true,
      memory_dropped_reason: 'secrets',
    };
    const secrets = textOf(await call('clone_snapshot', { snapshot_id: 'snap-1', select: false }));
    answer = { ...answer, memory_dropped_reason: 'bindings unrecorded' };
    const unrecorded = textOf(
      await call('clone_snapshot', { snapshot_id: 'snap-1', inherit_secrets: true, select: false }),
    );
    answer = { id: 'vm-9', name: 'copy', status: 'building' };
    const kept = textOf(await call('clone_snapshot', { snapshot_id: 'snap-1', select: false }));
    await close();
    expect(secrets).toContain('NOT resumed');
    expect(secrets).toContain('inherit_secrets was not set');
    expect(unrecorded).toContain('NOT resumed');
    expect(unrecorded).toContain("before copies could be given its computer's secrets");
    expect(kept).not.toContain('NOT resumed');
    expect(kept).toContain('Forked snap-1');
  });

  it('reads the drop beside an envelope too, and says the copy is selected when it is', async () => {
    const { call, close } = await connect();
    answer = {
      computer: { id: 'vm-9', name: 'copy', status: 'building' },
      memory_dropped: true,
      memory_dropped_reason: 'secrets',
    };
    const wrapped = textOf(await call('clone_snapshot', { snapshot_id: 'snap-1' }));
    await close();
    expect(wrapped).toContain('NOT resumed');
    expect(wrapped).toContain('It is selected');
  });
});
