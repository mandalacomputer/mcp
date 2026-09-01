import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';
import { EventHub } from '../src/events.js';
import { BASE, connect, FakeSocket, fakeEvents, HELLO, installFakePlatform } from './harness.js';

/**
 * What a model does with a file watch (OPL-4221).
 *
 * `file.changed` is unlike every other event on this stream in one way that
 * decides the shape of the tool: it never arrives unasked. A tree has to be
 * nominated on the CONNECTION, so a watch is a stream option rather than a type
 * to add to a union — and the three things that follow from that are what these
 * tests hold in place.
 *
 * A nomination is not a watch. `hello` accepting one says nothing about whether
 * the guest is watching yet, and inotify reports changes rather than state, so
 * anything that happens before a tree arms is never reported. A tool that
 * returned inside that window would tell a model nothing changed about a
 * stretch of time during which nobody was looking, which is the one sentence a
 * server whose whole promise is that it was listening must not say.
 *
 * `lost` is not an error. It says the picture of the tree is incomplete and the
 * watch is still on, so the answer is to re-read the directory — and a tool
 * that reported it as a failure would teach a model to give up on a watch that
 * is working.
 *
 * And the guest half is TWO capabilities. `file.changed` needs the terminal
 * channel and nothing an image can be missing, so it is offered on computers
 * that emit no window events at all.
 */

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

function dataOf(res: CallToolResult): Record<string, unknown> {
  const at = textOf(res).indexOf('\n\n');
  if (at < 0) throw new Error(`no data in result: ${textOf(res)}`);
  return JSON.parse(textOf(res).slice(at + 2));
}

/** One event, as the platform writes them. */
const frame = (
  data: Record<string, unknown>,
  cursor: string,
  type = 'file.changed',
): Record<string, unknown> => ({
  type,
  at: '2026-09-01T09:00:00.000Z',
  computer: 'vm-1',
  seq: Number(cursor.replace(/\D/g, '')) || 1,
  cursor,
  source: 'guest',
  data,
});

async function until(what: string, cond: () => boolean, ms = 3_000): Promise<void> {
  const stop = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A server with an open stream on vm-1, ready to be nominated at. */
async function attach(hello: Record<string, unknown> = {}, armed = true) {
  const ev = fakeEvents(hello, armed);
  const session = await connect({ webSocket: ev.factory });
  // Opens the socket, so everything after this is about a stream that is
  // already there — which is the state a nomination actually arrives in.
  await session.call('poll_events');
  return { ...session, ev };
}

/** The connection carrying a nomination, once it has greeted. */
async function nominated(ev: ReturnType<typeof fakeEvents>, trees = 1) {
  await until(
    `a greeted connection watching ${trees} tree(s)`,
    () => ev.last().greeted && ev.last().watches.length === trees,
  );
  return ev.last();
}

/**
 * A socket factory whose behaviour the test moves.
 *
 * `failWatched` is what a host does to a nomination it will not take: a 400 for
 * a path it will not honour, a 409 past the 32 trees a computer will watch —
 * both on the UPGRADE, where neither status nor body reaches a websocket
 * client. `failAll` is a host that is simply down, which from here looks
 * exactly the same, and telling the two apart without being told either is the
 * whole difficulty. `greet` off is a handshake that never completes.
 */
function drivenEvents() {
  const sockets: FakeSocket[] = [];
  const state = { greet: true, failWatched: false, failAll: false };
  const factory = (url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    setTimeout(() => {
      if (socket.closed) return;
      if (state.failAll || (state.failWatched && socket.watches.length)) {
        socket.fail();
        return;
      }
      if (!state.greet) return;
      socket.open();
      const watches = socket.watches;
      socket.send({
        ...HELLO,
        ...(watches.length ? { watching: watches.map((path) => ({ path, armed: true })) } : {}),
      });
      socket.greeted = true;
    }, 0);
    return socket;
  };
  return { factory, sockets, state, last: () => sockets[sockets.length - 1] };
}

/** A factory that greets only when the test says so, so a nomination can beat a hello. */
function greetsOnDemand() {
  const sockets: FakeSocket[] = [];
  const factory = (url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  const greet = (socket: FakeSocket) => {
    socket.open();
    const watches = socket.watches;
    socket.send({
      ...HELLO,
      ...(watches.length ? { watching: watches.map((path) => ({ path, armed: true })) } : {}),
    });
    socket.greeted = true;
  };
  return { factory, sockets, greet, last: () => sockets[sockets.length - 1] };
}

describe('a tree the model nominates', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('reopens the stream with the tree on the URL, in the spelling the host will echo', async () => {
    const { call, close, ev } = await attach();
    const opened = ev.sockets.length;
    const answer = call('wait_for_file_change', { path: '/home/user/project/./', timeout_s: 1 });
    const socket = await nominated(ev);
    // Normalised HERE, before anything is sent, because a path this host would
    // refuse is a 400 on the upgrade — which reaches a websocket client as an
    // error with no status and no body.
    expect(socket.watches).toEqual(['/home/user/project']);
    expect(ev.sockets.length).toBe(opened + 1);
    const res = await answer;
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Nothing changed under /home/user/project');
    // And it says what the path became, since the cleaned form is the one every
    // event carries and the one the caller has to match on.
    expect(textOf(res)).toContain('is the same directory as /home/user/project');
    await close();
  });

  it('resumes rather than restarts when the nomination reopens the connection', async () => {
    const { call, close, ev } = await attach();
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    const socket = await nominated(ev);
    // The reconnect a watch costs must not be a hole in the stream: the new
    // connection asks the platform to replay from where the old one had got to.
    expect(socket.since).toBe(HELLO.cursor);
    await answer;
    await close();
  });

  it('does not reopen anything for a tree it is already watching', async () => {
    const { call, close, ev } = await attach();
    await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    const opened = ev.sockets.length;
    const res = await call('wait_for_file_change', { path: '/a/', timeout_s: 1 });
    expect(ev.sockets.length).toBe(opened);
    expect(res.isError).toBeFalsy();
    await close();
  });

  it('refuses a path the host would refuse, without opening anything', async () => {
    const { call, close, ev } = await attach();
    const opened = ev.sockets.length;
    for (const [path, said] of [
      ['relative/path', 'must be absolute'],
      ['/', 'watching / is not a nomination'],
      ['/a\nb', 'control characters'],
      [`/${'x'.repeat(300)}`, 'at most 256 bytes'],
    ] as const) {
      const res = await call('wait_for_file_change', { path, timeout_s: 1 });
      expect(res.isError, path).toBe(true);
      expect(textOf(res)).toContain(said);
    }
    // A refusal decided here is a refusal that cost nothing on the wire.
    expect(ev.sockets.length).toBe(opened);
    await close();
  });

  it('waits for the tree to be armed before it will say anything about silence', async () => {
    const { call, close } = await attach({}, false);
    const res = await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    // The whole of the arming discipline. inotify reports changes and not
    // state, so nothing that happened before the watch armed was reported —
    // and "nothing changed" over that window is a claim about a stretch of time
    // during which nobody was looking.
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('not being watched yet');
    expect(textOf(res)).toContain('NOTHING can be said about whether it changed');
    expect(textOf(res)).not.toContain('Nothing changed');
    await close();
  });

  it('starts waiting properly once the guest answers the nomination', async () => {
    const { call, close, ev } = await attach({}, false);
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 5 });
    const socket = await nominated(ev);
    socket.send(frame({ watch: '/a', armed: true }, 'cur-1'));
    socket.send(frame({ watch: '/a', path: '/a/out.txt', kind: 'created' }, 'cur-2'));
    const res = await answer;
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('created /a/out.txt');
    expect(dataOf(res).watching).toEqual([{ path: '/a', armed: true }]);
    await close();
  });

  it('takes the opening frame as the answer for a tree somebody else nominated first', async () => {
    // `armed: true` in `hello` means live NOW and no event is coming to say so:
    // the guest answers a nomination once, and somebody else already asked. A
    // client that waited for the event would wait forever on a live tree.
    const { call, close, ev } = await attach({}, true);
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 5 });
    const socket = await nominated(ev);
    socket.send(frame({ watch: '/a', path: '/a/x', kind: 'modified' }, 'cur-1'));
    const res = await answer;
    expect(textOf(res)).toContain('modified /a/x');
    await close();
  });

  it('reports a flood as a re-read rather than as a failure', async () => {
    const { call, close, ev } = await attach();
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 5 });
    const socket = await nominated(ev);
    socket.send(frame({ watch: '/a', lost: 'flood' }, 'cur-1'));
    const res = await answer;
    // Not an error. A tool that surfaced this as one would make a model give up
    // on a watch that is working: a build under a watched path costs one of
    // these every time.
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('The watch is still on');
    expect(textOf(res)).toContain('list the directory');
    await close();
  });

  it('tells a budget loss apart from a flood, because only one of them clears', async () => {
    const { call, close, ev } = await attach();
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 5 });
    const socket = await nominated(ev);
    socket.send(frame({ watch: '/a', lost: 'budget' }, 'cur-1'));
    const res = await answer;
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('narrower path');
    expect(textOf(res)).not.toContain('still being watched — this is not a failure');
    await close();
  });

  it('refuses a tree the guest cannot watch, and says a symlink is one of the reasons', async () => {
    const { call, close, ev } = await attach({}, false);
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 5 });
    const socket = await nominated(ev);
    socket.send(frame({ watch: '/a', lost: 'unwatchable' }, 'cur-1'));
    const res = await answer;
    // The one `lost` that means the tree is NOT being watched, so the one that
    // is a refusal rather than a re-read.
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('SYMLINK');
    expect(textOf(res)).toContain('not there yet');
    // And it does not wait out the deadline to say so.
    await close();
  });

  it('ends a wait on a re-arm, because reporting starts there and the gap was never reported', async () => {
    const { call, close, ev } = await attach();
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 5 });
    const socket = await nominated(ev);
    // The host suppresses a restatement, so an armed frame that reaches a
    // client is always a transition: the watch was interrupted and is reporting
    // from HERE. A wait that only matched file paths would sit through it and
    // then report a quiet directory.
    socket.send(frame({ watch: '/a', armed: true }, 'cur-1'));
    const res = await answer;
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('re-armed after an interruption');
    expect(textOf(res)).toContain('Re-read the directory');
    await close();
  });

  it('keeps four trees and says which one a fifth pushed out', { timeout: 20_000 }, async () => {
    const { call, close, ev } = await attach();
    for (const path of ['/a', '/b', '/c', '/d']) {
      await call('wait_for_file_change', { path, timeout_s: 1 });
    }
    await until('four trees on one connection', () => ev.last().watches.length === 4);
    const res = await call('wait_for_file_change', { path: '/e', timeout_s: 1 });
    // Evicted rather than refused — a model that has moved on should not have
    // to know four earlier directories are in the way — but never silently: a
    // dropped watch is a tree that has stopped reporting.
    expect(textOf(res)).toContain('/a is no longer being watched');
    const socket = await nominated(ev, 4);
    expect(socket.watches).toEqual(['/b', '/c', '/d', '/e']);
    await close();
  });

  it('only ends a wait on the tree it was asked about', async () => {
    const { call, close, ev } = await attach();
    await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    const answer = call('wait_for_file_change', { path: '/b', timeout_s: 2 });
    const socket = await nominated(ev, 2);
    socket.send(frame({ watch: '/a', path: '/a/x', kind: 'created' }, 'cur-9'));
    const res = await answer;
    // The other tree's change is still handed over — nothing is dropped — but
    // it is not the answer to a question about /b.
    expect(textOf(res)).toContain('Nothing changed under /b');
    expect(textOf(res)).toContain('1 other event did happen');
    await close();
  });

  it('says so when the host opened a stream and ignored the nomination', async () => {
    // A host predating file watches ignores `&watch=` rather than refusing it,
    // so the socket opens, nothing is watched, and the silence is
    // indistinguishable from a quiet directory. The opening frame is the only
    // place the two can be told apart.
    const { call, close } = await attach({ watching: undefined });
    const res = await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('said nothing about /a');
    expect(textOf(res)).toContain('may predate file watches');
    await close();
  });

  it('refuses a computer with no channel to run a watcher over', async () => {
    const { call, close } = await attach({
      events: ['computer.started', 'computer.stopped', 'computer.idle'],
    });
    const res = await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('cannot emit file.changed');
    expect(textOf(res)).toContain('nowhere to run a watcher at all');
    await close();
  });

  it('does not blame a missing channel on a host that plainly has one', async () => {
    // A computer reporting window events has the terminal channel a file watch
    // runs over, since the desktop half needs that channel AND the X bindings.
    // What it lacks is a host that knows about file watches at all.
    const { call, close } = await attach({
      events: ['window.opened', 'window.closed', 'clipboard.changed', 'computer.ready'],
    });
    const res = await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('the channel is there');
    expect(textOf(res)).toContain('predates them');
    expect(textOf(res)).not.toContain('nowhere to run a watcher at all');
    await close();
  });

  it('explains a missing window watcher by the bindings when the channel is plainly there', async () => {
    // The third case in the platform's capability list: `file.changed` runs
    // against libc's own inotify calls, so an image published before
    // python3-xlib emits every file event and no window event at all. A
    // sentence blaming the missing channel would be describing a computer that
    // is running a watcher over one.
    const { call, close } = await attach({
      events: ['file.changed', 'process.exited', 'computer.started'],
    });
    const res = await call('wait_for_event', { types: ['window.opened'], timeout_s: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('two capabilities and this computer has one of them');
    expect(textOf(res)).toContain('X bindings');
    expect(textOf(res)).not.toContain('nowhere to run a watcher at all');
    await close();
  });

  it('refuses a wait for file.changed on a stream that has nominated nothing', async () => {
    const { call, close } = await attach();
    const res = await call('wait_for_event', { types: ['file.changed'], timeout_s: 1 });
    // Waiting longer cannot fix this, so it is not answered with a wait: the
    // nomination is a property of the connection.
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('nobody is sent unasked');
    expect(textOf(res)).toContain('wait_for_file_change');
    await close();
  });

  it('still runs a wait that names file.changed alongside a type that can arrive', async () => {
    const { call, close } = await attach();
    // Refusing this would take a legitimate wait away because it happened to
    // mention a file — but the answer must not read as though both halves were
    // being listened for.
    const res = await call('wait_for_event', {
      types: ['process.exited', 'file.changed'],
      timeout_s: 1,
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('One thing was NOT being waited for');
    expect(textOf(res)).toContain('nobody is sent unasked');
    await close();
  });

  it('does not report a tree that went unwatchable mid-wait as a quiet directory', async () => {
    const { call, close, ev } = await attach();
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 5 });
    const socket = await nominated(ev);
    socket.send(frame({ watch: '/a', lost: 'unwatchable' }, 'cur-1'));
    const res = await answer;
    // It arrives as an ordinary file.changed, so a tool that described it with
    // the rest of them would report the tree going away as a change under it.
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('SYMLINK');
    expect(textOf(res)).toContain('It was being watched until now; from here it is not');
    expect(textOf(res)).not.toContain('Nothing changed under');
    await close();
  });

  it('lets the general wait see file events once a tree is nominated', async () => {
    const { call, close, ev } = await attach();
    await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    const answer = call('wait_for_event', { types: ['file.changed'], timeout_s: 5 });
    const socket = await nominated(ev);
    socket.send(frame({ watch: '/a', path: '/a/x', kind: 'deleted' }, 'cur-3'));
    const res = await answer;
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('file.changed');
    await close();
  });

  it('nominates again after an idle reap, because a reap is not a decision to forget', async () => {
    // A tree is watched by the CONNECTION, so a reap ends the watch. A stream
    // that came back watching nothing would answer the next question about /a
    // with an ordinary "nothing changed", over a window during which nothing
    // was looking — which is the one answer a file watch must never produce.
    const ev = fakeEvents();
    const hub = new EventHub(new Api('com_test', BASE), ev.factory);
    try {
      const sub = hub.open('vm-1');
      sub.nominate('/a');
      await until('a connection carrying the tree', () =>
        ev.sockets.some((s) => s.watches.includes('/a')),
      );
      hub.drop('vm-1', 'idle', true);
      hub.open('vm-1');
      await until('a fresh connection carrying the remembered tree', () => {
        const last = ev.sockets[ev.sockets.length - 1];
        return last.greeted && last.watches.includes('/a');
      });
    } finally {
      hub.closeAll();
    }
  });

  it('sheds a watch the host will not carry rather than losing the whole stream', {
    timeout: 20_000,
  }, async () => {
    // A watch is the one thing on this URL a host refuses outright, and it does
    // so on the upgrade — where a websocket client is told nothing. Left alone,
    // one tree the host will not take is the whole stream gone: no windows, no
    // process exits, no readiness, reconnecting forever with nothing saying why.
    const ev = drivenEvents();
    ev.state.failWatched = true;
    const { call, close } = await connect({ webSocket: ev.factory });
    await call('poll_events');
    const res = await call('wait_for_file_change', { path: '/a', timeout_s: 10 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('would not open an event stream carrying /a');
    expect(textOf(res)).toContain('32 trees');
    // And not as an eviction. A shed tree is missing from the set for quite a
    // different reason than somebody else's fifth directory.
    expect(textOf(res)).not.toContain('pushed out');
    // And the rest of the stream comes back, which is how this server knew.
    await until('a connection carrying no watch', () => {
      const last = ev.last();
      return last.greeted && last.watches.length === 0;
    });
    const after = await call('poll_events');
    expect(after.isError).toBeFalsy();
    await close();
  });

  it('does not count a socket it closed itself as a refused upgrade', async () => {
    // `nominate` closes the socket to put a new watch set on the URL, and if it
    // does so before the opening frame lands the connection reads as one that
    // never opened — which is the same shape a host refusing the watch has. One
    // re-nomination of an in-flight connection plus one ordinary blip used to be
    // enough to shed a tree and report it as one the host would not carry.
    const ev = greetsOnDemand();
    const hub = new EventHub(new Api('com_test', BASE), ev.factory);
    try {
      const sub = hub.open('vm-1');
      await until('the first connection', () => ev.sockets.length === 1);
      ev.greet(ev.last());
      for (const path of ['/a', '/b', '/c']) {
        const before = ev.sockets.length;
        sub.nominate(path);
        await until(`a connection carrying ${path}`, () => ev.sockets.length > before);
      }
      ev.greet(ev.last());
      await until('the nominations to settle', () => ev.last().greeted);
      expect(ev.last().watches).toEqual(['/a', '/b', '/c']);
      for (const path of ['/a', '/b', '/c']) {
        expect(sub.watchWasRefused(path), path).toBe(false);
      }
    } finally {
      hub.closeAll();
    }
  });

  it('does not read a host that is simply down as a watch the host refused', {
    timeout: 30_000,
  }, async () => {
    // A down host and a refused watch fail identically: undici reports both as
    // a non-101. So shedding a tree is a hypothesis, and the answer is only
    // allowed to name the 32-tree limit once the SAME stream has opened without
    // it. Here it never does, so nothing is claimed beyond an unreachable host.
    const ev = drivenEvents();
    const { call, close } = await connect({ webSocket: ev.factory });
    await call('poll_events');
    ev.state.failAll = true;
    const res = await call('wait_for_file_change', { path: '/a', timeout_s: 12 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Could not start watching /a');
    expect(textOf(res)).not.toContain('32 trees');
    expect(textOf(res)).not.toContain('will not honour this path');
    await close();
  });

  it('retries a tree it gave up on when the model asks for it again', {
    timeout: 30_000,
  }, async () => {
    const ev = drivenEvents();
    ev.state.failWatched = true;
    const { call, close } = await connect({ webSocket: ev.factory });
    await call('poll_events');
    const refusal = await call('wait_for_file_change', { path: '/a', timeout_s: 10 });
    expect(textOf(refusal)).toContain('would not open an event stream carrying /a');
    // Every one of those refusals ends by telling the caller to call again, so
    // calling again has to mean something: the computer may since have dropped
    // below its tree limit.
    ev.state.failWatched = false;
    const res = await call('wait_for_file_change', { path: '/a', timeout_s: 2 });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Nothing changed under /a');
    await close();
  });

  it('stops an arming wait when another call takes the tree away', {
    timeout: 30_000,
  }, async () => {
    const { call, close } = await attach({}, false);
    // The arming wait used to park through an eviction and then say the tree
    // was still coming up and the nomination stood — both false.
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 25 });
    await until('the /a nomination', () => true);
    await Promise.all(
      ['/b', '/c', '/d', '/e'].map((path) => call('wait_for_file_change', { path, timeout_s: 1 })),
    );
    const res = await answer;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('pushed out');
    expect(textOf(res)).not.toContain('nomination stands');
    await close();
  });

  it('hands over a file event that already arrived even with nothing armed now', async () => {
    const { call, close, ev } = await attach({}, false);
    await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    const socket = await nominated(ev);
    socket.send(frame({ watch: '/a', path: '/a/x', kind: 'created' }, 'cur-1'));
    // Anything already buffered wins before anything about the present is
    // judged. A refusal that ran ahead of the ring would withhold an event this
    // computer had already sent.
    const res = await call('wait_for_event', { types: ['file.changed'], timeout_s: 1 });
    expect(res.isError).toBeFalsy();
    // And it says what the event was. Three payloads wear this one type, so the
    // bare type read the same for a file being written and a tree going away.
    expect(textOf(res)).toContain('created /a/x');
    await close();
  });

  it('keeps a standing budget across the reconnect another nomination causes', async () => {
    const { call, close, ev } = await attach();
    const first = call('wait_for_file_change', { path: '/a', timeout_s: 5 });
    (await nominated(ev)).send(frame({ watch: '/a', lost: 'budget' }, 'cur-1'));
    expect(textOf(await first)).toContain('narrower path');
    // Nominating a different tree reopens the connection, and the opening frame
    // has no field for a loss — so a client that cleared the flag on every hello
    // would drop a permanent condition nothing puts back, and go on to report a
    // confident silence over a subtree nobody is looking at.
    await call('wait_for_file_change', { path: '/b', timeout_s: 1 });
    const res = await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('that is not the whole tree');
    await close();
  });

  it('will not call a partly watched tree quiet, however long it waits', async () => {
    const { call, close, ev } = await attach();
    const first = call('wait_for_file_change', { path: '/a', timeout_s: 5 });
    const socket = await nominated(ev);
    socket.send(frame({ watch: '/a', lost: 'budget' }, 'cur-1'));
    expect(textOf(await first)).toContain('narrower path');
    // The condition is permanent for this watch, so the NEXT call must not go
    // on to report a confident silence over a subtree nobody is looking at.
    const res = await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('that is not the whole tree');
    expect(textOf(res)).not.toContain('watched for the whole of that');
    await close();
  });

  it('does not call a tree watched while the stream is between connections', async () => {
    const ev = drivenEvents();
    const { call, close } = await connect({ webSocket: ev.factory });
    await call('poll_events');
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 2 });
    await until(
      'the nominated connection',
      () => ev.last().greeted && ev.last().watches.length > 0,
    );
    // The armed map is what the last opening frame said, and it is deliberately
    // not cleared by a dropped socket — clearing it would make every routine
    // reconnect look like a re-arm, which is a "go and re-read this" for an
    // interruption the platform's own replay covered. So the liveness of the
    // CONNECTION is the half of "watched the whole time and still is" that can
    // be checked, and it is what is checked.
    ev.state.greet = false;
    ev.last().close();
    const res = await answer;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('is reopening');
    expect(textOf(res)).not.toContain('watched for the whole of that');
    await close();
  });

  it('says a tree went unwatched across a reap instead of answering as though it had not', async () => {
    const ev = fakeEvents();
    const hub = new EventHub(new Api('com_test', BASE), ev.factory);
    try {
      const first = hub.open('vm-1');
      first.nominate('/a');
      await until('the nominated connection', () =>
        ev.sockets.some((s) => s.greeted && s.watches.includes('/a')),
      );
      hub.drop('vm-1', 'idle', true);
      // Re-nominating gets the watch going again and says nothing about the
      // hole. inotify reports changes and not state, so what happened while
      // nothing was connected was never recorded for a replay to hand back.
      const second = hub.open('vm-1');
      expect(second.takeInterruption('/a')).toBe(true);
      // Said once and then forgotten.
      expect(second.takeInterruption('/a')).toBe(false);
    } finally {
      hub.closeAll();
    }
  });

  it('stops waiting when the computer loses the capability mid-wait', async () => {
    const { call, close, ev } = await attach();
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 5 });
    const socket = await nominated(ev);
    // A guest that turns out to have no watcher withdraws the half hello
    // promised. The frame wakes every parked waiter but is not an event, so a
    // wait that only re-ran its match would sit out the whole deadline on a
    // computer that could no longer produce what it was waiting for.
    socket.send({
      type: 'capabilities',
      events: ['process.exited', 'computer.idle'],
      detail: 'no watcher',
    });
    const res = await answer;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('stopped being able to report file changes');
    expect(textOf(res)).not.toContain('Nothing changed under');
    await close();
  });

  it('does not let a nominated-but-unarmed tree pass for a working watch', async () => {
    const { call, close } = await attach({}, false);
    // The nomination is accepted at once and the guest is asked afterwards, so
    // there is a window in which no file event can arrive. Counting the
    // nomination would let that window suppress the refusal and hand back a
    // timeout reading "nothing happened".
    await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    const res = await call('wait_for_event', { types: ['file.changed'], timeout_s: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('not being watched yet');
    await close();
  });

  it('calls an eviction an eviction rather than a re-arm', { timeout: 40_000 }, async () => {
    const { call, close, ev } = await attach();
    // Waiting on a tree makes it the most recently asked about, so it takes
    // four more nominations to push this one out — which is the only way an
    // active wait loses its tree, and the case that has to read correctly.
    const answer = call('wait_for_file_change', { path: '/a', timeout_s: 30 });
    await nominated(ev);
    await Promise.all(
      ['/b', '/c', '/d', '/e'].map((path) => call('wait_for_file_change', { path, timeout_s: 1 })),
    );
    const res = await answer;
    // Evicting does not reset the arm generation — that is kept monotonic on
    // purpose — but it does take the tree out of the set, and a waiter reading
    // the generation before the membership would call this a re-arm and invite
    // the caller to go on waiting on a tree nothing nominates.
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('pushed out');
    expect(textOf(res)).not.toContain('re-armed');
    await close();
  });

  it('reports the time it spent watching, not the timeout it was given', async () => {
    const { call, close } = await attach({}, false);
    // timeout_s bounds the whole call, arming included — it has to, because a
    // client cancels a request that outlives its own timeout. So a call that
    // spent most of it arming watched for less than it asked for.
    const res = await call('wait_for_file_change', { path: '/a', timeout_s: 2 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('in 2s');
    await close();
  });

  it('says which trees are live on every read, not only the one that nominated them', async () => {
    const { call, close } = await attach();
    await call('wait_for_file_change', { path: '/a', timeout_s: 1 });
    const res = await call('poll_events');
    // Not a constant like `can_emit`: a tree arms after the call that nominated
    // it, another call can evict it, and a reconnect can find it disarmed.
    expect(dataOf(res).watching).toEqual([{ path: '/a', armed: true }]);
    await close();
  });
});
