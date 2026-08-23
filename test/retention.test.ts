import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

// OPL-3767 on the platform, OPL-3783 here. `snapshot_schedule` says when
// automatic snapshots are TAKEN and deliberately has no field for how long they
// survive — so a model that had just set a nightly schedule could not answer
// "will this still be there next month" except by watching snapshots vanish.
//
// The arithmetic is the platform's. What is pinned here is the SENTENCE, because
// on this surface the sentence is the product: a model reads the text before it
// reads the JSON, and three integers do not say what they select. Two ways to
// get it wrong, both of which would read as fine:
//
//   - printing a zero tier as "0 monthly", which sounds like a promise about
//     monthlies rather than a tier that is switched off
//   - turning an all-zero window into a claim about existing snapshots, which
//     the platform itself refuses to make: the same three zeroes mean "your plan
//     grants no retained history" as an entitlement and "never reap" as a daemon
//     policy, and this server is not the layer that gets to pick

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const answering = (body: Record<string, unknown>) =>
  (async () =>
    new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

describe('get_retention', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('asks the account-scoped route and names every tier that is on', async () => {
    const { call, close } = await connect();
    const res = await call('get_retention', {});
    const asked = platform.calls.find((c) => c.path === '/retention');
    // No id and no query: the window belongs to the account, so a per-computer
    // path would be asking a question this API does not have an answer for.
    expect(asked).toBeDefined();
    expect(asked!.path).toBe('/retention');
    const text = textOf(res);
    expect(text).toContain('7 daily');
    expect(text).toContain('4 weekly');
    expect(text).toContain('12 monthly');
    // The two things a model acts wrongly on without: that a period is one that
    // CONTAINS a capture, and that snapshots taken by hand are not touched.
    expect(text).toContain('THAT HAVE ONE');
    expect(text).toMatch(/by hand are never aged out/);
    await close();
  });

  // The window a variant of the platform answers with. Swapped in over the fake
  // rather than through it, which is how usage.test.ts reads its own variants:
  // installFakePlatform serves one fixture, and these two cases are about the
  // shapes it does not carry.
  const read = async (window: Record<string, unknown>) => {
    const restore = globalThis.fetch;
    globalThis.fetch = answering(window);
    try {
      const { call, close } = await connect();
      const text = textOf(await call('get_retention', {}));
      await close();
      return text;
    } finally {
      globalThis.fetch = restore;
    }
  };

  it('leaves a tier that is off out of the sentence rather than printing a zero', async () => {
    const text = await read({ daily: 7, weekly: 0, monthly: 0 });
    expect(text).toContain('7 daily');
    expect(text).not.toContain('0 weekly');
    expect(text).not.toContain('0 monthly');
  });

  it('says an all-zero window grants nothing, without claiming what happens next', async () => {
    const text = await read({ daily: 0, weekly: 0, monthly: 0 });
    expect(text).toContain('no retained automatic history');
    // Deliberately absent: any claim that existing snapshots are deleted, or
    // that they are kept forever. The platform's own reference stops here too,
    // because the same three zeroes mean opposite things as an entitlement and
    // as a daemon policy.
    expect(text).not.toMatch(/kept forever|deleted/);
  });
});
