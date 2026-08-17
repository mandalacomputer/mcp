import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

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

  /** Answers as the platform does when a hypervisor is unreachable. */
  function fleetPartlyDown(opts: { strict: boolean; missing: number }) {
    const real = globalThis.fetch;
    restore = () => {
      globalThis.fetch = real;
    };
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
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
      return new Response(JSON.stringify([{ id: 'vm-1', name: 'a', status: 'running' }]), {
        headers: {
          'Content-Type': 'application/json',
          'X-GC-Incomplete': String(opts.missing),
        },
      });
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

  it('does not cry incomplete on an ordinary answer', async () => {
    const platform = installFakePlatform();
    restore = platform.restore;
    const { call, close } = await connect();
    const res = await call('list_computers', {});
    await close();
    expect(textOf(res)).not.toContain('INCOMPLETE');
  });

  it('warns on a filtered snapshot listing too, where the filter hides the shortfall', async () => {
    fleetPartlyDown({ strict: true, missing: 2 });
    const { call, close } = await connect();
    // The filter narrows to one computer, so the count reported is small and
    // confident. Without the header that is a wrong answer about one machine
    // built out of a fleet-wide outage.
    const res = await call('list_snapshots', { computer_id: 'vm-1', allow_partial: true });
    await close();
    expect(textOf(res)).toContain('INCOMPLETE');
    expect(textOf(res)).toContain('snapshots');
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
