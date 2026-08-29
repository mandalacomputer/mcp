import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, isTransient, MoveRequiredError } from '../src/errors.js';
import { connect, installFakePlatform } from './harness.js';

// OPL-3775. The resize that needs the computer moved, from the refusal to the
// outcome.
//
// This server met the refusal already — update_computer is the resize tool — and
// did two things wrong with it. It had nothing to call, so the model was handed
// an offer in prose and no way to take it. And ConflictError told it to retry,
// which is true of every other 409 this server meets and false of this one: the
// host cannot run that size and will not grow, so the same request answers the
// same way forever. isTransient is exported, so that claim reached embedders
// too.
//
// What is pinned here is therefore the SEAM rather than the move: that the
// refusal becomes a next step, that the retry predicate says no, and that the
// four terminal states are read as the four different things they are — because
// `moved` is the one where the computer really has changed and a caller reading
// it as "the move failed" goes looking for a machine that is no longer there.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** A 409 carrying the platform's move offer, which is what makes it one. */
const offer = (possible: boolean, message = 'that is more RAM than this host can run') =>
  (async () =>
    new Response(JSON.stringify({ error: message, move: { required: true, possible } }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

describe('the retry predicate', () => {
  it('says no to a move offer and yes to every other conflict', () => {
    // The bug, as one line. isTransient is exported and documented as a contract
    // with embedders, so a host application wrapping a resize in
    // `if (isTransient(err)) retry()` looped on a refusal that was a decision.
    const move = new MoveRequiredError(
      'needs a move',
      409,
      { move: { required: true, possible: true } },
      true,
    );
    expect(isTransient(move)).toBe(false);
    // And the ordinary 409 is untouched — a guest still booting is exactly what
    // the predicate is for, and narrowing it to nothing would be the opposite
    // mistake.
    expect(isTransient(new ConflictError('the guest agent is not answering yet', 409))).toBe(true);
  });

  it('is a ConflictError still, so anything matching on the family keeps working', () => {
    // A subclass rather than a sibling, deliberately: an embedder that branches
    // on ConflictError to render "the computer is in the wrong state for this"
    // should go on doing so. What changes is only the retry answer.
    const move = new MoveRequiredError('needs a move', 409, {}, false);
    expect(move).toBeInstanceOf(ConflictError);
  });
});

describe('a 409 that carries a move offer', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('tells the model the retry is pointless and names what to call instead', async () => {
    globalThis.fetch = offer(true);
    const { call, close } = await connect();
    const res = await call('update_computer', { computer_id: 'vm-1', ram_mb: 32768 });
    await close();

    expect(res.isError).toBe(true);
    // The platform's own sentence survives: it is the one that says what will
    // not fit and what moving costs.
    expect(textOf(res)).toContain('more RAM than this host can run');
    // And the two things that sentence cannot know.
    expect(textOf(res)).toContain('does not clear by itself');
    expect(textOf(res)).toContain('move_computer');
    // The cost, in the terms whoever is paying would want it.
    expect(textOf(res)).toContain('different hardware');
  });

  it('does not offer a move that the platform said is impossible', async () => {
    // `possible:false` means nowhere in the region can run that size. Naming
    // move_computer here would be sending the model at a call that is a
    // guaranteed refusal — the same dead end, one tool along.
    globalThis.fetch = offer(false);
    const { call, close } = await connect();
    const res = await call('update_computer', { computer_id: 'vm-1', ram_mb: 999_999 });
    await close();

    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('move_computer');
    expect(textOf(res)).toContain('less RAM');
  });

  it('leaves an ordinary conflict alone', async () => {
    // No `move` on the body, so this is not that refusal and must not be
    // dressed up as one. `moveOffer` shape-checks for exactly this reason.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'this computer is running' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('update_computer', { computer_id: 'vm-1', ram_mb: 4096 });
    await close();

    expect(textOf(res)).toContain('this computer is running');
    expect(textOf(res)).not.toContain('move_computer');
  });

  it('is not fooled by a body with a move-shaped key that is not one', async () => {
    // Absent and malformed are the same answer, and it is the conservative one:
    // an ordinary ConflictError, which is what this was before. A `move` that is
    // a string, or one with no boolean `possible`, must not become an offer with
    // `movePossible` quietly false — that would advertise "nowhere in the region
    // can run this" on the strength of a field nobody sent.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'refused', move: 'yes' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('update_computer', { computer_id: 'vm-1', ram_mb: 4096 });
    await close();

    expect(textOf(res)).not.toContain('move_computer');
    expect(textOf(res)).not.toContain('less RAM');
  });
});

describe('move_computer', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('sends only the sizing group, and reports the outcome rather than the 202', async () => {
    const { call, close } = await connect();
    const res = await call('move_computer', { computer_id: 'vm-1', ram_mb: 26000, cpu: 2 });
    await close();

    const post = platform.calls.find((c) => c.method === 'POST' && c.path.endsWith('/move'));
    expect(post?.path).toBe('/computers/vm-1/move');
    // No `name`, no `idle_suspend_min`, and no `timeout_s` — that last one is
    // this tool's own argument and the platform has never heard of it.
    expect(post?.body).toEqual({ ram_mb: 26000, cpu: 2 });

    // The 202 says `moving`; the answer says what actually happened. A tool that
    // handed back the 202 would report a move as unfinished every time.
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('moved and is now');
    expect(platform.calls.some((c) => c.method === 'GET' && c.path === '/moves')).toBe(true);
  });

  it('refuses to be called without the size that did not fit', async () => {
    // ram_mb is required here and optional on update_computer, because the
    // platform fills an omitted one from the computer's current size and then
    // refuses the move for not needing one. A call without it can only ever be
    // refused, so the schema is where that is stopped.
    const { call, close } = await connect();
    const res = await call('move_computer', { computer_id: 'vm-1', cpu: 4 });
    await close();
    expect(res.isError).toBe(true);
    expect(platform.calls.some((c) => c.path.endsWith('/move'))).toBe(false);
  });
});

describe('a move that has stopped', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  /** The platform, answering the POST and then one terminal state. */
  const ending = (state: string, detail = '') =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const started = { computer_id: 'vm-1', state: 'moving', live: true, ram_mb: 26000 };
      const body = url.pathname.endsWith('/moves')
        ? { moves: [{ ...started, state, detail, live: false }] }
        : started;
      return new Response(JSON.stringify(body), {
        status: (init?.method ?? 'GET') === 'POST' ? 202 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

  const outcome = async (state: string, detail = '') => {
    globalThis.fetch = ending(state, detail);
    const { call, close } = await connect();
    const res = await call('move_computer', { computer_id: 'vm-1', ram_mb: 26000 });
    await close();
    return res;
  };

  it('reads `moved` as the computer having changed, not as a failure', async () => {
    // The state this whole formatter exists for. The move LANDED and the resize
    // did not, so the computer is on another host at its old size — and a caller
    // told "the move failed" goes looking for a machine that is no longer where
    // it was. It is also recoverable with an ordinary resize, which is the half
    // a bare failure message would never mention.
    const res = await outcome('moved', 'your plan is capped at 16 vCPU.');
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('MOVED to another host but was NOT resized');
    expect(textOf(res)).toContain('does not need repeating');
    expect(textOf(res)).toContain('update_computer');
    // The platform's own account of why the resize did not apply survives.
    expect(textOf(res)).toContain('capped at 16 vCPU');
  });

  it('reads `failed` as nothing having happened', async () => {
    const res = await outcome('failed');
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('where it was, untouched');
    // The opposite claim to `moved`, and the two must never blur: this one says
    // the computer did not go anywhere.
    expect(textOf(res)).not.toContain('another host');
  });

  it('reads `lost` as not knowing, and says to go and look', async () => {
    const res = await outcome('lost');
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('cannot say whether it finished');
    expect(textOf(res)).toContain('get_computer');
  });

  it('reads `done` as success', async () => {
    const res = await outcome('done');
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('moved and is now');
  });
});

describe('list_moves', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('reads the account’s moves, which is how a blocked move is explained', async () => {
    // One move runs per account, so "another computer on this account is being
    // moved right now" is a refusal with no name in it. This is where the name
    // is.
    const { call, close } = await connect();
    const res = await call('list_moves', {});
    await close();

    expect(platform.calls.some((c) => c.method === 'GET' && c.path === '/moves')).toBe(true);
    expect(textOf(res)).toContain('vm-1');
    expect(textOf(res)).toContain('done');
  });

  it('refuses an unreadable table rather than reporting a quiet account', async () => {
    // An envelope with no `moves` array is the platform failing to answer, and
    // reading it as `[]` says the opposite of what is known: that nothing is
    // running. A move the caller started may well be.
    const restore = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('list_moves', {});
      await close();

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('not a list of moves');
      expect(textOf(res)).not.toContain('No moves on this account');
    } finally {
      globalThis.fetch = restore;
    }
  });
});
