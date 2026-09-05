import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform, USAGE } from './harness.js';

// OPL-3765. What the account has spent, read by the model that is spending it.
//
// The platform grew `GET /usage` because the dashboard could read these figures
// and an API key could not, which is backwards for who needs them: the caller
// that launches computers in a loop is the one that can run up a bill without
// noticing, and here that caller is a model.
//
// What is pinned below is the seam, not the arithmetic — the platform owns the
// summing and its own tests own whether the numbers are right. Two things a
// server can get wrong about them:
//
//   - the shortfall flags, because a total that is quietly short reads exactly
//     like a total that is right, and a model reading a body top to bottom acts
//     on `vcpu_hours` long before it reaches `degraded`
//   - the window, because a timestamp with no zone is a silently shifted answer
//     rather than an error, and a model writing a date by hand is exactly the
//     caller that produces one

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** The platform answering `GET /usage` with the complete report, or a variant. */
const answering = (over: Record<string, unknown> = {}) =>
  (async () =>
    new Response(JSON.stringify({ ...USAGE, ...over }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

describe('get_usage', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('reads the billing period by naming no window', async () => {
    const { call, close } = await connect();
    const res = await call('get_usage', {});
    await close();

    const asked = platform.calls.find((c) => c.path === '/usage');
    expect(asked?.method).toBe('GET');
    // Not `?from=&to=`: the platform's default IS the billing period, so the
    // honest way to ask for it is to say nothing.
    expect([...(asked?.query.keys() ?? [])]).toEqual([]);
    expect(res.isError).toBeFalsy();
    // The headline figures, in the sentence — the JSON is under it, and a model
    // reading only the first line still has the answer.
    expect(textOf(res)).toContain('25 vCPU-hours');
    expect(textOf(res)).toContain('"disk_gb_months": 0.66');
  });

  it('puts every priced dimension in the sentence, memory and snapshots included', async () => {
    // Two were missing. The description promises hours "weighted by cores and
    // memory" and the line carried the cores half only; and apidoc.ts calls
    // snapshot_gb_months "the unit snapshots are priced in", which is the
    // figure that explains the bill of an account holding many durable
    // snapshots and running almost nothing. Both were in the JSON underneath
    // and nowhere in the sentence a model reads first.
    const { call, close } = await connect();
    const res = await call('get_usage', {});
    await close();

    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(text).toContain('50 GB-hours of RAM');
    expect(text).toContain('0.13 GB-months of snapshots');
    // Still the whole line, not one figure in place of another.
    expect(text).toContain('25 vCPU-hours');
    expect(text).toContain('12.5 running hours');
    expect(text).toContain('0.66 GB-months of disk');
  });

  it('does not print the hours twin of a figure the platform prices in months', async () => {
    // disk_gb_hours and snapshot_gb_hours are the same integrals in the unit
    // the platform does NOT price. The rule is "every dimension the platform
    // prices", not "every number it sends" — otherwise the line says each thing
    // twice and gets twice as easy to stop reading.
    const { call, close } = await connect();
    const res = await call('get_usage', {});
    await close();

    // Selected by its own content, not by paragraph index: when `degraded` or
    // `unmetered` is set, usageLine puts a TOO LOW warning first, and splitting
    // on the blank line would hand back the warning and pass every assertion
    // below without ever looking at the figures.
    const head = textOf(res)
      .split('\n\n')
      .find((p) => p.includes('vCPU-hours')) as string;
    expect(head).toBeTruthy();
    expect(head).not.toContain('GB-hours of disk');
    expect(head).not.toContain('GB-hours of snapshots');
    // 96 and 480 are snapshot_gb_hours and disk_gb_hours in the fixture.
    // Anchored on the figure, so an unrelated number containing 96 or 480
    // somewhere in a timestamp cannot fail this.
    expect(head).not.toMatch(/\b96\b/);
    expect(head).not.toMatch(/\b480\b/);
  });

  it('prints a metered zero rather than dropping the clause', async () => {
    // A clause that disappears when the figure is 0 makes "metered zero" and
    // "the platform did not send it" read identically — the distinction this
    // tool already refuses a missing totals object in order to keep.
    const restore = globalThis.fetch;
    globalThis.fetch = answering({ usage: { vcpu_hours: 1, ram_gb_hours: 0 } });
    try {
      const { call, close } = await connect();
      const res = await call('get_usage', {});
      await close();
      // Anchored on the clause boundary, not on a substring: the default
      // fixture's "50 GB-hours of RAM" contains "0 GB-hours of RAM" too, so a
      // bare toContain would pass even if the override stopped taking effect
      // and would then be pinning nothing.
      expect(textOf(res)).toMatch(/(^|[^\d.])0 GB-hours of RAM/);
      expect(textOf(res)).not.toContain('50 GB-hours of RAM');
    } finally {
      globalThis.fetch = restore;
    }
  });

  it('sends a window the caller names', async () => {
    const { call, close } = await connect();
    await call('get_usage', { from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' });
    await close();

    const asked = platform.calls.find((c) => c.path === '/usage');
    expect(asked?.query.get('from')).toBe('2026-07-01T00:00:00Z');
    expect(asked?.query.get('to')).toBe('2026-08-01T00:00:00Z');
  });

  it('refuses a timestamp with no zone rather than sending it', async () => {
    // The mistake a model makes, and it does not look like one: the platform
    // would refuse it too, but any client that parsed it locally would send an
    // instant shifted by however many hours the machine is offset — on the one
    // call whose output somebody compares against an invoice.
    const { call, close } = await connect();
    const res = await call('get_usage', { from: '2026-08-01' });
    await close();

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('time zone');
    expect(platform.calls.some((c) => c.path === '/usage')).toBe(false);
  });

  it('refuses a report with no totals object rather than billing it as zero', async () => {
    // `0 vCPU-hours` is a figure somebody metered. A report that arrived
    // without the object holding the figures is not that, and the two read
    // identically once `?? 0` has been applied to each field in turn.
    const restore = globalThis.fetch;
    globalThis.fetch = answering({ usage: undefined });
    try {
      const { call, close } = await connect();
      const res = await call('get_usage', {});
      await close();

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('NOT an account that used nothing');
      expect(textOf(res)).not.toContain('0 vCPU-hours');
    } finally {
      globalThis.fetch = restore;
    }
  });

  it('names a list as a list when the totals object is one', async () => {
    // The guard rejects an array explicitly, so an array is a shape that
    // REACHES the refusal — and `typeof []` is 'object', which made the
    // sentence say a body arrived as an object where the totals object goes.
    // A model reading that has been told the shape it wanted is the shape that
    // was wrong.
    const restore = globalThis.fetch;
    globalThis.fetch = answering({ usage: [] });
    try {
      const { call, close } = await connect();
      const res = await call('get_usage', {});
      await close();

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('answered with a list where the totals object goes');
      expect(textOf(res)).not.toContain('answered with object');
    } finally {
      globalThis.fetch = restore;
    }
  });

  it('refuses `to` without `from`, which both descriptions promise', async () => {
    // `to` alone is measured from the CURRENT billing period rather than from
    // the period it names, so it answers a different window instead of failing.
    const { call, close } = await connect();
    const res = await call('get_usage', { to: '2026-08-01T00:00:00Z' });
    await close();

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('to on its own');
    expect(platform.calls.some((c) => c.path === '/usage')).toBe(false);
  });
});

describe('the shortfalls', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const read = async (over: Record<string, unknown>) => {
    const restore = globalThis.fetch;
    globalThis.fetch = answering(over);
    try {
      const { call, close } = await connect();
      const res = await call('get_usage', {});
      await close();
      return textOf(res);
    } finally {
      globalThis.fetch = restore;
    }
  };

  it('says nothing extra when the fleet answered in full', async () => {
    expect(await read({})).not.toContain('TOO LOW');
  });

  it('warns FIRST when a hypervisor could not be reached', async () => {
    // Ahead of the numbers, deliberately. A caveat after a figure is a caveat
    // a model has already acted on — and this one is not "some rows are
    // missing", it is "every number you just read is smaller than the truth".
    const text = await read({ degraded: true });
    expect(text.indexOf('TOO LOW')).toBeLessThan(text.indexOf('vCPU-hours'));
    expect(text).toContain('this one clears');
  });

  it('keeps the shortfall that never clears apart from the one that does', async () => {
    // Two facts, not two flavours of one: an unreachable host comes back and an
    // old daemon does not, so telling a caller to wait for the second is advice
    // that never comes true.
    const text = await read({ degraded: false, unmetered: true });
    expect(text).toContain('older than the meter');
    expect(text).toContain('waiting will not fix it');
    expect(text).not.toContain('could not be reached');
  });

  it('names both when both happened', async () => {
    const text = await read({ degraded: true, unmetered: true });
    expect(text).toContain('could not be reached');
    expect(text).toContain('older than the meter');
  });

  it('still reports the numbers the fleet did answer with', async () => {
    // A caveat is not a reason to withhold the part that is known.
    expect(await read({ degraded: true })).toContain('25 vCPU-hours');
  });
});
