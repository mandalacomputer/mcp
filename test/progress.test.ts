import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_MS, heartbeat } from '../src/poll.js';
import { connect, installFakePlatform } from './harness.js';

// OPL-4579. Four tools can wait for minutes, and said nothing while they did.
//
// The SDK's default request timeout is 60s and only `notifications/progress`
// resets it — `_onprogress` is bound to that schema alone, so a logging
// notification is not a keepalive. A capture on the live platform took 107s and
// was cancelled at 60 while the platform went on copying the disk; the model
// read a transport error rather than any of the sentences OPL-4568 and OPL-4577
// were written to give it.
//
// Pinned here: that each wait opens the channel, that a poll loop keeps it open
// without flooding it, and that the rules the throttle follows are the ones the
// comment claims.

type Beat = { progress: number; total?: number; message?: string };

/** A recorder shaped like the two members `heartbeat` uses. */
const recorder = (token?: string | number) => {
  const beats: Beat[] = [];
  const logs: string[] = [];
  return {
    beats,
    logs,
    extra: {
      _meta: token === undefined ? undefined : { progressToken: token },
      sendNotification: async (n: { params: Beat }) => {
        beats.push(n.params);
      },
    },
    log: {
      sendLoggingMessage: async (m: { level: 'info'; data: string }) => {
        logs.push(m.data);
      },
    },
  };
};

describe('the keepalive itself', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a changed line at once and an unchanged one on the interval', async () => {
    const r = recorder('tok');
    const beat = heartbeat(r.extra, r.log);

    await beat('still copying'); // the first, which opens the channel
    await beat('still copying'); // a repeat, inside the interval — held
    await beat('still copying');
    expect(r.beats).toHaveLength(1);

    // News goes out whatever the interval says. A state change is the whole
    // reason anyone is reading these.
    await beat('landed');
    expect(r.beats).toHaveLength(2);
    expect(r.beats[1].message).toBe('landed');

    // And a repeat goes out once the interval has passed, which is what holds
    // the client's timer open through a wait where nothing changes.
    vi.setSystemTime(Date.now() + HEARTBEAT_MS + 1);
    await beat('landed');
    expect(r.beats).toHaveLength(3);
  });

  it('counts up on every notification, as the SDK asks', async () => {
    const r = recorder('tok');
    const beat = heartbeat(r.extra, r.log);
    for (const line of ['a', 'b', 'c']) await beat(line);
    expect(r.beats.map((b) => b.progress)).toEqual([1, 2, 3]);
  });

  it('sends no total, rather than a zero that renders as a finished bar', async () => {
    const r = recorder('tok');
    await heartbeat(r.extra, r.log)('working');
    expect(r.beats[0].total).toBeUndefined();
  });

  it('still logs for a person when the client minted no token', async () => {
    // The two channels answer different readers: the notification is for the
    // client's timer, the log line is what someone watching a terminal sees.
    const r = recorder(undefined);
    const beat = heartbeat(r.extra, r.log);
    await beat('working');
    expect(r.beats).toHaveLength(0);
    expect(r.logs).toEqual(['working']);
  });

  it('does not let a notification nobody could take end the wait', async () => {
    const beats: string[] = [];
    const beat = heartbeat(
      {
        _meta: { progressToken: 'tok' },
        sendNotification: async () => {
          throw new Error('the client went away');
        },
      },
      {
        sendLoggingMessage: async () => {
          throw new Error('and so did the log');
        },
      },
    );
    await expect(beat('working')).resolves.toBeUndefined();
    expect(beats).toEqual([]);
  });
});

describe('the waits that send it', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  /** Drive one tool with the SDK's own progress mechanism, which mints the token. */
  const beatsOf = async (name: string, args: Record<string, unknown>) => {
    const { client, close } = await connect();
    const seen: Beat[] = [];
    await client.callTool({ name, arguments: args }, undefined, {
      onprogress: (p) => seen.push(p as Beat),
      timeout: 60_000,
    });
    await close();
    return seen;
  };

  it('opens the channel from create_snapshot', async () => {
    const seen = await beatsOf('create_snapshot', { computer_id: 'vm-1', name: 'x' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].message).toContain('Capturing');
  }, 20_000);

  it('opens the channel from delete_snapshot', async () => {
    const seen = await beatsOf('delete_snapshot', { snapshot_id: 'snap-1', confirm: true });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].message).toContain('Deleting');
  }, 20_000);

  it('opens the channel from wait_for_computer', async () => {
    const seen = await beatsOf('wait_for_computer', { computer_id: 'vm-1', timeout_s: 10 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].message).toContain('Waiting for vm-1');
  }, 20_000);

  it('opens the channel from move_computer', async () => {
    const seen = await beatsOf('move_computer', { computer_id: 'vm-1', ram_mb: 26000 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].message).toContain('Moving vm-1');
  }, 20_000);
});

describe('a capture that takes more than one poll', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('keeps reporting while the copy is still running', async () => {
    // The case the whole issue is about: a wait long enough for a client to give
    // up on. Two polls of `capturing` before it lands, so there is a turn in the
    // middle where the only thing holding the request open is this.
    const placeholder = { id: 'snap-7', computer_id: 'vm-1', name: 'x', state: 'capturing' };
    let polls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const body =
        method === 'POST'
          ? placeholder
          : [polls++ < 2 ? placeholder : { ...placeholder, state: 'pending' }];
      return new Response(JSON.stringify(body), {
        status: method === 'POST' ? 202 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const { client, close } = await connect();
    const seen: Beat[] = [];
    await client.callTool(
      { name: 'create_snapshot', arguments: { computer_id: 'vm-1', name: 'x' } },
      undefined,
      { onprogress: (p) => seen.push(p as Beat), timeout: 60_000 },
    );
    await close();

    // The opening beat, and at least one from inside the loop.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.some((b) => (b.message ?? '').includes('still copying'))).toBe(true);
    expect(seen.map((b) => b.progress)).toEqual([...seen.map((_, i) => i + 1)]);
  }, 20_000);
});
