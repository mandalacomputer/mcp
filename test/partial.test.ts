import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE, connect, installFakePlatform } from './harness.js';

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/**
 * Inventories the platform could only answer in part.
 *
 * `GET /computers` and `GET /snapshots` fan out across hypervisors. /api/v1
 * fails closed about a short answer — 503 unless the caller opted in — so there
 * are two paths to get right, and they fail in opposite directions: the strict
 * one must not look like an empty account, and the permissive one must not look
 * like a complete list.
 */
describe('a listing the platform could not complete', () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  /**
   * Answers as the platform does when a hypervisor is unreachable.
   *
   * Scoped to the API host for the reason installFakePlatform is: the
   * HTTP-transport tests stand a real server up on localhost and reach it with
   * this same global, and a fake that swallows those makes every one of them
   * pass against a stub of the wrong thing.
   */
  function fleetPartlyDown(opts: { strict: boolean; missing: number; rows?: unknown[] }) {
    const real = globalThis.fetch;
    restore = () => {
      globalThis.fetch = real;
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.host !== new URL(BASE).host) return real(input as never, init);
      const partial = url.searchParams.get('allow_partial');
      if (opts.strict && !partial) {
        return new Response(
          JSON.stringify({
            error: `Right now ${opts.missing} of your computers are on a hypervisor that cannot be reached, so this list would be incomplete. Retry, or pass allow_partial=1 to accept a partial answer.`,
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'X-GC-Incomplete': String(opts.missing),
            },
          },
        );
      }
      return new Response(
        JSON.stringify(opts.rows ?? [{ id: 'vm-1', name: 'a', status: 'running' }]),
        {
          headers: {
            'Content-Type': 'application/json',
            'X-GC-Incomplete': String(opts.missing),
          },
        },
      );
    }) as typeof fetch;
  }

  it('surfaces the refusal rather than an empty account', async () => {
    fleetPartlyDown({ strict: true, missing: 3 });
    const { call, close } = await connect();
    const res = await call('list_computers', {});
    await close();
    expect(res.isError).toBe(true);
    // The platform's sentence, which is the one that names the remedy.
    expect(textOf(res)).toContain('allow_partial');
  });

  it('says a partial answer is partial, in prose and first', async () => {
    fleetPartlyDown({ strict: true, missing: 3 });
    const { call, close } = await connect();
    const res = await call('list_computers', { allow_partial: true });
    await close();
    const out = textOf(res);
    expect(out.startsWith('INCOMPLETE')).toBe(true);
    expect(out).toContain('3 of your computers');
    // The sentence that stops a model tidying up after something that has not
    // been deleted.
    expect(out).toContain('Do not treat anything absent from it as deleted');
  });

  it('warns even when the count is zero, because presence is the signal', async () => {
    // Legitimately zero: a computer created during the outage was never cached
    // against the host now holding it, so the number is what the cache could
    // account for rather than what is missing.
    fleetPartlyDown({ strict: true, missing: 0 });
    const { call, close } = await connect();
    const res = await call('list_computers', { allow_partial: true });
    await close();
    expect(textOf(res)).toContain('INCOMPLETE');
  });

  it('does not tell a model to create a computer during an outage', async () => {
    // A workspace-scoped key gets NO unreachable placeholder rows — the
    // platform withholds them rather than name computers in other workspaces —
    // so header-present with an empty array is the ordinary shape of an outage
    // for such a key. Answering "no computers yet, create one" there is the
    // duplicate-create the warning exists to prevent.
    fleetPartlyDown({ strict: true, missing: 0, rows: [] });
    const { call, close } = await connect();
    const res = await call('list_computers', { allow_partial: true });
    await close();
    const out = textOf(res);
    expect(out).toContain('INCOMPLETE');
    expect(out).toContain('NOT an empty account');
    expect(out).not.toContain('No computers on this account yet');
  });

  it('does not cry incomplete on an ordinary answer', async () => {
    const platform = installFakePlatform();
    restore = platform.restore;
    const { call, close } = await connect();
    const res = await call('list_computers', {});
    await close();
    expect(textOf(res)).not.toContain('INCOMPLETE');
  });

  it('keeps the unreachable rows a per-computer filter would otherwise delete', async () => {
    // What a partial snapshot listing actually looks like: real rows, plus one
    // stub per snapshot the platform could not reach. publicSnapshot drops
    // computer_id from a stub — there is no daemon to have said what it belongs
    // to — so an equality filter deletes exactly the rows that say something is
    // missing, and then reports a confident count about one machine.
    fleetPartlyDown({
      strict: true,
      missing: 2,
      rows: [
        { id: 'snap-1', computer_id: 'vm-1', name: 'mine', state: 'durable' },
        { id: 'snap-2', computer_id: 'vm-other', name: 'someone else', state: 'durable' },
        { id: 'snap-3', unreachable: true },
        { id: 'snap-4', unreachable: true },
      ],
    });
    const { call, close } = await connect();
    const res = await call('list_snapshots', { computer_id: 'vm-1', allow_partial: true });
    await close();
    const out = textOf(res);

    expect(out).toContain('INCOMPLETE');
    // The other computer's snapshot is filtered out; the two unreadable ones
    // are not, because nothing knows they are not this computer's.
    expect(out).toContain('3 snapshot(s)');
    expect(out).toContain('snap-3');
    expect(out).not.toContain('someone else');
    // And they are labelled, so the count is not read as three usable ones.
    expect(out).toContain('could not be read');
  });
});

describe('snapshots part-way through a failed deletion', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  afterEach(() => platform.restore());

  it('are left out by default and asked for explicitly', async () => {
    platform = installFakePlatform();
    const { call, close } = await connect();

    await call('list_snapshots', {});
    expect(platform.calls.at(-1)?.query.get('include')).toBeNull();

    // They are not restorable or clonable, but they still hold objects and are
    // still billed — so a question about storage has to be able to reach them.
    await call('list_snapshots', { include_unfinished: true });
    expect(platform.calls.at(-1)?.query.get('include')).toBe('unfinished');
    await close();
  });
});
