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
    let calls = 0;
    const beat = heartbeat(
      {
        _meta: { progressToken: 'tok' },
        sendNotification: async () => {
          calls += 1;
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
    // And the wait goes ON working afterwards, which is the actual claim — the
    // first spelling asserted an array nothing ever appended to, so it could
    // not have failed (/code-review).
    await expect(beat('still working')).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('throttles the log channel too, not only the notifications', async () => {
    // The throttle used to hang off the notification COUNT, which is stuck at
    // zero for the whole of a wait whose client minted no token — so the one
    // channel still running was the one with no interval on it: a line per
    // two-second poll, ~900 of them across a half-hour capture, which is the
    // flood the design says it avoids (/code-review).
    const r = recorder(undefined);
    const beat = heartbeat(r.extra, r.log);
    for (let i = 0; i < 30; i += 1) await beat('still copying');
    expect(r.logs).toEqual(['still copying']);

    vi.setSystemTime(Date.now() + HEARTBEAT_MS + 1);
    await beat('still copying');
    expect(r.logs).toHaveLength(2);
  });

  it('serializes changed lines with timer-driven notifications', async () => {
    const delivered: number[] = [];
    let releasePeriodic: (() => void) | undefined;
    let active = 0;
    let mostActive = 0;
    const beat = heartbeat(
      {
        _meta: { progressToken: 'tok' },
        sendNotification: async (n) => {
          active += 1;
          mostActive = Math.max(mostActive, active);
          delivered.push(n.params.progress);
          if (n.params.progress === 2) {
            await new Promise<void>((resolve) => {
              releasePeriodic = resolve;
            });
          }
          active -= 1;
        },
      },
      undefined,
      100,
    );

    await beat('first state');
    const timer = vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual([1, 2]);
    const changed = beat('second state');
    expect(mostActive).toBe(1);
    releasePeriodic?.();
    await timer;
    await changed;
    expect(delivered).toEqual([1, 2, 3]);
    expect(mostActive).toBe(1);
    await beat.stop();
  });

  it('stops periodic notifications and clears its timer', async () => {
    const r = recorder('tok');
    const beat = heartbeat(r.extra, r.log);
    await beat('working');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(r.beats).toHaveLength(4);

    await beat.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(r.beats).toHaveLength(4);
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
    // `until: "running"`, because the default asks the guest as well and this
    // fixture's guest answers on the first turn — a wait that finishes at once
    // has nothing to keep alive, and beating anyway would be a notification for
    // a call that never came close to a timeout. The wait that DOES need the
    // channel is the one below.
    const seen = await beatsOf('wait_for_computer', {
      computer_id: 'vm-1',
      until: 'running',
      timeout_s: 10,
    });
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

describe('progress during a slow poll', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = real;
  });

  it('keeps an MCP request alive through Retry-After without retrying early', async () => {
    const placeholder = {
      id: 'snap-slow',
      computer_id: 'vm-1',
      name: 'slow',
      state: 'capturing',
    };
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${String(input)}`);
      if (method === 'POST') return Response.json(placeholder, { status: 202 });
      if (calls.length === 2) {
        return Response.json(
          { error: 'please wait' },
          { status: 429, headers: { 'Retry-After': '120' } },
        );
      }
      return Response.json([{ ...placeholder, state: 'pending' }]);
    }) as typeof globalThis.fetch;

    const { client, close } = await connect();
    vi.useFakeTimers();
    const seen: Beat[] = [];
    const request = client.callTool(
      { name: 'create_snapshot', arguments: { computer_id: 'vm-1', name: 'slow', timeout_s: 300 } },
      undefined,
      {
        onprogress: (p) => seen.push(p as Beat),
        timeout: 60_000,
        resetTimeoutOnProgress: true,
      },
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await request;
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(3);
    expect(seen.map((b) => b.progress)).toEqual(seen.map((_, i) => i + 1));
    const completedBeats = seen.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(seen).toHaveLength(completedBeats);
    expect(vi.getTimerCount()).toBe(0);
    await close();
  });

  it('reports periodically while a fetch is still in flight', async () => {
    const placeholder = {
      id: 'snap-fetch',
      computer_id: 'vm-1',
      name: 'slow fetch',
      state: 'capturing',
    };
    let calls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        return Response.json(placeholder, { status: 202 });
      }
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(Response.json([{ ...placeholder, state: 'pending' }])), 35_000);
      });
    }) as typeof globalThis.fetch;

    const { client, close } = await connect();
    vi.useFakeTimers();
    const seen: Beat[] = [];
    const request = client.callTool(
      {
        name: 'create_snapshot',
        arguments: { computer_id: 'vm-1', name: 'slow fetch', timeout_s: 300 },
      },
      undefined,
      {
        onprogress: (p) => seen.push(p as Beat),
        timeout: 60_000,
        resetTimeoutOnProgress: true,
      },
    );

    await vi.advanceTimersByTimeAsync(30_001);
    expect(calls).toBe(2);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await request;
    expect(result.isError).toBeFalsy();
    expect(seen.map((b) => b.progress)).toEqual(seen.map((_, i) => i + 1));
    const completedBeats = seen.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(seen).toHaveLength(completedBeats);
    expect(vi.getTimerCount()).toBe(0);
    await close();
  });

  it('stops reporting after the caller cancels a slow fetch', async () => {
    const placeholder = {
      id: 'snap-cancel',
      computer_id: 'vm-1',
      name: 'cancel',
      state: 'capturing',
    };
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        return Response.json(placeholder, { status: 202 });
      }
      return new Promise<Response>((_resolve, reject) => {
        const cancelled = () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        };
        if (init?.signal?.aborted) cancelled();
        else init?.signal?.addEventListener('abort', cancelled, { once: true });
      });
    }) as typeof globalThis.fetch;

    const { client, close } = await connect();
    vi.useFakeTimers();
    const controller = new AbortController();
    const seen: Beat[] = [];
    const request = client
      .callTool(
        { name: 'create_snapshot', arguments: { computer_id: 'vm-1', name: 'cancel' } },
        undefined,
        {
          signal: controller.signal,
          onprogress: (p) => seen.push(p as Beat),
          timeout: 60_000,
          resetTimeoutOnProgress: true,
        },
      )
      .then(
        () => 'resolved',
        () => 'cancelled',
      );

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 1);
    expect(seen.length).toBeGreaterThan(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(await request).toBe('cancelled');
    const cancelledBeats = seen.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(seen).toHaveLength(cancelledBeats);
    expect(vi.getTimerCount()).toBe(0);
    await close();
  });
});

describe('a guest that has not come up yet', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('reports once per poll while the guest boots, not twice', async () => {
    // The commonest long wait, and the one that got the rate wrong. The status
    // read and the guest probe each used to beat, with DIFFERENT lines — so
    // every frame read as news, the interval never applied, and the steady
    // state was two notifications per two-second poll (/code-review).
    let probes = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const ok = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.pathname.endsWith('/exec')) {
        // The platform's own answer for a guest agent that is not up yet.
        probes += 1;
        if (probes <= 3) return ok({ error: 'the guest agent is not answering yet' }, 409);
        return ok({ ok: true });
      }
      return ok({ id: 'vm-1', name: 'desk', status: 'running', resolution: '1280x800x24' });
    }) as typeof globalThis.fetch;

    const { client, close } = await connect();
    const seen: Beat[] = [];
    await client.callTool(
      { name: 'wait_for_computer', arguments: { computer_id: 'vm-1', timeout_s: 30 } },
      undefined,
      { onprogress: (p) => seen.push(p as Beat), timeout: 60_000 },
    );
    await close();

    // Three failed probes over three polls. One line each at most, and since
    // the line does not change across them the interval holds all but the
    // first: what must never happen is the six that two differing beats per
    // turn produced.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(3);
    // The line beat in FRONT of the probe, which the 409 branch then repeats so
    // the throttle holds it. It is the beat that has to survive: the probe is
    // the longest call in the loop, and a stall there is exactly when the
    // client needs to have heard something.
    expect(seen[0].message).toContain('asking the guest');
    expect(seen.map((b) => b.progress)).toEqual(seen.map((_, i) => i + 1));
  }, 20_000);

  it('says what actually refused, rather than blaming the guest for a 503', async () => {
    // A 409 IS the guest not being up — that is the probe working. A 503 is a
    // hypervisor nobody can reach, and saying "the guest is not answering" over
    // it tells the person watching the log the one thing this channel exists to
    // get right (/code-review).
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const ok = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.pathname.endsWith('/exec')) return ok({ error: 'no hypervisor answered' }, 503);
      return ok({ id: 'vm-1', name: 'desk', status: 'running', resolution: '1280x800x24' });
    }) as typeof globalThis.fetch;

    const { client, close } = await connect();
    const seen: Beat[] = [];
    await client.callTool(
      { name: 'wait_for_computer', arguments: { computer_id: 'vm-1', timeout_s: 6 } },
      undefined,
      { onprogress: (p) => seen.push(p as Beat), timeout: 60_000 },
    );
    await close();

    expect(seen.some((b) => (b.message ?? '').includes('the platform could not be asked'))).toBe(
      true,
    );
    expect(seen.some((b) => (b.message ?? '').includes('guest is not answering'))).toBe(false);
  }, 20_000);

  it('names the hypervisor in the give-up sentence, not just in the beats', async () => {
    // The contradiction the other way round: the progress channel reported the
    // 503 for the whole window while the refusal said only "was last seen
    // running" and named nothing, because the probe's transient branch never
    // set `blocked` — not before this work and not after the first version of
    // it (/code-review). A hypervisor unreachable for the whole wait is the
    // single most useful thing the give-up message can carry.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const ok = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.pathname.endsWith('/exec')) return ok({ error: 'no hypervisor answered' }, 503);
      return ok({ id: 'vm-1', name: 'desk', status: 'running', resolution: '1280x800x24' });
    }) as typeof globalThis.fetch;

    const { call, close } = await connect();
    const res = await call('wait_for_computer', { computer_id: 'vm-1', timeout_s: 6 });
    await close();

    const text = res.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    expect(res.isError).toBe(true);
    expect(text).toContain('the platform could not be asked');
    expect(text).toContain('no hypervisor answered');
    expect(text).not.toMatch(/was last seen running\. Nothing was changed/);
  }, 20_000);
});
