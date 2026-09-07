import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

// OPL-4568. `POST /computers/:id/snapshots` answers 202 with a placeholder now
// (platform OPL-4562), and this server read that placeholder as the finished
// snapshot: "Snapshotted vm-1" was said over a copy that had not started
// copying, and the id in the answer was one restore, clone and delete all 404
// on for the next several minutes.
//
// What is pinned here is the POLL and the three answers it has to keep apart.
// A capture that lands, a capture that FAILS — which the platform signals by the
// row disappearing and nothing else — and a wait that ran out with the capture
// still running. The last two are the pair that must never blur: one says go and
// take it again, the other says go and look for a snapshot that is on its way.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** The row the 202 hands back: the id the snapshot will keep, and no snapshot yet. */
const PLACEHOLDER = {
  id: 'snap-7',
  computer_id: 'vm-1',
  name: 'before the upgrade',
  kind: 'disk',
  state: 'capturing',
};

/**
 * A scheduled capture of the same computer, finishing in the same window.
 *
 * The row that makes "take the newest snapshot of this computer" wrong, which is
 * why every listing below carries it. It is newer, it is finished, and it is not
 * the one this call took.
 */
const SOMEONE_ELSES = {
  id: 'snap-9',
  computer_id: 'vm-1',
  name: 'vm-1 2026-09-07 03:00',
  kind: 'disk',
  state: 'durable',
  auto: true,
  created_at: '2126-09-07T03:00:00.000Z',
};

/**
 * The platform, answering the POST once and then a scripted sequence of
 * listings.
 *
 * A function per listing rather than a list of bodies, because half of these
 * cases are about a listing that FAILS — a 503, a body that is not a list — and
 * those are not values. The last entry repeats once the script runs out, so a
 * test that is about the deadline does not have to count polls.
 */
const platformThat = (listings: (() => Response)[], accepted: unknown = PLACEHOLDER) => {
  const seen: string[] = [];
  let n = 0;
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    seen.push(`${method} ${url.pathname}`);
    if (method === 'POST') {
      return new Response(JSON.stringify(accepted), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const at = Math.min(n++, listings.length - 1);
    return listings[at]();
  }) as typeof globalThis.fetch;
  return { stub, seen };
};

const listing = (rows: unknown[], headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(rows), {
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const unavailable = () =>
  new Response(JSON.stringify({ error: 'a hypervisor did not answer' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });

describe('a capture the platform only accepted', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  const capture = async (
    listings: (() => Response)[],
    args: Record<string, unknown> = {},
    accepted: unknown = PLACEHOLDER,
  ) => {
    const p = platformThat(listings, accepted);
    globalThis.fetch = p.stub;
    const { call, close } = await connect();
    const res = await call('create_snapshot', { name: 'before the upgrade', ...args });
    await close();
    return { res, seen: p.seen };
  };

  it('waits for the row to stop reading capturing, and reports the snapshot', async () => {
    const { res, seen } = await capture([
      () => listing([SOMEONE_ELSES, PLACEHOLDER]),
      () => listing([SOMEONE_ELSES, { ...PLACEHOLDER, state: 'pending' }]),
    ]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('The capture landed');
    expect(textOf(res)).toContain('snap-7');
    // The placeholder was never reported as the answer. That sentence over a
    // `capturing` row is the whole defect: it reads as a finished snapshot.
    expect(textOf(res)).not.toContain('capturing"');
    expect(seen.filter((c) => c === 'GET /api/v1/snapshots')).toHaveLength(2);
  }, 10_000);

  it('matches on the id it was given, not on the newest snapshot of the computer', async () => {
    // A scheduled capture finishing inside the window is the case that makes
    // "the newest row for this computer" wrong, and it is wrong exactly on the
    // long captures where a poll matters.
    const { res } = await capture([
      () => listing([{ ...PLACEHOLDER, state: 'capturing' }, SOMEONE_ELSES]),
      () => listing([{ ...PLACEHOLDER, state: 'durable' }, SOMEONE_ELSES]),
    ]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('snap-7');
    expect(textOf(res)).not.toContain('snap-9');
  }, 10_000);

  it('takes durable as landed, rather than watching for the literal pending', async () => {
    // Replication can carry a small snapshot from `pending` to `durable` between
    // two polls. A loop waiting for the string `pending` watches it go past and
    // never matches — the platform's own reference says so in as many words.
    const { res } = await capture([() => listing([{ ...PLACEHOLDER, state: 'durable' }])]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('durable');
  });

  it('reads the row vanishing as the capture having failed', async () => {
    // The only signal there is. A capture that fails during the copy leaves no
    // snapshot and no row, and the POST it would have been reported on was
    // answered minutes earlier.
    const { res } = await capture([() => listing([SOMEONE_ELSES])]);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('FAILED');
    expect(textOf(res)).toContain('nothing was saved');
    // Said as a failure and not as a wait that ran out, because those two ask
    // for opposite next steps.
    expect(textOf(res)).not.toContain('STILL RUNNING');
  });

  it('does not read a short listing as a capture that failed', async () => {
    // A row missing because a hypervisor did not answer is not a row that
    // failed. Announcing someone's backup as lost while it is still being taken
    // is worse than saying nothing, so the incomplete answer decides nothing and
    // the next complete one gets to.
    const { res } = await capture([
      () => listing([SOMEONE_ELSES], { 'X-GC-Incomplete': '1' }),
      () => listing([{ ...PLACEHOLDER, state: 'pending' }, SOMEONE_ELSES]),
    ]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('The capture landed');
  }, 10_000);

  it('rides out a poll that fails the way a fleet read fails', async () => {
    const { res } = await capture([
      unavailable,
      () => listing([{ ...PLACEHOLDER, state: 'pending' }]),
    ]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('The capture landed');
  }, 10_000);

  it('says the capture is still running when the wait runs out', async () => {
    const { res } = await capture([() => listing([PLACEHOLDER])], { timeout_s: 5 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Still capturing after 5s');
    expect(textOf(res)).toContain('STILL RUNNING');
    // And the id to follow it by, with both rules for reading the row.
    expect(textOf(res)).toContain('snap-7');
    expect(textOf(res)).toContain('DISAPPEARS');
    expect(textOf(res)).not.toContain('FAILED');
  }, 15_000);

  it('names the platform’s own silence when the poll never got an answer', async () => {
    const { res } = await capture([unavailable], { timeout_s: 5 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('could not be asked');
    expect(textOf(res)).toContain('STILL RUNNING');
  }, 15_000);

  it('does not read a row with no state as one that stopped capturing', async () => {
    // "Not capturing, therefore landed" over a row the platform could not
    // describe is the same sentence this whole tool exists to stop: it says a
    // placeholder may be restored. Only a state that says so ends the wait.
    const { res } = await capture([() => listing([{ id: 'snap-7', computer_id: 'vm-1' }])], {
      timeout_s: 5,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('carried no state');
    expect(textOf(res)).toContain('STILL RUNNING');
    expect(textOf(res)).not.toContain('The capture landed');
  }, 15_000);

  it('does not read an unreachable row as one that landed either', async () => {
    // The same case one level down: a row served from the placement cache
    // carries an id and a last-known state and can settle nothing.
    const { res } = await capture([
      () => listing([{ id: 'snap-7', unreachable: true }]),
      () => listing([{ ...PLACEHOLDER, state: 'pending' }]),
    ]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('The capture landed');
  }, 10_000);

  it('hands back the placeholder and polls nothing when wait is false', async () => {
    const { res, seen } = await capture([() => listing([PLACEHOLDER])], { wait: false });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Capture of vm-1 started');
    expect(textOf(res)).toContain('NOT a snapshot yet');
    expect(textOf(res)).toContain('snap-7');
    expect(seen).toEqual(['POST /api/v1/computers/vm-1/snapshots']);
  });

  it('refuses rather than waiting when the acceptance carried no id', async () => {
    // Nothing to poll on and nothing to name later: every call that acts on a
    // snapshot takes the id. The capture is running all the same, and that is
    // the half a bare failure would never mention.
    const { res, seen } = await capture([() => listing([])], {}, { state: 'capturing' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('THE CAPTURE IS RUNNING');
    expect(seen).toEqual(['POST /api/v1/computers/vm-1/snapshots']);
  });
});

describe('what a capture sends', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('keeps wait and timeout_s off the wire', async () => {
    // They are this tool's own arguments. The platform has never heard of
    // either, and a field it does not read is a field it ignores in silence.
    const { call, close } = await connect();
    await call('create_snapshot', { name: 'clean install', wait: true, timeout_s: 60 });
    await close();
    const post = platform.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ memory: false, name: 'clean install' });
  });
});
