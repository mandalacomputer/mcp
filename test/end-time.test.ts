import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { describe as describeComputer } from '../src/format.js';
import { createBody } from '../src/paths.js';
import { endTimeProblem } from '../src/tools/computers.js';
import { connect } from './harness.js';

// A computer's end time on create_computer and update_computer, and the
// summary line naming it.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

type Seen = { method: string; path: string; body?: unknown };

async function platform<T>(
  respond: (seen: Seen) => [number, unknown] | [number, unknown, Record<string, string>],
  fn: (seen: Seen[]) => Promise<T>,
): Promise<T> {
  const restore = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const call: Seen = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname.replace(/^\/api\/v1/, ''),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(call);
    const [status, body, headers = {}] = respond(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = restore;
  }
}

const ENDS = '2026-11-01T18:00:00Z';
/** The end time a request asked for, as a platform that keeps it answers. */
const echoed = (body: unknown): Record<string, unknown> => {
  const b = (body ?? {}) as { ends_at?: unknown; ends_in_hours?: unknown };
  if (typeof b.ends_at === 'string') return { ends_at: b.ends_at };
  if (typeof b.ends_in_hours === 'number')
    return {
      ends_at: new Date(Math.floor((Date.now() + b.ends_in_hours * 3_600_000) / 1000) * 1000)
        .toISOString()
        .replace('.000Z', 'Z'),
    };
  return {};
};
const box = (extra: Record<string, unknown> = {}) => ({
  id: 'vm-1',
  name: 'box',
  status: 'running',
  running_ram_mb: 2048,
  ...extra,
});

describe('createBody with an end time', () => {
  it('sends ends_at or ends_in_hours as given', () => {
    expect(createBody({ template: 'base', ends_at: ENDS })).toEqual({
      template: 'base',
      ends_at: ENDS,
      start: true,
    });
    expect(createBody({ template: 'base', ends_in_hours: 0.5 })).toEqual({
      template: 'base',
      ends_in_hours: 0.5,
      start: true,
    });
  });

  it('refuses both at once', () => {
    expect(() => createBody({ ends_at: ENDS, ends_in_hours: 2 })).toThrow(/not both/);
  });
});

describe('create_computer with an end time', () => {
  it('sends ends_in_hours and reports the end time', async () => {
    const res = await platform(
      (req) => [201, box(echoed(req.body))],
      async (seen) => {
        const { call, close } = await connect({ computerId: undefined });
        const r = await call('create_computer', { template: 'base', ends_in_hours: 8 });
        await close();
        const post = seen.find((s) => s.method === 'POST' && s.path === '/computers');
        expect(post?.body).toEqual({ template: 'base', ends_in_hours: 8, start: true });
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('stops by itself at ');
  });

  it.each([
    [{ ends_at: ENDS, ends_in_hours: 2 }],
    [{ ends_at: 'tomorrow' }],
    [{ ends_at: '' }],
    [{ ends_in_hours: 0 }],
    [{ ends_in_hours: -1 }],
  ])('refuses %j before any request', async (args) => {
    await platform(
      () => [201, box()],
      async (seen) => {
        const { call, close } = await connect({ computerId: undefined });
        const r = await call('create_computer', { template: 'base', ...args });
        await close();
        expect(r.isError).toBe(true);
        expect(seen.filter((s) => s.method === 'POST')).toEqual([]);
      },
    );
  });
});

describe('update_computer with an end time', () => {
  it.each([
    [{ ends_at: ENDS }],
    [{ ends_in_hours: 2.5 }],
    [{ ends_at: null }],
    [{ ends_in_hours: null }],
  ])('sends %j alone', async (fields) => {
    await platform(
      (req) => [200, box(echoed(req.body))],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', fields);
        await close();
        expect(r.isError).toBeFalsy();
        expect(seen).toEqual([{ method: 'PATCH', path: '/computers/vm-1', body: fields }]);
      },
    );
  });

  it.each([
    [{ ends_at: ENDS, name: 'x' }, 'ends_at must be sent on its own, not beside name'],
    [{ ends_in_hours: 1, idle_suspend_min: 30 }, 'ends_in_hours must be sent on its own'],
    [{ ends_at: null, cpu: 2 }, 'ends_at must be sent on its own'],
    [{ ends_at: ENDS, ends_in_hours: 1 }, 'not both'],
  ])('refuses %j before any request', async (fields, says) => {
    await platform(
      () => [200, box()],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', fields);
        await close();
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain(says);
        expect(seen).toEqual([]);
      },
    );
  });
});

// An older platform ignores a body field it does not know and answers as if
// it had been applied. An end time the answer does not confirm is an error,
// and the computer is left alone: no stop, no delete.
describe('an end time the answer does not confirm', () => {
  it('create_computer: errors naming the computer, and sends nothing more', async () => {
    await platform(
      () => [201, box()],
      async (seen) => {
        const { call, close } = await connect({ computerId: undefined });
        const r = await call('create_computer', { template: 'base', ends_in_hours: 2 });
        // The computer exists, so it is still the selected one.
        const next = await call('get_computer', {});
        await close();
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('vm-1');
        expect(textOf(r)).toContain('END TIME WAS NOT APPLIED');
        expect(textOf(r)).toContain('was not stopped or deleted');
        expect(next.isError).toBeFalsy();
        expect(seen.filter((s) => s.method !== 'GET').map((s) => [s.method, s.path])).toEqual([
          ['POST', '/computers'],
        ]);
        expect(seen.some((s) => s.method === 'GET' && s.path === '/computers/vm-1')).toBe(true);
      },
    );
  });

  it('create_computer without an end time does not ask for one', async () => {
    await platform(
      () => [201, box()],
      async () => {
        const { call, close } = await connect({ computerId: undefined });
        const r = await call('create_computer', { template: 'base' });
        await close();
        expect(r.isError).toBeFalsy();
      },
    );
  });

  it.each([[{ ends_at: ENDS }], [{ ends_in_hours: 1 }]])(
    'update_computer %j: errors when the answer has no ends_at',
    async (fields) => {
      await platform(
        () => [200, box()],
        async (seen) => {
          const { call, close } = await connect();
          const r = await call('update_computer', fields);
          await close();
          expect(r.isError).toBe(true);
          expect(textOf(r)).toContain('end time of computer vm-1 was NOT applied');
          expect(seen.map((s) => [s.method, s.path])).toEqual([['PATCH', '/computers/vm-1']]);
        },
      );
    },
  );

  it.each([
    [{ ends_at: ENDS }, '2026-10-30T09:00:00Z'],
    [{ ends_at: ENDS }, 'not-a-time'],
    [{ ends_in_hours: 3 }, ENDS],
  ])('update_computer %j: errors when the answer carries %s instead', async (fields, other) => {
    await platform(
      () => [200, box({ ends_at: other })],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', fields);
        await close();
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('end time of computer vm-1 was NOT applied');
        expect(seen.map((s) => [s.method, s.path])).toEqual([['PATCH', '/computers/vm-1']]);
      },
    );
  });

  it('create_computer: errors when the answer carries a different end time', async () => {
    await platform(
      () => [201, box({ ends_at: '2026-10-30T09:00:00Z' })],
      async (seen) => {
        const { call, close } = await connect({ computerId: undefined });
        const r = await call('create_computer', { template: 'base', ends_at: ENDS });
        await close();
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('END TIME WAS NOT APPLIED');
        expect(textOf(r)).toContain('vm-1');
        expect(seen.filter((s) => s.method !== 'GET').map((s) => s.method)).toEqual(['POST']);
      },
    );
  });

  it.each([[{ ends_at: null }], [{ ends_in_hours: null }]])(
    'update_computer %j: errors when the answer still has ends_at',
    async (fields) => {
      await platform(
        () => [200, box({ ends_at: ENDS })],
        async (seen) => {
          const { call, close } = await connect();
          const r = await call('update_computer', fields);
          await close();
          expect(r.isError).toBe(true);
          expect(textOf(r)).toContain(`end time of computer vm-1 was NOT cleared`);
          expect(textOf(r)).toContain(ENDS);
          expect(seen.map((s) => [s.method, s.path])).toEqual([['PATCH', '/computers/vm-1']]);
        },
      );
    },
  );
});

describe('endTimeProblem checks the value, not only its presence', () => {
  const t0 = Date.parse('2026-10-29T12:00:00Z');
  const t1 = t0 + 2000;
  // The platform's Date header, read at the answer: the window is
  // [12:00:02 + hours - 60 s - 2 s, 12:00:02 + hours + 60 s].
  const T = { sentAt: t0, answeredAt: t1, durationMs: 2000, serverDate: t1 };
  it.each([
    [{ ends_at: ENDS }, ENDS],
    [{ ends_at: '2026-11-01T18:00:00.900Z' }, ENDS],
    [{ ends_at: '2026-11-01T20:00:00+02:00' }, ENDS],
    [{ ends_at: ENDS }, '2026-11-01T18:00:01Z'],
    [{ ends_in_hours: 2 }, '2026-10-29T14:00:00Z'],
    [{ ends_in_hours: 2 }, '2026-10-29T13:59:00Z'],
    [{ ends_in_hours: 2 }, '2026-10-29T14:01:02Z'],
    [{ ends_in_hours: 0.5 }, '2026-10-29T12:30:01Z'],
    [{ ends_at: null }, undefined],
    [{ ends_in_hours: null }, undefined],
  ])('accepts %j answered with %s', (asked, returned) => {
    expect(endTimeProblem(asked, returned, T)).toBeUndefined();
  });

  it.each([
    [{ ends_at: ENDS }, undefined, 'carries no ends_at'],
    [{ ends_at: ENDS }, '', 'carries no ends_at'],
    [{ ends_at: ENDS }, 'tomorrow', 'not a valid time'],
    [{ ends_at: ENDS }, '2026-11-01', 'not a valid time'],
    [{ ends_at: ENDS }, 1793556000, 'not a valid time'],
    [{ ends_at: ENDS }, '2026-13-45T99:00:00Z', 'not a valid time'],
    // An unchanged earlier end time is not the one asked for.
    [{ ends_at: ENDS }, '2026-10-30T09:00:00Z', 'is not the'],
    [{ ends_at: ENDS }, '2026-11-01T18:00:02Z', 'is not the'],
    [{ ends_in_hours: 2 }, '2026-10-29T13:58:59Z', 'not 2 hours'],
    [{ ends_in_hours: 2 }, '2026-10-29T14:01:03Z', 'not 2 hours'],
    [{ ends_in_hours: 2 }, ENDS, 'not 2 hours'],
    [{ ends_at: null }, ENDS, 'still carries ends_at'],
    [{ ends_in_hours: null }, ENDS, 'still carries ends_at'],
  ])('refuses %j answered with %j', (asked, returned, says) => {
    expect(endTimeProblem(asked, returned, T)).toContain(says);
  });

  it('uses the Date header, not this clock, when there is one', () => {
    // This clock two hours wrong either way changes nothing.
    for (const skew of [-2 * 3_600_000, 2 * 3_600_000]) {
      const skewed = { ...T, sentAt: t0 + skew, answeredAt: t1 + skew };
      expect(endTimeProblem({ ends_in_hours: 2 }, '2026-10-29T14:00:02Z', skewed)).toBeUndefined();
    }
  });

  it('widens this clock by ten minutes either way without a Date header', () => {
    // [12:00:00 + 2 h - 1 s - 10 min, 12:00:02 + 2 h + 60 s + 10 min]
    const noDate = { sentAt: t0, answeredAt: t1, durationMs: 2000 };
    for (const ok of ['2026-10-29T13:49:59Z', '2026-10-29T14:11:02Z'])
      expect(endTimeProblem({ ends_in_hours: 2 }, ok, noDate), ok).toBeUndefined();
    for (const bad of ['2026-10-29T13:49:58Z', '2026-10-29T14:11:03Z'])
      expect(endTimeProblem({ ends_in_hours: 2 }, bad, noDate), bad).toContain('not 2 hours');
  });
});

// A keyed request sent again later is answered from the platform's store: the
// FIRST request's answer, whose relative end time was counted from then. It
// must not read as an end time that was not applied.
describe('a replayed answer to a keyed request', () => {
  const REPLAYED = { 'Idempotent-Replayed': 'true' };
  const KEY = 'end-time-0123456789';
  /** The ends_at a first request two hours ago, for `hours`, was answered with. */
  const earlier = (hours: number) =>
    new Date(Math.floor((Date.now() - 2 * 3_600_000 + hours * 3_600_000) / 1000) * 1000)
      .toISOString()
      .replace('.000Z', 'Z');

  it('create_computer: a delayed same-key replay of ends_in_hours succeeds', async () => {
    await platform(
      () => [201, box({ ends_at: earlier(8) }), REPLAYED],
      async () => {
        const { call, close } = await connect({ computerId: undefined });
        const args = { template: 'base', ends_in_hours: 8, idempotency_key: KEY };
        const r = await call('create_computer', args);
        await close();
        expect(r.isError, textOf(r)).toBeFalsy();
        expect(textOf(r)).toContain(`stops by itself at ${earlier(8)}`);
      },
    );
  });

  it('update_computer: a delayed same-key replay of ends_in_hours succeeds', async () => {
    await platform(
      () => [200, box({ ends_at: earlier(3) }), REPLAYED],
      async () => {
        const { call, close } = await connect();
        const r = await call('update_computer', { ends_in_hours: 3, idempotency_key: KEY });
        await close();
        expect(r.isError, textOf(r)).toBeFalsy();
      },
    );
  });

  it('the same answer without the replay header is still refused', async () => {
    await platform(
      () => [200, box({ ends_at: earlier(3) })],
      async () => {
        const { call, close } = await connect();
        const r = await call('update_computer', { ends_in_hours: 3, idempotency_key: KEY });
        await close();
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('end time of computer vm-1 was NOT applied');
      },
    );
  });

  it('a replay still refuses a relative end time past the upper bound', async () => {
    await platform(
      () => [200, box({ ends_at: earlier(6) }), REPLAYED],
      async () => {
        const { call, close } = await connect();
        const r = await call('update_computer', { ends_in_hours: 3, idempotency_key: KEY });
        await close();
        expect(r.isError).toBe(true);
      },
    );
  });

  it('a replay still checks an absolute ends_at exactly', async () => {
    await platform(
      () => [201, box({ ends_at: '2026-10-30T09:00:00Z' }), REPLAYED],
      async () => {
        const { call, close } = await connect({ computerId: undefined });
        const r = await call('create_computer', {
          template: 'base',
          ends_at: ENDS,
          idempotency_key: KEY,
        });
        await close();
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('END TIME WAS NOT APPLIED');
      },
    );
  });

  it('endTimeProblem drops only the lower bound for a replay', () => {
    const t0 = Date.parse('2026-10-29T12:00:00Z');
    const T = { sentAt: t0, answeredAt: t0 + 2000, durationMs: 2000, serverDate: t0 + 2000 };
    const R = { ...T, replayed: true };
    expect(endTimeProblem({ ends_in_hours: 2 }, '2026-10-29T11:00:00Z', R)).toBe(undefined);
    expect(endTimeProblem({ ends_in_hours: 2 }, '2026-10-29T11:00:00Z', T)).toContain(
      'not 2 hours',
    );
    expect(endTimeProblem({ ends_in_hours: 2 }, '2026-10-29T14:01:03Z', R)).toContain(
      'not 2 hours',
    );
    expect(endTimeProblem({ ends_in_hours: 2 }, 'nope', R)).toContain('not a valid time');
    expect(endTimeProblem({ ends_at: ENDS }, '2026-11-01T18:00:02Z', R)).toContain('is not the');
  });
});

// The platform's Date header is its own now, and a relative end time is
// checked against it: this machine's clock being off must not refuse an end
// time the platform did apply.
describe('a relative end time against the platform clock', () => {
  /** The platform's clock `offset` ms from this one, and its answer for `hours`. */
  const answer = (offset: number, hours: number, extra = 0) => {
    const serverNow = Date.now() + offset;
    const endsAt = new Date(Math.floor((serverNow + hours * 3_600_000 + extra) / 1000) * 1000)
      .toISOString()
      .replace('.000Z', 'Z');
    return { endsAt, date: new Date(serverNow).toUTCString() };
  };

  it.each([
    ['5 s ahead', -5000],
    ['2 minutes behind', 120_000],
  ])('accepts an applied end time with this clock %s', async (_, offset) => {
    for (const tool of ['create_computer', 'update_computer'] as const) {
      await platform(
        () => {
          const { endsAt, date } = answer(offset, 2);
          return [tool === 'create_computer' ? 201 : 200, box({ ends_at: endsAt }), { Date: date }];
        },
        async () => {
          const { call, close } = await connect(
            tool === 'create_computer' ? { computerId: undefined } : {},
          );
          const r = await call(
            tool,
            tool === 'create_computer'
              ? { template: 'base', ends_in_hours: 2 }
              : { ends_in_hours: 2 },
          );
          await close();
          expect(r.isError, `${tool}: ${textOf(r)}`).toBeFalsy();
        },
      );
    }
  });

  it('refuses a clearly wrong end time even with a Date header', async () => {
    await platform(
      () => {
        const { endsAt, date } = answer(120_000, 2, 5 * 60_000);
        return [200, box({ ends_at: endsAt }), { Date: date }];
      },
      async () => {
        const { call, close } = await connect();
        const r = await call('update_computer', { ends_in_hours: 2 });
        await close();
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('end time of computer vm-1 was NOT applied');
      },
    );
  });

  it('accepts this clock 2 minutes behind with no Date header, inside the wider window', async () => {
    await platform(
      () => [200, box({ ends_at: answer(120_000, 2).endsAt })],
      async () => {
        const { call, close } = await connect();
        const r = await call('update_computer', { ends_in_hours: 2 });
        await close();
        expect(r.isError, textOf(r)).toBeFalsy();
      },
    );
  });
});

describe('the summary line', () => {
  it('names the end time only when there is one', () => {
    expect(describeComputer(box({ ends_at: ENDS }))).toContain(`stops by itself at ${ENDS}`);
    expect(describeComputer(box())).not.toContain('stops by itself');
  });
});
