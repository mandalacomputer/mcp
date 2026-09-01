import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';
import { EventHub } from '../src/events.js';
import { BASE, connect, fakeEvents, installFakePlatform } from './harness.js';

/**
 * What a long-lived subscription means to a model (OPL-3926).
 *
 * The decision these tests hold in place is that the SOCKET lives on this side
 * and the model holds nothing but a cursor. Everything below is a consequence
 * of that and would be a different answer under the alternative — a `gap` the
 * model has to interpret, a wait that hangs on an event that already happened,
 * or an event that arrived between two turns and was never handed to anybody.
 */

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** The JSON half of a `said` result. */
function dataOf(res: CallToolResult): Record<string, unknown> {
  const at = textOf(res).indexOf('\n\n');
  if (at < 0) throw new Error(`no data in result: ${textOf(res)}`);
  return JSON.parse(textOf(res).slice(at + 2));
}

const eventsOf = (res: CallToolResult) => (dataOf(res).events ?? []) as Record<string, unknown>[];

/** One event, as the platform writes them. */
const frame = (
  type: string,
  data: Record<string, unknown>,
  cursor: string,
  source = 'guest',
): Record<string, unknown> => ({
  type,
  at: '2026-08-31T22:00:00.000Z',
  computer: 'vm-1',
  seq: Number(cursor.replace(/\D/g, '')) || 1,
  cursor,
  source,
  data,
});

/** Spin the event loop until a condition holds, or fail saying it never did. */
async function until(what: string, cond: () => boolean, ms = 2_000): Promise<void> {
  const stop = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A server whose event socket this test drives, attached and ready to be fed. */
async function attach(hello: Record<string, unknown> = {}) {
  const ev = fakeEvents(hello);
  const session = await connect({ webSocket: ev.factory });
  // The first call is what opens the socket. Everything after it is about a
  // stream that is already there, which is the state this file is about.
  const first = await session.call('poll_events');
  return { ...session, ev, first };
}

describe('the event stream, held open between turns', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('hands over what happened while the model was doing something else', async () => {
    const { call, close, ev } = await attach({ ready: false });
    // Between two tool calls there is nobody in a loop and no socket in the
    // model's hands. This is the whole claim: the events still arrive.
    ev.last().send(frame('window.opened', { id: '0x1', class: 'Firefox' }, 'cur-1'));
    ev.last().send(frame('window.focused', { id: '0x1', class: 'Firefox' }, 'cur-2'));

    const res = await call('poll_events');
    expect(res.isError).toBeFalsy();
    expect(eventsOf(res).map((e) => e.type)).toEqual(['window.opened', 'window.focused']);
    expect(dataOf(res).cursor).toBe('cur-2');
    await close();
  });

  it('hands each event over once', async () => {
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    expect(eventsOf(await call('poll_events'))).toHaveLength(1);
    // A second read is not a second delivery. Without a position kept on this
    // side, every poll would re-report the whole buffer and a model counting
    // windows would count each one once per turn.
    const again = await call('poll_events');
    expect(eventsOf(again)).toHaveLength(0);
    expect(textOf(again)).toContain('Nothing new');
    await close();
  });

  it('says nothing new rather than nothing is listening', async () => {
    // The distinction the whole design turns on: an empty answer here is a
    // statement about the computer, not about this server having stopped
    // watching. A model that reads it as the latter goes back to screenshots.
    const { call, close } = await attach({ ready: false });
    const res = await call('poll_events');
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('The stream is open and buffering');
    await close();
  });

  it('resumes a read from a cursor the model kept', async () => {
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    ev.last().send(frame('window.closed', { id: '0x1' }, 'cur-2'));
    await call('poll_events');
    const res = await call('poll_events', { since: 'cur-1' });
    expect(eventsOf(res).map((e) => e.cursor)).toEqual(['cur-2']);
    await close();
  });

  it('returns the oldest limit and keeps the rest for the next call', async () => {
    const { call, close, ev } = await attach({ ready: false });
    for (let i = 1; i <= 5; i++)
      ev.last().send(frame('window.opened', { id: `0x${i}` }, `cur-${i}`));

    const first = await call('poll_events', { limit: 2 });
    expect(eventsOf(first).map((e) => e.cursor)).toEqual(['cur-1', 'cur-2']);
    expect(dataOf(first).more_waiting).toBe(3);
    // Nothing is dropped by a limit: the position advances only over what was
    // actually returned, which is what makes the default a safe one.
    const rest = await call('poll_events');
    expect(eventsOf(rest).map((e) => e.cursor)).toEqual(['cur-3', 'cur-4', 'cur-5']);
    await close();
  });
});

describe('waiting for one event', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('ends on an event that arrives during the wait', async () => {
    const { call, close, ev } = await attach({ ready: false });
    const waiting = call('wait_for_event', { types: ['process.exited'], timeout_s: 5 });
    await until('the wait to be parked', () => true);
    ev.last().send(frame('process.exited', { pid: 4242, exit_code: 0 }, 'cur-1', 'daemon'));

    const res = await waiting;
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('process.exited (pid 4242 exited 0)');
    expect(eventsOf(res)).toHaveLength(1);
    await close();
  });

  it('ends on an event that already happened', async () => {
    // The failure this prevents: a model that runs a command, takes a
    // screenshot, and only then waits. The exit arrived two turns ago, and a
    // wait that only ever looked forward would hang until its timeout on
    // something that had already happened.
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send(frame('process.exited', { pid: 4242, exit_code: 3 }, 'cur-1', 'daemon'));
    const res = await call('wait_for_event', { types: ['process.exited'], timeout_s: 5 });
    expect(eventsOf(res)).toHaveLength(1);
    await close();
  });

  it('returns what came before the match, in order', async () => {
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    ev.last().send(frame('clipboard.changed', { selection: 'clipboard' }, 'cur-2'));
    ev.last().send(frame('process.exited', { pid: 7, exit_code: 0 }, 'cur-3', 'daemon'));

    const res = await call('wait_for_event', { types: ['process.exited'], timeout_s: 5 });
    expect(eventsOf(res).map((e) => e.type)).toEqual([
      'window.opened',
      'clipboard.changed',
      'process.exited',
    ]);
    expect(textOf(res)).toContain('and 2 before it');
    await close();
  });

  it('waits for the pid it was given rather than the first exit it sees', async () => {
    const { call, close, ev } = await attach({ ready: false });
    const waiting = call('wait_for_event', { types: ['process.exited'], pid: 99, timeout_s: 5 });
    ev.last().send(frame('process.exited', { pid: 4242, exit_code: 0 }, 'cur-1', 'daemon'));
    ev.last().send(frame('process.exited', { pid: 99, exit_code: 7 }, 'cur-2', 'daemon'));

    const res = await waiting;
    const matched = eventsOf(res)[eventsOf(res).length - 1];
    expect((matched.data as { pid: number }).pid).toBe(99);
    // The other one is not lost — it is in the same answer, ahead of the match.
    expect(eventsOf(res)).toHaveLength(2);
    await close();
  });

  it('leaves a pid filter out of the types it is not about', async () => {
    // One argument must not silently disable another: a wait for a window OR a
    // process exit, with a pid, still ends on the window.
    const { call, close, ev } = await attach({ ready: false });
    const waiting = call('wait_for_event', {
      types: ['window.opened', 'process.exited'],
      pid: 99,
      timeout_s: 5,
    });
    ev.last().send(frame('window.opened', { id: '0x1', class: 'Firefox' }, 'cur-1'));
    expect(textOf(await waiting)).toContain('window.opened');
    await close();
  });

  it('answers a timeout without calling it a failure', async () => {
    const { call, close } = await attach({ ready: false });
    const res = await call('wait_for_event', { types: ['process.exited'], timeout_s: 1 });
    // NOT an error. A timeout here means nothing happened in the last second,
    // which is an answer — and one that arrives with the cursor that makes
    // asking again free. Reported as a failure it would teach a model to stop
    // asking, which is the screenshot loop this tool exists to end.
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('nothing was missed');
    expect(dataOf(res).cursor).toBe('cur-0');
    await close();
  });

  it('names the events it handed over when the wait itself timed out', async () => {
    // The failure mode this prevents: the read on the timeout path is a full
    // drain, so unmatched events are delivered — and the sentence said "nothing
    // happened" over a payload holding three of them. A model reads the prose
    // before the JSON, and this server's whole promise is that it was listening.
    const { call, close, ev } = await attach({ ready: false });
    const waiting = call('wait_for_event', { types: ['process.exited'], timeout_s: 1 });
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    ev.last().send(frame('clipboard.changed', { selection: 'clipboard' }, 'cur-2'));

    const res = await waiting;
    expect(res.isError).toBeFalsy();
    expect(eventsOf(res)).toHaveLength(2);
    expect(textOf(res)).toContain('2 other events did happen');
    await close();
  });

  it('takes a pid on its own as meaning that command’s exit', async () => {
    // The argument's own description reads as "wait for this exec", and without
    // an implied type the filter says "anything that is not a process.exited
    // passes" — so the wait ended on the next clipboard change instead.
    const { call, close, ev } = await attach({ ready: false });
    const waiting = call('wait_for_event', { pid: 99, timeout_s: 5 });
    ev.last().send(frame('clipboard.changed', { selection: 'clipboard' }, 'cur-1'));
    ev.last().send(frame('process.exited', { pid: 4242, exit_code: 0 }, 'cur-2', 'daemon'));
    ev.last().send(frame('process.exited', { pid: 99, exit_code: 5 }, 'cur-3', 'daemon'));

    const res = await waiting;
    const last = eventsOf(res)[eventsOf(res).length - 1];
    expect((last.data as { pid: number }).pid).toBe(99);
    await close();
  });

  it('refuses at once for something this computer cannot emit', async () => {
    const { call, close } = await attach({ ready: false, events: ['computer.started'] });
    const started = Date.now();
    const res = await call('wait_for_event', { types: ['window.opened'], timeout_s: 30 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('cannot emit window.opened');
    expect(textOf(res)).toContain('computer.started');
    // The point of the refusal is that it does not cost the timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
    await close();
  });

  it('waits for a type the opening frame does advertise', async () => {
    const { call, close } = await attach({ ready: false, events: ['window.opened'] });
    const res = await call('wait_for_event', { types: ['window.opened'], timeout_s: 1 });
    expect(res.isError).toBeFalsy();
    await close();
  });
});

describe('a desktop that came up before anybody was listening', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('answers a wait for computer.ready that could never arrive', async () => {
    // `computer.ready` is announced once per desktop SESSION. Attach to a
    // machine that has been up for an hour and the event has happened and will
    // not happen again — so a wait over the raw socket waits forever. The
    // opening frame says which it is, and that answer arrives in the shape the
    // model is already reading.
    // No poll first: the wait itself is what opens the socket, which is the
    // shape of the call a model actually makes after create_computer.
    const ev = fakeEvents({ ready: true });
    const { call, close } = await connect({ webSocket: ev.factory });
    const res = await call('wait_for_event', { types: ['computer.ready'], timeout_s: 2 });
    expect(res.isError).toBeFalsy();
    const ready = eventsOf(res).find((e) => e.type === 'computer.ready');
    expect(ready?.synthesized).toBe(true);
    expect(textOf(res)).toContain('synthesized');
    await close();
  });

  it('does not synthesize a second one for an ordinary reconnect', async () => {
    const { call, close, ev } = await attach({ ready: true });
    await call('poll_events');
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    await call('poll_events');

    ev.last().close();
    await until('a reconnect', () => ev.sockets.length === 2);
    // It resumed, so the platform either already sent the readiness or is about
    // to out of the backlog. Inventing one here would be a desktop session
    // counted twice.
    expect(ev.last().since).toBe('cur-1');
    const res = await call('poll_events');
    expect(eventsOf(res)).toHaveLength(0);
    await close();
  });

  it('does synthesize one again when the resume gapped', async () => {
    // The backlog the readiness would have been in is what the gap says is
    // gone, and a display manager restarted inside a running computer makes a
    // NEW desktop session — so suppressing this is how a wait ends up hanging
    // on a desktop nobody was told about (the TypeScript SDK's OPL-4206).
    const { call, close, ev } = await attach({ ready: true });
    await call('poll_events');
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    await call('poll_events');

    ev.last().close();
    await until('a reconnect', () => ev.sockets.length === 2);
    ev.last().send({ type: 'gap', cursor: 'cur-9', detail: 'too far back', data: {} });

    const res = await call('poll_events');
    expect(eventsOf(res).map((e) => e.type)).toEqual(['computer.ready']);
    // Stamped with the GAP's position, not the opening frame's. A resumed
    // connection's hello carries the cursor it attached at, which here is older
    // than the window.opened already handed over — and a synthesized event
    // carrying it would walk the delivered position backwards, so the next
    // `since` re-delivered what had already been read, with no gap to say so.
    expect(eventsOf(res)[0].cursor).toBe('cur-9');
    expect(dataOf(res).cursor).toBe('cur-9');
    await close();
  });
});

describe('a hole in the history', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('never hands the model a gap frame to interpret', async () => {
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send({
      type: 'gap',
      cursor: 'cur-9',
      detail: 'the oldest event this host still holds is newer than that cursor',
      data: { oldest_cursor: 'cur-5' },
    });
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-10'));

    const res = await call('poll_events');
    // The frame is a statement about the STREAM, and the model has no
    // documented procedure for one — the reference tells a client to reconcile
    // with a listing, and nothing can tell a model that mid-stream. Handed the
    // frame it would invent a recovery procedure.
    expect(eventsOf(res).map((e) => e.type)).toEqual(['window.opened']);
    const lost = dataOf(res).lost as { events: null; reason: string };
    expect(lost.events).toBeNull();
    expect(lost.reason).toContain('could not replay');
    await close();
  });

  it('does not deny the gap when nothing survived it', async () => {
    // The one case where "this is an answer rather than a gap" is exactly
    // wrong: a hole with no surviving events leaves an empty batch beside a
    // real loss, and the sentence has to agree with the JSON beside it.
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send({ type: 'gap', cursor: 'cur-9', detail: 'too far back', data: {} });
    const res = await call('poll_events');
    expect(eventsOf(res)).toHaveLength(0);
    expect(textOf(res)).toContain('hole in the history');
    expect(textOf(res)).not.toContain('rather than a gap');
    await close();
  });

  it('answers the gap with the state it would have sent the model to fetch', async () => {
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send({ type: 'gap', cursor: 'cur-9', detail: 'too far back', data: {} });
    const res = await call('poll_events');

    // Self-healed, not delegated. What the missing events would have reported
    // is what is on the desktop and what state the machine is in, so both come
    // back with the answer rather than as two more calls the model has to
    // work out for itself.
    expect(dataOf(res).windows_now).toBeTruthy();
    expect(dataOf(res).computer_now).toBeTruthy();
    const routes = platform.calls.map((c) => `${c.method} ${c.path}`);
    expect(routes).toContain('GET /computers/vm-1/windows');
    await close();
  });

  it('reports a hole this server made, and counts it exactly', async () => {
    const { call, close, ev } = await attach({ ready: false });
    // Past the ring, without a read in between. The platform did not lose
    // these; this server did, and saying so is the same duty.
    for (let i = 1; i <= 1100; i++) {
      ev.last().send(frame('window.opened', { id: `0x${i}` }, `cur-${i}`));
    }
    const res = await call('poll_events', { limit: 500 });
    const lost = dataOf(res).lost as { events: number; reason: string };
    expect(lost.events).toBe(76);
    expect(lost.reason).toContain('went unread');
    await close();
  });

  it('does not re-deliver read events for a cursor it cannot place', async () => {
    // A delivered event stays in the ring until the cap evicts it, so resuming
    // an unplaceable cursor at the OLDEST thing buffered re-sent events the
    // model already had — and attached a loss note saying they "were not kept",
    // which was false about exactly the events being re-sent. The right place
    // is the unread frontier.
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    expect(eventsOf(await call('poll_events'))).toHaveLength(1);

    const res = await call('poll_events', { since: 'cur-from-another-session' });
    expect(eventsOf(res)).toHaveLength(0);
    expect((dataOf(res).lost as { events: null }).events).toBeNull();
    await close();
  });

  it('says so when a cursor is older than anything it still holds', async () => {
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    const res = await call('poll_events', { since: 'cur-from-another-session' });
    const lost = dataOf(res).lost as { events: null; reason: string };
    expect(lost.events).toBeNull();
    expect(lost.reason).toContain('not a place this session can find');
    // The event itself is unread, so it comes back; what must not come back is
    // an event already handed over — see the test below.
    expect(eventsOf(res)).toHaveLength(1);
    expect(dataOf(res).windows_now).toBeTruthy();
    await close();
  });
});

describe('the socket underneath', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('re-reads the computer for a fresh URL on every reconnect', async () => {
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    await call('poll_events');
    const before = platform.calls.filter((c) => c.path === '/computers/vm-1').length;

    ev.last().close();
    await until('a reconnect', () => ev.sockets.length === 2);
    // The credential in `events_url` is rotated by a restart, and a restart is
    // one of the ordinary reasons the socket dropped. Reusing the URL that was
    // open a second ago is a 401 that reaches a WebSocket client as nothing at
    // all — no status, no body, just a close.
    expect(platform.calls.filter((c) => c.path === '/computers/vm-1').length).toBeGreaterThan(
      before,
    );
    expect(ev.last().since).toBe('cur-1');
    await close();
  });

  it('keeps its own place, not the model’s', async () => {
    // The subscription resumes from the last event RECEIVED; the model reads
    // from wherever it had got to. A reconnect that asked for the model's
    // position would re-request everything already in the buffer.
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    ev.last().send(frame('window.opened', { id: '0x2' }, 'cur-2'));
    ev.last().close();
    await until('a reconnect', () => ev.sockets.length === 2);
    expect(ev.last().since).toBe('cur-2');

    // And nothing buffered was lost by the reconnect.
    const res = await call('poll_events');
    expect(eventsOf(res)).toHaveLength(2);
    await close();
  });

  it('takes a capabilities frame as replacing what hello advertised', async () => {
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send({
      type: 'capabilities',
      events: ['computer.started', 'computer.stopped'],
      detail: 'this guest has no window watcher',
    });
    const res = await call('wait_for_event', { types: ['window.opened'], timeout_s: 30 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('cannot emit window.opened');
    // And the frame itself is not an event about the computer.
    await close();
  });

  it('refuses a suspended computer with the one thing that fixes it', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.host !== new URL(BASE).host) return real(input as never);
      return new Response(JSON.stringify({ id: 'vm-1', status: 'suspended', os: 'linux' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const ev = fakeEvents();
      const { call, close } = await connect({ webSocket: ev.factory });
      const res = await call('poll_events');
      expect(res.isError).toBe(true);
      // Listening is not using, so a computer nobody touches suspends
      // underneath its own stream — and this is the one part of the API that
      // does not resume one for you. A websocket refusal carries neither the
      // 409 nor the `resume_required` that says so, which is why this is read
      // off the computer rather than inferred from a socket that just closed.
      expect(textOf(res)).toContain('start_computer');
      expect(ev.sockets).toHaveLength(0);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('waits through a computer that is still starting', async () => {
    // Settling on everything that is not `running` broke the flow the README
    // advertises: create_computer, then wait_for_event("computer.ready"). That
    // meets `starting`, which is the ordinary weather of a machine coming up
    // and is precisely what the caller is waiting through — not a refusal.
    const real = globalThis.fetch;
    let status = 'starting';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.host !== new URL(BASE).host) return real(input as never);
      return new Response(
        JSON.stringify({
          id: 'vm-1',
          status,
          os: 'linux',
          vnc: { events_url: 'wss://app.test/api/v1/computers/vm-1/events?token=t' },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const ev = fakeEvents({ ready: true });
      const hub = new EventHub(new Api('com_test', BASE), ev.factory);
      try {
        const sub = hub.open('vm-1');
        // It backs off rather than stopping, and connects once it is running.
        await new Promise((r) => setTimeout(r, 100));
        expect(sub.state.status).not.toBe('stopped');
        status = 'running';
        await until('a connection once it is running', () => ev.sockets.length === 1, 5_000);
      } finally {
        hub.closeAll();
      }
    } finally {
      globalThis.fetch = real;
    }
  });

  it('ignores frames from a connection it has already given up on', async () => {
    // `finish()` does not stop a socket from delivering: a close is a handshake
    // rather than an instant, and a connect-timeout finish leaves the socket
    // open by definition. Frames from the abandoned connection would otherwise
    // land in the same subscription as the live one's.
    const ev = fakeEvents({ ready: false });
    const hub = new EventHub(new Api('com_test', BASE), ev.factory);
    try {
      const sub = hub.open('vm-1');
      await until('the first connection', () => ev.sockets.length === 1);
      const abandoned = ev.sockets[0];
      abandoned.close();
      await until('a reconnect', () => ev.sockets.length === 2, 5_000);

      abandoned.send(frame('window.opened', { id: '0xdead' }, 'cur-ghost'));
      expect(sub.read({ limit: 100 }).events).toHaveLength(0);
    } finally {
      hub.closeAll();
    }
  });

  it('refuses a Windows guest by naming what it does not have', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.host !== new URL(BASE).host) return real(input as never);
      return new Response(
        JSON.stringify({ id: 'vm-1', status: 'running', os: 'windows', vnc: { url: 'wss://x' } }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const ev = fakeEvents();
      const { call, close } = await connect({ webSocket: ev.factory });
      const res = await call('wait_for_event', { timeout_s: 1 });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Windows');
      expect(ev.sockets).toHaveLength(0);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('drops the stream when the computer is deleted', async () => {
    const { call, close, ev } = await attach({ ready: false });
    ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
    await call('delete_computer', { computer_id: 'vm-1', confirm: true });
    // A destroyed computer has no more events, and its buffer is the history of
    // a machine that no longer exists.
    await until('the socket to be closed', () => ev.last().closed);
    await close();
  });

  it('opens a fresh stream on the next call after a stop', async () => {
    // The refusal tells the model to fix the cause and call again, and this is
    // what makes that sentence true. A stopped subscription left in place would
    // answer "suspended" for the whole idle window after start_computer had
    // already fixed it — and a model told to do something, doing it, and being
    // told the same thing again stops believing the tool.
    const real = globalThis.fetch;
    let status = 'suspended';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.host !== new URL(BASE).host) return real(input as never);
      return new Response(
        JSON.stringify({
          id: 'vm-1',
          status,
          os: 'linux',
          vnc: { events_url: 'wss://app.test/api/v1/computers/vm-1/events?token=t' },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const ev = fakeEvents({ ready: false });
      const { call, close } = await connect({ webSocket: ev.factory });
      expect((await call('poll_events')).isError).toBe(true);
      status = 'running';
      const res = await call('poll_events');
      expect(res.isError).toBeFalsy();
      expect(ev.sockets).toHaveLength(1);
      await close();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('resumes from where a reaped stream had got to', async () => {
    // Five minutes without a tool call is an ordinary thing for a model to do —
    // a long exec, a detour onto another computer. A subscription that reopened
    // at the head afterwards would lose exactly the process.exited the detour
    // was waiting on, so the cursor outlives the socket.
    const ev = fakeEvents({ ready: false });
    const hub = new EventHub(new Api('com_test', BASE), ev.factory);
    try {
      const sub = hub.open('vm-1');
      await until('the first connection', () => ev.sockets.length === 1);
      ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
      sub.read({ limit: 100 });

      hub.drop('vm-1', 'idle', true);
      hub.open('vm-1');
      await until('the second connection', () => ev.sockets.length === 2);
      expect(ev.last().since).toBe('cur-1');
    } finally {
      hub.closeAll();
    }
  });

  it('resumes from what the MODEL was handed, not from what the socket received', async () => {
    // The two are the same only when the model is caught up, and the case where
    // they differ is the case the memory exists for: events arrive, the model is
    // busy on another computer, the sweep reaps the subscription and the ring
    // goes with it. Resuming from the last event RECEIVED would ask the platform
    // to replay from after the unread ones — losing exactly what was being kept,
    // and losing it silently, because a `since` the platform can honour produces
    // no gap to report.
    const ev = fakeEvents({ ready: false });
    const hub = new EventHub(new Api('com_test', BASE), ev.factory);
    try {
      const sub = hub.open('vm-1');
      await until('the first connection', () => ev.sockets.length === 1);
      ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));
      sub.read({ limit: 100 });
      // Never read: this is the process.exited the detour was waiting on.
      ev.last().send(frame('process.exited', { pid: 9, exit_code: 0 }, 'cur-2', 'daemon'));

      hub.drop('vm-1', 'idle', true);
      hub.open('vm-1');
      await until('the second connection', () => ev.sockets.length === 2);
      expect(ev.last().since).toBe('cur-1');
    } finally {
      hub.closeAll();
    }
  });

  it('replays the whole buffer when the model was handed nothing at all', async () => {
    const ev = fakeEvents({ ready: false });
    const hub = new EventHub(new Api('com_test', BASE), ev.factory);
    try {
      hub.open('vm-1');
      await until('the first connection', () => ev.sockets.length === 1);
      ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));

      hub.drop('vm-1', 'idle', true);
      hub.open('vm-1');
      await until('the second connection', () => ev.sockets.length === 2);
      // Where this stream BEGAN, which is the opening frame's own cursor.
      expect(ev.last().since).toBe('cur-0');
    } finally {
      hub.closeAll();
    }
  });

  it('opens no socket for a subscription closed while it was reading the URL', async () => {
    // `#url()` is a network round trip, and a close can land inside it — a
    // session ending, a computer deleted, an idle drop. A socket opened after
    // that abort is one nothing holds and nothing will ever close: close() has
    // already run, and an abort listener added to a signal that has ALREADY
    // fired never fires. It would sit open and buffering for the life of the
    // process.
    const real = globalThis.fetch;
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.host !== new URL(BASE).host) return real(input as never);
      await held;
      return new Response(
        JSON.stringify({
          id: 'vm-1',
          status: 'running',
          os: 'linux',
          vnc: { events_url: 'wss://app.test/api/v1/computers/vm-1/events?token=t' },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const ev = fakeEvents({ ready: false });
      const hub = new EventHub(new Api('com_test', BASE), ev.factory);
      hub.open('vm-1');
      // Closed while the read is still in flight, then the read completes.
      hub.closeAll();
      release?.();
      await new Promise((r) => setTimeout(r, 50));
      expect(ev.sockets).toHaveLength(0);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('forgets the place when there is no stream left to resume', async () => {
    // A deleted computer's cursor names a position in a stream that no longer
    // exists, and asking the platform to resume from it would be asking about a
    // machine that is gone.
    const ev = fakeEvents({ ready: false });
    const hub = new EventHub(new Api('com_test', BASE), ev.factory);
    try {
      hub.open('vm-1');
      await until('the first connection', () => ev.sockets.length === 1);
      ev.last().send(frame('window.opened', { id: '0x1' }, 'cur-1'));

      hub.drop('vm-1', 'deleted');
      hub.open('vm-1');
      await until('the second connection', () => ev.sockets.length === 2);
      expect(ev.last().since).toBeNull();
    } finally {
      hub.closeAll();
    }
  });

  it('closes every socket when the session ends', async () => {
    const { close, ev } = await attach({ ready: false });
    await close();
    // Nothing in a tool can close these, because they outlive every tool call
    // by design. The session is the lifetime they actually have — without this
    // an HTTP transport whose client went away leaves one websocket per
    // computer open and reconnecting for as long as the process lives.
    await until('the socket to be closed', () => ev.last().closed);
  });
});
