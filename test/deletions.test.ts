import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

// OPL-4577. `DELETE /snapshots/:id` answers 202 now and removes the objects
// afterwards (platform OPL-4572), and this tool answered off the DELETE — so it
// reported a snapshot deleted at the instant the platform had merely accepted
// the work, and if the deletion then stalled nothing ever corrected it.
//
// The polarity is the opposite of a capture's and that is the whole of it. A
// capture is finished when its row STOPS READING `capturing`, and a failed one
// leaves no row at all. A deletion is finished when its row GOES, and one that
// stalls leaves a row behind — in `deleting`, a state a bare listing hides. So
// the poll must ask for the unfinished ones, and absence must never be read off
// a listing this client did not get whole.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const ROW = {
  id: 'snap-7',
  computer_id: 'vm-1',
  name: 'before the upgrade',
  kind: 'disk',
  state: 'durable',
};

/** Another snapshot, so an empty answer is never what makes a test pass. */
const OTHER = { ...ROW, id: 'snap-9', name: 'nightly' };

const listing = (rows: unknown[], headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(rows), {
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const unavailable = () =>
  new Response(JSON.stringify({ error: 'a hypervisor did not answer' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * The platform, answering the DELETE once and then a scripted run of listings.
 *
 * `accepted` is what the DELETE answers — a Response, so a test can make it a
 * refusal as easily as a 202. The last listing repeats once the script runs
 * out, so a test about the deadline does not have to count polls.
 */
const platformThat = (
  listings: (() => Response)[],
  accepted?: (init?: RequestInit) => Response | Promise<Response>,
) => {
  const seen: string[] = [];
  let n = 0;
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    seen.push(`${method} ${url.pathname}${url.search}`);
    if (method === 'DELETE') {
      return (
        accepted?.(init) ??
        new Response(JSON.stringify(ROW), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
    const at = Math.min(n++, listings.length - 1);
    return listings[at]();
  }) as typeof globalThis.fetch;
  return { stub, seen };
};

/**
 * A request that never answers, and ends the way a real one ends: when the
 * signal the client armed says to stop.
 *
 * Rejecting on its own would be a different failure — `Api` classifies a
 * transport error whose signal is intact as one that happened AFTER the request
 * was sent, which is a true statement about a different thing. The cancellation
 * path is reached only when the WATCHED SIGNAL is what fired, so the stub has to
 * honour it exactly as fetch does.
 */
const hangs = (init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });

describe('a deletion the platform only accepted', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  const del = async (
    listings: (() => Response)[],
    args: Record<string, unknown> = {},
    accepted?: (init?: RequestInit) => Response | Promise<Response>,
  ) => {
    const p = platformThat(listings, accepted);
    globalThis.fetch = p.stub;
    const { call, close } = await connect();
    const res = await call('delete_snapshot', { snapshot_id: 'snap-7', confirm: true, ...args });
    await close();
    return { res, seen: p.seen };
  };

  it('waits for the row to go, and asks for the unfinished ones while it does', async () => {
    const { res, seen } = await del([
      () => listing([ROW, OTHER]),
      () => listing([{ ...ROW, state: 'deleting' }, OTHER]),
      () => listing([OTHER]),
    ]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Deleted snapshot snap-7');
    // Without `include=unfinished` the platform hides a half-deleted row, and a
    // deletion stuck in `deleting` would read as one that finished.
    expect(seen.filter((c) => c.startsWith('GET'))).toHaveLength(3);
    for (const g of seen.filter((c) => c.startsWith('GET'))) {
      expect(g).toContain('include=unfinished');
    }
  }, 15_000);

  it('does not report a deletion off a listing it did not get whole', async () => {
    // The one wrong answer this tool must not give. A row missing because a
    // hypervisor did not answer is not a row that is gone, and "Deleted" said
    // over it is unrecoverable: nobody goes looking for a snapshot they have
    // been told was destroyed.
    const { res } = await del([
      () => listing([OTHER], { 'X-GC-Incomplete': '1' }),
      () => listing([ROW, OTHER]),
      () => listing([OTHER]),
    ]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Deleted snapshot snap-7');
  }, 15_000);

  it('says a row that stayed in deleting is one that stalled, not a timeout', async () => {
    const { res } = await del([() => listing([{ ...ROW, state: 'deleting' }])], { timeout_s: 5 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('still listed after 5s');
    expect(textOf(res)).toContain('"deleting"');
    expect(textOf(res)).toContain('every fifteen minutes');
    // Never the claim the whole change exists to stop.
    expect(textOf(res)).not.toContain('Deleted snapshot');
  }, 15_000);

  it('reads a row still in its ordinary state as work that has not reached it', async () => {
    // The shape the one conflict that arrives AFTER the 202 leaves behind: a
    // dependent that is itself being deleted cannot be detached, so this
    // deletion waits for that one. The row stays exactly as it was.
    const { res } = await del([() => listing([ROW])], { timeout_s: 5 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('reading "durable"');
    expect(textOf(res)).toContain('dependent');
    expect(textOf(res)).not.toContain('Deleted snapshot');
  }, 15_000);

  it('blames the platform’s silence rather than the deletion when it cannot ask', async () => {
    const { res } = await del([unavailable], { timeout_s: 5 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('could not be asked');
    expect(textOf(res)).toContain('STILL RUNNING');
  }, 15_000);

  it('hands back as soon as it is accepted when wait is false, and polls nothing', async () => {
    const { res, seen } = await del([() => listing([ROW])], { wait: false });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('accepted and RUNNING');
    expect(textOf(res)).toContain('not gone yet');
    expect(seen).toEqual(['DELETE /api/v1/snapshots/snap-7']);
  });

  it('reads a conflict as progress rather than as something to work around', async () => {
    // A second DELETE while the first is working answers 409 `this snapshot is
    // already being deleted`. A model told only "conflict" goes looking for
    // another way to get rid of it; what it needs is that the platform is doing
    // the thing it asked for.
    const { res, seen } = await del(
      [() => listing([ROW])],
      {},
      () =>
        new Response(JSON.stringify({ error: 'this snapshot is already being deleted' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('already being deleted');
    expect(textOf(res)).toContain('NOTHING WAS DELETED');
    expect(textOf(res)).toContain('watch it finish');
    // The platform's own sentence survives, and no poll was started off a
    // deletion that never began.
    expect(seen).toEqual(['DELETE /api/v1/snapshots/snap-7']);
  });

  it('says the deletion may be running when the request itself was cut short', async () => {
    // The deadline arriving while the DELETE is in flight. The generic
    // cancellation sentence says the request may have been received; what it
    // cannot say is that the work it starts OUTLIVES the request, so
    // "cancelled" reads as a deletion that did not happen while the objects are
    // being removed. Claiming less than happened, which on a destructive call is
    // its own kind of wrong answer (codex review, gpt-5.6-sol).
    const { res } = await del([() => listing([ROW])], { timeout_s: 5 }, hangs);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('MAY BE RUNNING');
    expect(textOf(res)).toContain('snap-7');
    // And the one thing that makes it recoverable.
    expect(textOf(res)).toContain('Calling this again is safe');
  }, 15_000);

  it('still reads a 404 as nothing to delete rather than as a deletion', async () => {
    const { res } = await del(
      [() => listing([])],
      {},
      () =>
        new Response(JSON.stringify({ error: 'no such snapshot' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    expect(textOf(res)).toContain('Nothing was deleted');
    expect(textOf(res)).not.toContain('Deleted snapshot');
  });
});

describe('what a deletion sends', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('keeps wait and timeout_s off the wire', async () => {
    const { call, close } = await connect();
    const res = await call('delete_snapshot', {
      snapshot_id: 'snap-1',
      confirm: true,
      wait: true,
      timeout_s: 60,
    });
    await close();
    expect(res.isError).toBeFalsy();
    const sent = platform.calls.find((c) => c.method === 'DELETE');
    expect(sent?.path).toBe('/snapshots/snap-1');
    expect([...(sent?.query.keys() ?? [])]).toEqual([]);
  });
});
