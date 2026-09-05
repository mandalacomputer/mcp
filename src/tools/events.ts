import { z } from 'zod';
import {
  type ComputerEvent,
  cleanWatchPath,
  type Delivery,
  MAX_WATCHES,
  type Subscription,
  type Watched,
} from '../events.js';
import {
  type Computer,
  guarded,
  refused,
  said,
  unwrapComputer,
  withoutCredentials,
} from '../format.js';
import * as P from '../paths.js';
import type { Session } from '../session.js';
import type { Registrar } from './types.js';

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

/**
 * The types this build knows the meaning of, for the tool descriptions only.
 *
 * Not an enum on the argument, and that is deliberate: the reference says in as
 * many words that the vocabulary grows and that a client must ignore a `type`
 * it does not recognise. A closed enum here would refuse a model waiting for an
 * event the platform had started sending, which is the wrong way round for a
 * list that is documented as open.
 */
const KNOWN_TYPES = [
  'window.opened',
  'window.closed',
  'window.focused',
  'window.blurred',
  'clipboard.changed',
  // The one type nobody is sent unasked (platform OPL-3927). It is here so a
  // model reading this list knows it exists; a wait that names it and nothing
  // else, on a stream watching nothing, is answered with the sentence that says
  // how to make one arrive rather than with a timeout.
  'file.changed',
  'process.exited',
  'computer.ready',
  'computer.idle',
  'computer.started',
  'computer.stopped',
  'computer.suspended',
];

/**
 * The longest wait this server will hold a tool call open for.
 *
 * Measured rather than assumed, which is what OPL-3926 asked for. The MCP SDK
 * on both ends of this — `@modelcontextprotocol/sdk`, in this package's own
 * `node_modules` — starts a 60-second timer per request in
 * `DEFAULT_REQUEST_TIMEOUT_MSEC`, and most clients ship that default unchanged.
 * A tool that blocks past it does not return late; it is cancelled, and the
 * model is told the server failed.
 *
 * So the cap sits under it with room for the round trip. `wait_for_computer`
 * next door goes to 900 seconds and is right to: what it is waiting for cannot
 * be missed by not watching, so a client that gives up at 60 costs one wasted
 * call and nothing else. Here the whole point is that nothing is missed between
 * calls — the socket stays open and the buffer keeps filling whether or not
 * anybody is in a tool call — so a short cap costs precisely nothing. Waiting
 * again is free, and it is the documented answer to a timeout.
 */
const MAX_WAIT_S = 55;

/** How long a first call gives the socket to reach its opening frame. */
const ATTACH_MS = 20_000;

/**
 * Wait for a subscription to say something about itself, inside a budget.
 *
 * The first call on a computer has to attach before it can answer anything: a
 * poll that returned "no events" while the socket was still being opened would
 * be a model told nothing had happened, which is a different sentence from
 * "nothing has happened yet" and the one that ends a turn early.
 *
 * `deadline` is the CALLER's, and passing it is what keeps `ATTACH_MS` from
 * being a second budget stacked in front of the first. Without it a
 * `wait_for_event` spent up to twenty seconds here and only then armed its own
 * `timeout_s`, so a call promising to come back in one second came back in
 * twenty — and one asking for the maximum ran past the sixty most MCP clients
 * allow a request, which is the cancellation {@link MAX_WAIT_S} exists to
 * prevent. Whichever fires first wins; `poll_events` has no deadline of its own
 * and keeps the handshake budget alone.
 */
async function attached(
  sub: Subscription,
  cancel?: AbortSignal,
  deadline?: AbortSignal,
): Promise<void> {
  if (sub.eventTypes || sub.state.status === 'stopped') return;
  const budget = AbortSignal.timeout(ATTACH_MS);
  await sub.attached(deadline ? AbortSignal.any([budget, deadline]) : budget, cancel);
}

/**
 * The state a model would otherwise have to go and fetch, fetched here.
 *
 * This is the answer to the third question on OPL-3926 — what a `gap` means to
 * a caller that cannot be told to "reconcile with a listing". It is not told
 * to. The events that survived come back with the count that did not, and with
 * the two things the missing ones would have reported: what is on the desktop
 * now, and what state the machine is in. A model handed an uninterpretable
 * `gap` invents a recovery procedure; this is that procedure, already run.
 *
 * Failures here are swallowed on purpose. This is context attached to an answer
 * the caller already has, and a windows listing that 409s because the guest is
 * busy must not turn a delivered event into a failed tool call.
 */
async function reconcile(
  session: Session,
  id: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const api = session.api.with(signal);
  const state: Record<string, unknown> = {};
  const [windows, computer] = await Promise.allSettled([
    api.json('GET', P.computerAction(id, 'windows')),
    api.json('GET', P.computer(id)),
  ]);
  if (windows.status === 'fulfilled') state.windows_now = windows.value;
  if (computer.status === 'fulfilled') {
    state.computer_now = withoutCredentials(unwrapComputer(computer.value) as Computer);
  }
  return state;
}

/**
 * The sentence that points at the reconciliation — naming only the keys it
 * actually produced.
 *
 * `reconcile` assigns each key on a fulfilled read and swallows the rest, so
 * `{}` is a real return value: the windows read 409s while the guest is busy,
 * the computer read fails, or the caller's own signal aborts both. Naming
 * `windows_now` and `computer_now` regardless sends a model looking for two
 * keys that are not in the payload — a wasted turn on the one answer that is
 * already admitting a hole, and the tool that has to be believed about holes.
 */
function reconciled(extras: Record<string, unknown>): string {
  const reads = [
    { key: 'windows_now', tool: 'list_windows' },
    { key: 'computer_now', tool: 'get_computer' },
  ];
  const here = reads.filter((r) => r.key in extras).map((r) => r.key);
  const absent = reads.filter((r) => !(r.key in extras)).map((r) => r.tool);
  if (!here.length) {
    return (
      ' See lost for what is known about it. Where the computer actually stands could NOT be read ' +
      'just now, so it is not in this answer — call list_windows and get_computer for what the ' +
      'missing events would have told you.'
    );
  }
  return (
    ` See lost for what is known about it, and ${here.join(' and ')} for where the computer ` +
    `actually stands, which is what the missing events would have told you.` +
    (absent.length ? ` The other half could not be read just now — call ${absent[0]} for it.` : '')
  );
}

/**
 * Why a computer is missing part of the guest half, in words.
 *
 * "The guest half" is not one thing, which is what a client gets wrong here and
 * what this server got wrong until OPL-4221. `file.changed` runs in the
 * terminal broker against libc's own inotify calls, so it needs the terminal
 * channel and NOTHING an image can be missing; the window, clipboard and
 * readiness events need that channel AND the X bindings their desktop watcher
 * is written against. Three shapes fall out of that, and each wants something
 * different done about it — one is fixed by a stop and a start, one is a fact
 * about the image, one is a fact about the host.
 *
 * Written once and used by both wait tools, because the branch was split
 * correctly in one of them and not the other, which is how a two-copy
 * explanation goes wrong.
 *
 * Read off `can` rather than off the computer record, because `can` is what the
 * host actually said and is revised mid-stream by a `capabilities` frame.
 */
function guestHalf(can: string[]): string {
  const files = can.includes('file.changed');
  const desktop = can.some((t) => t.startsWith('window.'));
  if (files && !desktop) {
    return (
      'The guest half of this stream is more than one capability and this computer has some of ' +
      'it: file.changed needs only the terminal channel its watcher runs over, which this ' +
      'computer has, while window, clipboard and readiness events also need the X bindings their ' +
      'desktop watcher is written against — and this image does not carry those. That is a fact ' +
      'about the image and there is no operation that moves an existing computer onto a newer ' +
      'one, so nothing will make it report those. Use screenshot and list_windows for the desktop.'
    );
  }
  if (desktop && !files) {
    // The reverse of the case above, and the one that reads most like a missing
    // channel while being its opposite: the desktop half needs that channel
    // too, so a computer reporting it plainly has one.
    return (
      'It does report the desktop half, which needs the same terminal channel a file watch runs ' +
      'over — so the channel is there and it is the file watch that is missing. The host holding ' +
      'this computer predates them (platform OPL-3927), and there is nothing to do about that ' +
      'from here.'
    );
  }
  if (files && desktop) {
    // Both halves present, so whatever was asked for is not a guest capability
    // at all. Reachable only when the platform's vocabulary grows past what this
    // build knows, which the reference says it will — and a paragraph about a
    // missing watcher would be a confident answer to a question nobody asked.
    return (
      'This computer reports both halves of what a guest observes about itself, so the type you ' +
      'asked for is one it does not emit rather than one it is unable to emit. The vocabulary ' +
      'grows; this build may simply be asking for something newer than the host.'
    );
  }
  return (
    'This guest has nowhere to run a watcher at all — a Windows one, or a Linux one whose ' +
    'hardware carries no terminal channel — so none of the guest-reported half reaches this ' +
    'stream. The channel is hardware and is acquired on a COLD start, so stop_computer then ' +
    'start_computer can get one where restart_computer cannot. Meanwhile screenshot, ' +
    'list_windows and exec_poll still work.'
  );
}

/** One event's type and the thing about it worth putting in a sentence. */
function name(ev: ComputerEvent): string {
  const data = (ev.data ?? {}) as Record<string, unknown>;
  // `file.changed` wears three payloads, and two of them are not a file: a
  // marker saying this stream's picture of the tree is wrong, and the tree
  // going live. Left to the fallthrough all three read as the bare type, so a
  // wait that ended on "the tree is too big to watch" and one that ended on a
  // file being written said exactly the same thing. wait_for_file_change is
  // careful about this; the general wait advertises the type too and has to be.
  const file =
    ev.type === 'file.changed'
      ? data.armed === true
        ? 'now watching this tree — reporting starts here, so re-read it'
        : typeof data.lost === 'string' && data.lost
          ? `${data.lost} under ${data.watch} — this stream's picture of that tree is incomplete`
          : `${data.kind} ${data.path}${data.dir ? ', a directory' : ''}`
      : '';
  if (file) return `${ev.type} (${file})`;
  const detail =
    ev.type === 'process.exited'
      ? `pid ${data.pid}${data.lost ? ', outcome unknown — the guest lost track of it' : ` exited ${data.exit_code}`}`
      : ev.type === 'window.opened' || ev.type === 'window.focused'
        ? String(data.class ?? data.title ?? data.id ?? '')
        : ev.type === 'window.closed' || ev.type === 'window.blurred'
          ? String(data.id ?? '')
          : ev.type === 'computer.idle'
            ? `${data.idle_seconds}s idle`
            : ev.type.startsWith('computer.')
              ? String(data.status ?? '')
              : '';
  return detail ? `${ev.type} (${detail})` : ev.type;
}

/** The body these tools answer with, minus the keys there is nothing to say about. */
function body(
  id: string,
  d: Delivery,
  sub: Subscription,
  watching?: Watched[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { computer: id, events: d.events, cursor: d.cursor };
  if (d.more) out.more_waiting = d.more;
  if (d.loss) out.lost = d.loss;
  // On every call rather than only the first, unlike `can_emit` below, because
  // this one is not a constant: a tree arms after the call that nominated it,
  // another call can evict it, and a reconnect can find it disarmed. A reader
  // that had to remember which of four trees was live from a call several turns
  // ago is a reader that will get it wrong.
  if (watching?.length) out.watching = watching;
  // Only where it is news. `can_emit` is what stops a model waiting for
  // something this machine will never produce, and the opening frame is the one
  // place that answer exists — but repeating it on every poll would be a field
  // that means nothing on the ninety-ninth call.
  //
  // Read from the LIVE list rather than from the greeting that seeded it. A
  // `capabilities` frame replaces what `hello` advertised and goes both ways —
  // a guest that turns out to have no watcher withdraws the half `hello`
  // promised — and one landing between the opening frame and this subscription's
  // first read would otherwise publish, exactly once and never again, a
  // vocabulary that contradicts the one every refusal path here already acts on.
  if (d.attached && d.hello) {
    out.can_emit = sub.eventTypes ?? d.hello.events;
    if (d.hello.windows) out.windows_on_attach = d.hello.windows;
  }
  return out;
}

/**
 * A subscription that has stopped, said once, with whatever it was still
 * holding, and with what to do about it.
 *
 * DRAINED BEFORE THE DROP, which is the whole of the order here. A stream can
 * stop with events still in its ring, and on this platform that is the ordinary
 * case rather than the odd one: listening is not using, so a computer nobody
 * touches suspends underneath its own stream, and the `process.exited` a model
 * went away to wait for is sitting in the buffer when it does. Both gates used
 * to run ahead of every read, so those events went into `drop` unread and the
 * answer was a bare refusal.
 *
 * What made that silent rather than merely late is `resumeCursor`: it is the
 * last cursor DELIVERED, not the last received, so the remembered position was
 * before the unread events and the replacement stream got them back only if the
 * platform could still replay across the stop — which is exactly what a suspend
 * is least likely to allow. Reading here hands them over AND moves that cursor
 * past them, so what is remembered is true whichever way the replay goes.
 *
 * AND THE DROP WAITS FOR AN EMPTY RING, which is the other half of the same
 * point. The drop is what keeps a stopped subscription from answering
 * "suspended" for five minutes after `start_computer` has already fixed it — a
 * model told to fix something, doing so, and being told the same thing again is
 * a model that stops believing the tool. But the drop also destroys the buffer,
 * and this read is bounded by the caller's `limit` while the ring holds up to
 * `MAX_BUFFERED`. Dropping on the first call therefore MOVED the loss rather
 * than removing it: three hundred unread events became a hundred delivered and
 * two hundred discarded, under a sentence calling them the last this stream has
 * and a `more_waiting` that said otherwise (/code-review, OPL-4244). So the stop
 * is reported on every call — which is true every time, and each one hands over
 * another batch — and the subscription goes only when there is nothing left in
 * it. A model that never calls back leaves it to the idle sweep, which is what
 * the sweep is for.
 */
function stopped(
  session: Session,
  id: string,
  reason: string,
  sub: Subscription,
  read: { since?: string; limit: number },
) {
  const d = sub.read(read);
  const n = d.events.length;
  const drained = !d.more;
  // The sub this call drained, named, so the drop cannot take a replacement.
  // Two calls on one computer overlap by design here, and a second one holding
  // a handle this one has already dropped would otherwise close the fresh
  // stream opened in between.
  if (drained) session.events.drop(id, reason, true, sub);
  const held = n
    ? `${n} event${n === 1 ? '' : 's'} had already arrived before it stopped and ${n === 1 ? 'is' : 'are'} ` +
      (drained
        ? `below — ${n === 1 ? 'it is' : 'they are'} the last this stream has. `
        : `below. ${d.more} more ${d.more === 1 ? 'is' : 'are'} still held here — call again for ` +
          `${d.more === 1 ? 'it' : 'them'} before doing anything else, because they are only in this ` +
          `session and a replay across the stop may not reach them. `)
    : '';
  return refused(
    `${held}The event stream for ${id} is not running: ${reason}. Fix the cause and call again: ` +
      (drained
        ? `the next call opens a fresh stream and resumes from the last event you were handed, so ` +
          `whatever the platform can still replay you will still be given, and whatever it cannot ` +
          `comes back as a stated gap rather than as silence.`
        : `the next call hands over what is still buffered here, and the one after the buffer is ` +
          `empty opens a fresh stream that resumes from the last event you were handed.`),
    // Without the watch set, deliberately. This stream has stopped, so a tree
    // it was carrying is a tree nothing is watching — and `watching` reports
    // `armed` from the last opening frame, which would read as live.
    n || d.loss ? body(id, d, sub) : undefined,
  );
}

/**
 * A stream that has not yet got as far as its opening frame.
 *
 * Distinct from every other answer here, because the empty list it would
 * otherwise produce is the one sentence this server must not say by accident:
 * "nothing has happened" said by something that was not listening.
 *
 * The subscription is deliberately NOT dropped. It used to be, and that undid
 * the one thing `#url()` was changed to do: a computer that is `starting` or
 * `moving` is weather rather than a refusal, so the loop backs off and keeps
 * asking — and dropping it here threw that progress away every time, so a model
 * following the create-then-wait flow the README advertises paid the full
 * handshake budget again on each call and never got further. Left alone, the
 * loop carries on between turns and the next call finds it further along; the
 * idle sweep is what eventually takes one that never arrives.
 *
 * The budget is reported as what was actually spent, since it is now the
 * caller's deadline that usually ends this rather than {@link ATTACH_MS}.
 */
function unattached(id: string, waitedMs: number) {
  return refused(
    `Could not open the event stream for ${id} in ${Math.max(1, Math.round(waitedMs / 1000))}s. This is not ` +
      `an answer about the computer: nothing was listening, so nothing can be said about what it ` +
      `did. The stream is still coming up and this server is still trying — call again, and if it ` +
      `keeps happening, screenshot and list_windows still work.`,
  );
}

/** The caller hung up before the stream had opened. Nothing is claimed about the computer. */
const cancelledDuringAttach = (id: string) =>
  refused(
    `Cancelled while the event stream for ${id} was still opening. Nothing was learned about the ` +
      `computer, and the stream is still coming up — call again.`,
  );

/**
 * The caller hung up while a tree was being put on the wire, or while the guest
 * was being asked to watch it.
 *
 * Its own sentence rather than {@link cancelledDuringAttach}, which says the
 * stream was still opening — true of the attach and not of this. By here the
 * stream is up and it is the WATCH that is not ready, and a model told the
 * wrong one of those would go back to waiting on the stream.
 */
const cancelledWhileArming = (id: string, wire: string) =>
  refused(
    `Cancelled while ${wire} on ${id} was being set up to watch. Nothing is claimed about whether ` +
      `it changed — nothing was watching it yet. The nomination stands; call again.`,
  );

export const registerEvents: Registrar = (server, session) => {
  server.registerTool(
    'wait_for_event',
    {
      title: 'Wait for something to happen',
      description:
        'Block until the computer reports something, instead of screenshotting in a loop to find out whether it has. This is the tool that replaces polling: a window opening, a background command exiting, the desktop coming up, the machine going idle or changing power state. ' +
        `Types are ${KNOWN_TYPES.join(', ')}, and the list grows — pass none to wait for the next thing of any kind. ` +
        'It returns everything that happened up to and including the match, in order, so the answer is what the computer did rather than one fact out of it. ' +
        'Nothing is lost between calls: this server holds the stream open across turns, so a wait that times out has missed nothing and calling again picks up exactly where it left off. That is why the timeout is short — waiting again is free. ' +
        'Do not use it to wait for a click to land or a page to paint: neither is an event, and a screenshot is still how you find out what the screen looks like.',
      inputSchema: {
        ...idArg,
        types: z
          .array(z.string())
          .optional()
          .describe(
            'Wait for any of these. Omit to wait for the next event of any kind. A type this computer cannot emit is refused at once rather than waited on — a guest with no window watcher will never send a window.* and this says so instead of spending your timeout.',
          ),
        pid: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Only a process.exited for this pid — the one exec with background: true handed you. Without it a wait for process.exited ends on whichever background command finishes first, which on a computer running several is usually not yours.',
          ),
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_S)
          .default(30)
          .describe(
            'How long to block. Capped below the 60s request timeout most MCP clients ship, because a call that outlives that is cancelled rather than answered late. Nothing is missed by a short wait: call again.',
          ),
        since: z
          .string()
          .optional()
          .describe(
            'A cursor from an earlier call, to start from there instead of from where this session last read. You do not normally need it — with no cursor at all you are handed everything you have not already been given.',
          ),
        limit: z.number().int().min(1).max(500).default(100),
      },
      // Deliberately not readOnlyHint, for the reason exec_poll is not: both of
      // these CONSUME. `sub.read()` advances the model's place in the buffer, so
      // the events it returns are events no later call can return. Clients treat
      // the hint as licence to call without asking and to retry a call that
      // timed out, and a retried read silently drops whatever the first attempt
      // had already taken — the same defect one tool over, with a ring in this
      // session instead of a cursor in the guest. Nothing is created and nothing
      // is destroyed, which is what made the annotation look right.
    },
    ({ computer_id, types, pid, timeout_s, since, limit }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const sub = session.events.open(id);
        // ONE deadline for the whole call, armed before the attach rather than
        // after it. `timeout_s` is a promise about when this comes back, and
        // MAX_WAIT_S sits under the 60s most MCP clients give a request — but
        // the attach was a second budget of up to 20s stacked in front of that,
        // so a wait could run to about 75s and be cancelled by the client, which
        // is the exact failure the cap exists to prevent. Measured before the
        // fix: `wait_for_event({timeout_s: 1})` answered after 20.0 seconds.
        const deadline = AbortSignal.timeout(timeout_s * 1000);
        const started = Date.now();
        await attached(sub, extra.signal, deadline);
        // Re-read rather than narrowed once: a subscription can stop at any
        // point in this call, and a `state` captured before the wait is a
        // statement about a moment that has passed.
        const opening = sub.state;
        if (opening.status === 'stopped') {
          return stopped(session, id, opening.reason, sub, { since, limit });
        }
        // A caller who hung up is not a stream that failed to open.
        if (extra.signal?.aborted) return cancelledDuringAttach(id);
        if (!sub.eventTypes) return unattached(id, Date.now() - started);

        // A `pid` on its own means the exit of THAT command. Without this the
        // filter below reads "anything that is not a process.exited passes",
        // and `wait_for_event({pid: 99})` — which is how the argument's own
        // description reads — ends on the next clipboard change instead.
        const wanted = types?.length
          ? new Set(types)
          : pid !== undefined
            ? new Set(['process.exited'])
            : undefined;
        // `file.changed` is the one type on this stream that never arrives
        // unasked: a tree has to be NOMINATED on the connection, and without
        // one the platform sends no file events at all. So a wait for it on a
        // stream watching nothing can only end at its timeout, and be reported
        // as "nothing happened" — which is exactly wrong, because nothing was
        // being watched. Waiting longer cannot fix it; only nominating can.
        //
        // Refused only when it is the WHOLE of the request. As one type among
        // several the wait is still worth running — the others can arrive — and
        // refusing it would take a legitimate wait for process.exited away
        // because it happened to mention a file. What that wait must not do is
        // come back saying nothing happened without saying that this half of it
        // was never listening, so the sentence goes on the timeout instead.
        //
        // Measured on ARMED trees and not on nominated ones, because a
        // nomination is not a watch: a tree that is still arming, that the guest
        // called unwatchable, or that the host would not carry produces exactly
        // as many events as no tree at all. Counting one would let each of those
        // suppress the refusal below and hand back a timeout reading "nothing
        // happened".
        //
        // A function rather than a value, because it is asked AFTER the buffered
        // read and after the capability question, by which time a tree can have
        // armed. See the call site for why it is asked there.
        const unwatched = () =>
          Boolean(wanted?.has('file.changed')) && !sub.watching.some((w) => w.armed);
        const nominate = () => {
          const nominated = sub.watching.length;
          return nominated
            ? `file.changed is the one event nobody is sent unasked, and the ` +
                `${nominated === 1 ? 'tree' : 'trees'} nominated on ${id} ` +
                `${nominated === 1 ? 'is' : 'are'} not being watched yet — a nomination is accepted ` +
                `at once and the guest is asked afterwards, so there is a window in which no file ` +
                `event can arrive. wait_for_file_change is the call that waits through it and says ` +
                `which of the two you are in.`
            : `file.changed is the one event nobody is sent unasked: a directory has to be ` +
                `nominated on the connection, and nothing on ${id} has one. Use ` +
                `wait_for_file_change, which nominates the directory, waits until the guest is ` +
                `genuinely watching it, and then waits for a change. Once a tree is nominated its ` +
                `file.changed events arrive here like any other event.`;
        };
        const matches = (ev: ComputerEvent): boolean => {
          if (wanted && !wanted.has(ev.type)) return false;
          if (pid === undefined) return true;
          // A pid filter is about `process.exited` and says nothing about the
          // other types, so a wait for ["window.opened","process.exited"] with
          // a pid still ends on the window. Reading it as a filter over
          // everything would make one argument silently disable another.
          if (ev.type !== 'process.exited') return true;
          return (ev.data as Record<string, unknown> | undefined)?.pid === pid;
        };

        // Anything already buffered wins before capability is judged. An event
        // this computer has ALREADY sent is not one it cannot send, whatever a
        // later `capabilities` frame says about the guest as it now is.
        //
        // Asked as a function rather than computed once, because capability is
        // not a fact about the moment the wait STARTED. A `capabilities` frame
        // can land mid-wait and withdraw the very type being waited for — a
        // guest half going away is exactly when that happens — and the answer
        // this tool promises for a type the computer cannot emit is an
        // immediate refusal, not the same silence as a quiet computer. Computed
        // once, a withdrawal was indistinguishable from nothing happening and
        // the call sat until its timeout.
        const cannotEmit = (): string | undefined => {
          if (!wanted) return undefined;
          const can = sub.eventTypes;
          // An EMPTY list is not a computer that can emit nothing; it is a
          // `hello` that carried no `events` key, which `list(frame.events) ??
          // []` renders identically. Reading it as a refusal would end a healthy
          // wait the moment a reconnect landed on such a frame — and the
          // `capabilities` frame that follows can restore the list, since that
          // frame goes both ways. Unknown is not the same as none.
          if (!can?.length) return undefined;
          if (![...wanted].every((t) => !can.includes(t))) return undefined;
          return (
            `${id} cannot emit ${[...wanted].join(' or ')}. It reports it can emit: ` +
            `${can.join(', ')}. ${guestHalf(can)} Either way this wait could only ever have ` +
            `ended at its timeout.`
          );
        };

        let hit = await sub.waitFor(matches, AbortSignal.abort(), undefined, since);
        if (hit === undefined) {
          const already = cannotEmit();
          if (already) return refused(already);
        }
        // AFTER the buffered read and after the capability question, both of
        // which used to sit behind it. A `file.changed` that has already
        // arrived is still an answer even if the tree has since disarmed or
        // been evicted — anything buffered wins before anything about the
        // present is judged, which is the rule two lines up. And a computer
        // that cannot emit file.changed AT ALL is explained by `cannotEmit`;
        // sending that caller to wait_for_file_change would only have it
        // refused there for the reason this call already knew.
        if (hit === undefined && unwatched() && wanted?.size === 1) {
          return refused(
            `No file.changed can arrive on ${id}'s stream as it stands, however long you wait. ` +
              nominate(),
          );
        }
        if (hit === undefined) {
          // The capability question is asked on every wake rather than once
          // before the wait, because a `capabilities` frame can land inside it.
          // Such a frame wakes the waiter but is not an event, so a loop that
          // only re-ran the match saw nothing and parked again — and the answer
          // this tool promises for a type the computer cannot emit is an
          // immediate refusal, not the same silence a quiet computer produces.
          hit = await sub.waitFor(
            matches,
            deadline,
            extra.signal,
            since,
            () => cannotEmit() !== undefined,
          );
        }
        const waited = Math.round((Date.now() - started) / 1000);

        if (hit === undefined) {
          if (extra.signal?.aborted) {
            return refused(
              `Cancelled while waiting on ${id}. The stream is still open and still buffering — ` +
                `nothing was missed.`,
            );
          }
          const now = sub.state;
          if (now.status === 'stopped')
            return stopped(session, id, now.reason, sub, { since, limit });
          // Asked again, because the wait that just ended is long enough for a
          // `capabilities` frame to have arrived inside it. A withdrawal that
          // happened while parked is still the reason nothing came, and saying
          // so beats reporting a quiet few seconds on a computer that can no
          // longer produce this event at all.
          const withdrawn = cannotEmit();
          if (withdrawn) return refused(withdrawn);
          // NOT an error, and this is the one place this server's wait tools
          // differ from each other on purpose. `wait_for_computer` timing out
          // means the state it was told to wait for never arrived and may never;
          // this timing out means nothing happened in the last few seconds,
          // which is an answer, and it comes with the cursor that makes asking
          // again cost nothing. Reporting it as a failure would teach a model to
          // stop asking — back to the screenshot loop this tool exists to end.
          const d = sub.read({ since, limit });
          const extras = d.loss ? await reconcile(session, id, extra.signal) : {};
          // What did NOT match still happened, and this read has just handed it
          // over — so the sentence has to name it. Saying "nothing happened"
          // over a payload holding three events is the one thing a model must
          // not be told by a server whose whole promise is that it was
          // listening: it would read the prose, not the JSON, and the events
          // would be delivered and unmentioned in the same breath.
          const others = d.events.length
            ? ` ${d.events.length} other event${d.events.length === 1 ? '' : 's'} did happen and ` +
              `${d.events.length === 1 ? 'is' : 'are'} below.`
            : '';
          return said(
            `Nothing ${wanted ? `matching ${[...wanted].join(' or ')} ` : ''}happened on ${id} in ` +
              `${timeout_s}s.${others} This server kept listening the whole time and is still ` +
              `listening — nothing was missed and nothing is being missed now. Call again to ` +
              `keep waiting.` +
              // Said here rather than as a refusal, because the rest of this
              // wait was real: what must not happen is a model reading "nothing
              // happened" as covering a type nothing was ever going to send.
              (unwatched() ? ` One thing was NOT being waited for: ${nominate()}` : '') +
              (d.loss ? ' Some events were lost before they could be read — see lost.' : ''),
            { ...body(id, d, sub, sub.watching), ...extras },
          );
        }

        const d = sub.read({ since, limit, through: hit });
        const last = d.events[d.events.length - 1];
        const extras = d.loss ? await reconcile(session, id, extra.signal) : {};
        const before = d.events.length - 1;
        // Empty when another call on this computer consumed the matched event
        // first: the ring is one buffer with one delivered cursor, and two
        // overlapping waits can both match before either reads. Naming an event
        // over an empty list would be an event the caller is never shown.
        if (!last) {
          return said(
            `Something happened on ${id} and another call on this computer was handed it before ` +
              `this one could read it — the events are in that call's answer, not below. Nothing ` +
              `is lost; look there, or call again for whatever comes next.`,
            { ...body(id, d, sub, sub.watching), ...extras },
          );
        }
        return said(
          `${name(last)} on ${id} after ${waited}s` +
            (before > 0 ? `, and ${before} before it` : '') +
            '.' +
            (last.synthesized
              ? ' This one is synthesized: the desktop was ALREADY up when this stream attached, ' +
                'and computer.ready is announced once per desktop session — so the real event had ' +
                'happened before there was anything here to hear it, and waiting for it would have ' +
                'waited forever.'
              : ''),
          { ...body(id, d, sub, sub.watching), ...extras },
        );
      }),
  );

  /**
   * What one `file.changed` says, in a sentence.
   *
   * Three payload shapes wear one type, and the two that are not a file are the
   * ones a model will misread. `lost` is not a failure: it says this stream's
   * picture of the tree is incomplete and the tree is still being watched, so
   * the answer to it is to re-read the directory rather than to give up on the
   * watch. A tool that reported it as an error would teach a model to stop
   * watching a tree that is working.
   */
  const unwatchable = (wire: string): string =>
    `${wire} is not something this guest can watch: it is not there yet, is not a directory, ` +
    `cannot be read, or is a SYMLINK — links are refused rather than followed, because inotify ` +
    `pins whatever the link resolved to and repointing it afterwards produces no event at all. ` +
    `Name the real directory. Nominating one a job is about to create is fine and the nomination ` +
    `stands: the watch starts by itself when the directory appears, so calling again later will ` +
    `find it armed.`;

  /**
   * Why this tree is not one this call can answer about, if it is not.
   *
   * The four conditions the change wait abandons on, and the same four the two
   * waits ahead of it now give up on rather than parking through — so they have
   * to be reported the same way from both, in the same ORDER. Getting the order
   * wrong is not cosmetic: a tree withheld because the host would not carry it
   * is also a tree missing from the nomination set, so a membership check ahead
   * of the refusal check calls a rejected watch an eviction and tells the
   * caller somebody else's fifth directory pushed theirs out.
   *
   * `undefined` when none of them holds, which is when the tree really is just
   * still coming up.
   */
  const settled = (
    sub: Subscription,
    id: string,
    root: string,
    wire: string,
    // A FUNCTION, because a caller's tail can CONSUME something — the
    // once-only interruption note — and an argument is evaluated whether or not
    // this returns anything. Passed as a value it took that note on every call
    // that reached here and printed it only on the calls that settled, which is
    // the defect the note's own laziness exists to prevent, moved one frame up.
    tail: () => string,
    extras: Record<string, unknown> = {},
  ) => {
    const answer = { computer: id, watch: wire, watching: sub.watching, ...extras };
    if (sub.watchWasRefused(root)) {
      return refused(
        `${id} would not open an event stream carrying ${root}, so this server has stopped asking ` +
          `for it — it dropped the tree, the same stream opened without it, and that is how it ` +
          `knows. A watch is the one thing on that connection a host refuses outright, and it ` +
          `does so where a websocket client is told nothing at all, so the reason is one of two: ` +
          `this computer is already watching the 32 trees it will watch at once across every ` +
          `client connected to it, or it will not honour this path. Nominate a directory it is ` +
          `already watching, close another client, or use exec to look at this one.` +
          tail(),
        answer,
      );
    }
    if (!sub.nominates(root)) {
      return refused(
        `${wire} on ${id} stopped being watched while this call was waiting: another call ` +
          `nominated a fifth tree and this was the one it pushed out. Nothing can be said about ` +
          `whether it changed after that. Call again to nominate it back.` +
          tail(),
        answer,
      );
    }
    const can = sub.eventTypes;
    if (can?.length && !can.includes('file.changed')) {
      return refused(
        `${id} stopped being able to report file changes while this call was waiting — the guest ` +
          `half of its event stream was withdrawn, which is what a guest turning out to have no ` +
          `watcher looks like. It now reports it can emit: ${can.join(', ')}. Nothing can be said ` +
          `about whether ${wire} changed. Use exec to look at the directory.` +
          tail(),
        answer,
      );
    }
    if (sub.lostFor(root) === 'unwatchable') {
      return refused(unwatchable(wire) + tail(), answer);
    }
    return undefined;
  };

  const changeLine = (ev: ComputerEvent, id: string): string => {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    const lost = typeof d.lost === 'string' ? d.lost : '';
    if (lost === 'flood') {
      return (
        `${d.watch} on ${id} changed faster than this stream reports, so what happened is one ` +
        `marker instead of thousands of events. The watch is still on and the tree is still being ` +
        `watched — this is not a failure and there is nothing to fix. What it costs you is your ` +
        `picture of the tree: list the directory with exec to re-read it, and carry on waiting. A ` +
        `build under a watched path does this every time.`
      );
    }
    if (lost === 'budget') {
      return (
        `${d.watch} on ${id} is bigger than the directory budget one watch gets, so part of it is ` +
        `not being watched at all and changes down there will never be reported. This one does ` +
        `not clear by waiting: call again with a narrower path — the subdirectory you actually ` +
        `care about — and re-read the tree with exec for what you missed.`
      );
    }
    if (lost) {
      return (
        `${d.watch} on ${id} reported ${JSON.stringify(lost)}, which this build does not know the ` +
        `meaning of. Treat any non-empty lost as "my picture of this tree is wrong" and re-read ` +
        `the directory with exec.`
      );
    }
    return `${d.kind} ${d.path}${d.dir ? ' (a directory)' : ''} on ${id}`;
  };

  server.registerTool(
    'wait_for_file_change',
    {
      title: 'Wait for a file to change',
      description:
        'Block until something is created, changed or deleted anywhere under a directory in the guest, instead of running ls in a loop to find out whether it has. This is how you wait for a build to write its output, a download to land, or a script to produce a file. ' +
        'It nominates the directory on this computer\'s event stream, waits until the guest is genuinely watching it, and only then waits for a change — so a timeout from this tool means nothing changed, never "nothing was watching yet". ' +
        `The nomination sticks: up to ${MAX_WATCHES} trees stay watched across your turns, so a second call on the same path is instant and a change that happens between two of your turns is still waiting for you. ` +
        'Nominate the NARROWEST directory you care about. A home directory under a build is thousands of changes a second, and what you get back for one of those is a single "too much changed" marker rather than the events. ' +
        'It reports changes, not contents: read_file and exec are still how you find out what is in a file. A rename inside the tree arrives as a delete and a create, and nothing is announced about what was already there when you nominated it — list the directory for that.',
      inputSchema: {
        ...idArg,
        path: z
          .string()
          .describe(
            'An absolute directory in the guest, watched all the way down. Not a file and not a glob — name the directory and filter the changes yourself. A trailing slash or a . segment is cleaned away, and the cleaned form is what the events carry.',
          ),
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_S)
          .default(30)
          .describe(
            'How long this call may take in total, attaching and arming included — not time spent watching, which is less and is reported back. Capped below the 60s request timeout most MCP clients ship. A call that spends it all arming says so rather than reporting a quiet directory, and nothing is missed by a short wait: the tree stays watched between calls, so call again.',
          ),
        since: z
          .string()
          .optional()
          .describe(
            'A cursor from an earlier call, to start from there instead of from where this session last read. You do not normally need it.',
          ),
        limit: z.number().int().min(1).max(500).default(100),
      },
      // Not readOnlyHint, for the two reasons the tools above are not. This
      // CONSUMES — `sub.read()` advances the model's place in the buffer — and
      // it also CONFIGURES: a nomination reopens the stream and can push another
      // tree out of the watch set. A client treating the hint as licence to
      // retry a call that timed out would silently drop events and, on the
      // fifth distinct path, silently stop watching the first.
    },
    ({ computer_id, path, timeout_s, since, limit }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        // Before anything is opened. A path this host will not accept is a 400
        // on the UPGRADE, and a failed upgrade reaches a websocket client as an
        // error with no status and no body — indistinguishable from a host that
        // is down. Sent optimistically it would be a reconnect loop under
        // "could not open the event stream" for a mistake visible from here.
        let root: string;
        try {
          root = cleanWatchPath(path);
        } catch (err) {
          return refused(
            `${err instanceof Error ? err.message : String(err)} Nothing was opened and nothing on ` +
              `${id} was changed by this call.`,
          );
        }
        const renamed =
          root === path
            ? ''
            : ` ${JSON.stringify(path)} is the same directory as ${root}, which is the spelling ` +
              `every event carries — match on that one.`;

        const sub = session.events.open(id);
        const deadline = AbortSignal.timeout(timeout_s * 1000);
        const started = Date.now();
        await attached(sub, extra.signal, deadline);
        const opening = sub.state;
        if (opening.status === 'stopped') {
          return stopped(session, id, opening.reason, sub, { since, limit });
        }
        if (extra.signal?.aborted) return cancelledDuringAttach(id);
        if (!sub.eventTypes) return unattached(id, Date.now() - started);

        // Asked before the tree is nominated, because a computer that cannot
        // report file changes will accept the nomination and then say nothing,
        // which is the silence this whole tool exists to not produce. An EMPTY
        // list is unknown rather than none — see the same reading in
        // wait_for_event.
        const can = sub.eventTypes;
        if (can.length && !can.includes('file.changed')) {
          return refused(
            `${id} cannot emit file.changed, so nothing here can watch a directory on it. It ` +
              `reports it can emit: ${can.join(', ')}. ${guestHalf(can)} To find out whether a ` +
              `file has appeared on this computer, run ls with exec.`,
          );
        }

        const nomination = sub.nominate(root);
        const evicted = nomination.evicted
          ? ` ${nomination.evicted} is no longer being watched: a stream watches at most ` +
            `${MAX_WATCHES} trees and it was the one you had asked about least recently. Nominate ` +
            `it again if you still need it.`
          : '';
        // A new tree reopens the connection, so what this call waits for is the
        // OPEN connection carrying it and having greeted — not merely the next
        // opening frame, which can belong to a reconnect that was already in
        // flight when the nomination was made and never carried it. `attached`
        // above cannot serve either: it is satisfied by the frame this
        // connection has already had.
        if (!sub.nominationLive(root)) {
          await sub.nominated(root, deadline, extra.signal);
          const after = sub.state;
          if (after.status === 'stopped') {
            return stopped(session, id, after.reason, sub, { since, limit });
          }
          if (extra.signal?.aborted) return cancelledWhileArming(id, root);
          // ASKED FIRST, all four of them, because each is an answer and the
          // timeout below is only the absence of one. A tree the host would not
          // carry, one another call evicted, or a computer that has stopped
          // being able to report file changes at all are none of them "the
          // stream has not come back yet".
          const settledEarly = settled(sub, id, root, sub.hostPath(root), () => renamed + evicted);
          if (settledEarly) return settledEarly;
          if (!sub.nominationLive(root)) {
            return refused(
              `Could not start watching ${root} on ${id} within ${timeout_s}s. The stream has to ` +
                `be reopened to carry a new tree and the new connection has not come back yet, so ` +
                `this is not an answer about the directory — nothing was watching it. This server ` +
                `is still reconnecting between your turns; call again, and give it longer.` +
                evicted,
            );
          }
        }
        // A host that predates file watches ignores `&watch=` rather than
        // refusing it, so the socket opens, nothing is watched, and no event
        // ever arrives. That silence is indistinguishable from a quiet
        // directory, and the opening frame is the only place it can be told
        // apart — so it is told apart here rather than at a timeout.
        if (sub.watchesHonoured === false) {
          return refused(
            `${id} opened its event stream but said nothing about ${root}, so this server cannot ` +
              `tell whether the tree is being watched — and a wait would be a wait on silence. The ` +
              `host holding this computer may predate file watches (platform OPL-3927). Use exec ` +
              `to look at the directory instead.` +
              evicted,
          );
        }

        const wire = sub.hostPath(root);
        if (!sub.isArmed(root)) await sub.armedWait(root, deadline, extra.signal);
        if (!sub.isArmed(root)) {
          const now = sub.state;
          if (now.status === 'stopped')
            return stopped(session, id, now.reason, sub, { since, limit });
          if (extra.signal?.aborted) return cancelledWhileArming(id, wire);
          // Asked before the sentence below, all four of them, because that
          // sentence says the nomination stands and this tree is still coming
          // up — and every word of it is false when the tree has been evicted
          // by another call, given up on as one this host will not carry, or
          // when the computer has stopped being able to report file changes.
          const why = settled(sub, id, root, wire, () => renamed + evicted);
          if (why) return why;
          // The one answer this tool must never give as "nothing changed".
          // inotify reports changes and not state, so anything that happened
          // before the watch armed was never reported and never will be —
          // saying nothing changed over that window would be a claim about a
          // stretch of time during which nobody was looking.
          return refused(
            `${wire} on ${id} is not being watched yet after ${Math.round((Date.now() - started) / 1000)}s, ` +
              `so NOTHING can be said about whether it changed. Arming is not instant: the guest ` +
              `has to be asked, and on a computer nobody has opened a terminal on the watcher is ` +
              `installed into the guest first. It is still coming up and the nomination stands — ` +
              `call again and it will be waiting properly. Do not read this as "nothing changed".` +
              renamed +
              evicted,
            { computer: id, watch: wire, watching: sub.watching },
          );
        }

        // Taken after the tree is confirmed live, so the arming this call
        // waited for is not the one it abandons on. A LATER arming is news: it
        // says the watch was interrupted and is reporting from here, so
        // whatever happened in between was never reported and the tree has to
        // be re-read.
        const generation = sub.armGeneration(root);
        // Said once, on the first answer about a tree this subscription
        // inherited from one that went away. A tree is watched by the
        // CONNECTION, so the idle reap that took the previous subscription also
        // stopped the guest watching it — and inotify reports changes and not
        // state, so nothing that happened in between was recorded anywhere for a
        // replay to hand back. Re-nominating gets the watch going again and says
        // nothing about the hole, which would leave a model reading an entirely
        // ordinary "nothing changed" over minutes during which nothing looked.
        // A FUNCTION, and the flag is taken where the note is RENDERED rather
        // than here. Taken up front it was consumed by every answer this call
        // could give and printed by only some of them — a cancel, a stream
        // between connections, a tree another call had evicted — so the one
        // thing it exists to say was thrown away, and the next call, which is
        // the one that finally reports a quiet directory, had nothing to say
        // about the minutes during which nothing was watching. This way an
        // answer that does not print it defers it rather than losing it.
        const interrupted = () =>
          sub.takeInterruption(root)
            ? ` Note: this tree was NOT being watched between an earlier call and this one — the ` +
              `stream carrying it was closed for want of anything asking about this computer, and ` +
              `a watch lives on the connection. Anything that changed in that window was never ` +
              `reported and cannot be. Re-read the directory with exec if it matters.`
            : '';
        // When the waiting actually started, which is not when the call did.
        // `timeout_s` bounds the whole call — it has to, because a client
        // cancels a request that outlives its own timeout — so a call that
        // spent most of it attaching and arming watched for less than it asked
        // for, and saying otherwise would overstate the window this answer
        // covers.
        const armedAt = Date.now();
        // A `capabilities` frame can withdraw the guest half mid-wait; a guest
        // that turns out to have no watcher is exactly when that happens. The
        // frame wakes every parked waiter but is not an event, so a loop that
        // only re-ran the match would see nothing, park again, and sit out the
        // deadline on a computer that could no longer produce what it was
        // waiting for. `wait_for_event` asks the same question for the same
        // reason.
        const withdrawn = (): boolean => {
          const types = sub.eventTypes;
          // An EMPTY list is unknown rather than none — a `hello` that carried
          // no `events` key reads identically — so it is not a withdrawal. The
          // same reading as wait_for_event's.
          return Boolean(types?.length) && !types?.includes('file.changed');
        };
        const isChange = (ev: ComputerEvent): boolean => {
          if (ev.type !== 'file.changed') return false;
          const d = ev.data as Record<string, unknown> | undefined;
          if (d?.watch !== wire) return false;
          if (typeof d.lost === 'string' && d.lost) return true;
          return typeof d.path === 'string' && Boolean(d.path);
        };
        const hit = await sub.waitFor(
          isChange,
          deadline,
          extra.signal,
          since,
          // Four ways for a wait to stop being about the tree it started on,
          // and every one of them is an answer rather than silence. A re-arm
          // says reporting begins again HERE, so the gap was never reported. A
          // disarm says the tree is not being watched at all any more. An
          // eviction says another call took its place in the watch set. A
          // withdrawn capability says this computer can no longer report file
          // changes whatever is nominated. Any of the four run to the deadline
          // would come back as "nothing changed under this tree", which is the
          // sentence this whole tool exists not to say about a window nobody
          // was watching.
          () =>
            sub.armGeneration(root) !== generation ||
            !sub.isArmed(root) ||
            !sub.nominates(root) ||
            withdrawn(),
        );
        const waited = Math.round((Date.now() - armedAt) / 1000);

        if (hit === undefined) {
          if (extra.signal?.aborted) {
            // Deliberately not "the tree is still being watched", which this
            // call did not check and which a cancel racing an eviction or a
            // shed makes false. What IS true is the part that matters: the
            // buffer is on this side and nothing in it went anywhere.
            return refused(
              `Cancelled while waiting on ${wire}. Nothing was missed by the cancellation — this ` +
                `server holds the stream and its buffer between calls — but nothing was checked ` +
                `about the watch either, so call again for an answer about the tree.` +
                interrupted(),
            );
          }
          const now = sub.state;
          if (now.status === 'stopped')
            return stopped(session, id, now.reason, sub, { since, limit });
          const d = sub.read({ since, limit });
          const extras = d.loss ? await reconcile(session, id, extra.signal) : {};
          const answer = { ...body(id, d, sub, sub.watching), watch: wire, ...extras };
          // THESE FIRST, and in this order, because each would otherwise be
          // described as something else. Evicting a tree does not reset its arm
          // generation — that is kept monotonic on purpose — but it does take
          // the tree out of the watch set, and the generation branch below would
          // call that a re-arm and invite the caller to go on waiting on a tree
          // nothing nominates. A tree the host would not carry is missing from
          // the set for a quite different reason, which is why the refusal is
          // asked about ahead of the membership.
          const why = settled(sub, id, root, wire, () => interrupted() + evicted, {
            ...body(id, d, sub, sub.watching),
            ...extras,
          });
          if (why) return why;
          if (sub.armGeneration(root) !== generation) {
            return said(
              `The watch on ${wire} was re-armed after an interruption — a stop and a start, a ` +
                `guest reboot, a broker replaced. Reporting starts again HERE, and nothing that ` +
                `happened to the tree while it was down was reported or ever will be. Re-read the ` +
                `directory with exec if that window matters, then call again to keep waiting.` +
                interrupted() +
                evicted,
              answer,
            );
          }
          if (!sub.isArmed(root)) {
            return refused(
              `${wire} on ${id} stopped being watched while this call was waiting, so NOTHING can ` +
                `be said about whether anything changed under it after that — do not read this as ` +
                `"nothing changed". The stream is being reopened here and the nomination stands; ` +
                `call again and it will be waiting properly.` +
                interrupted() +
                evicted,
              answer,
            );
          }
          // A tree that does not FIT its watch is not a tree a silence is an
          // answer about. `budget` says part of it is not being watched at all,
          // permanently, and unlike a flood that does not clear by waiting — so
          // every later call would otherwise report a confident "nothing
          // changed" over a subtree nobody is looking at.
          if (sub.lostFor(root) === 'budget') {
            return refused(
              `Nothing changed in the part of ${wire} that is being watched, but that is not the ` +
                `whole tree: it is bigger than the directory budget one watch gets, so changes ` +
                `deeper in it are not reported and a silence here is not an answer about the ` +
                `directory. This does not clear by waiting. Call again with a narrower path — the ` +
                `subdirectory you actually care about — and re-read this one with exec.` +
                interrupted() +
                renamed,
              answer,
            );
          }
          // The stream can be between connections at this instant, and a tree on
          // a connection that is not up is not one being watched — however
          // briefly. Claiming otherwise is the half of the sentence below that
          // can actually be checked, so it is checked.
          if (!sub.watchLive(root)) {
            return refused(
              `The event stream for ${id} is reopening, so ${wire} is not being watched at this ` +
                `moment and nothing can be said about the last few seconds — do not read this as ` +
                `"nothing changed". The nomination stands and this server is still reconnecting ` +
                `between your turns; call again.` +
                interrupted() +
                evicted,
              answer,
            );
          }
          // NOT an error, for the reason wait_for_event's timeout is not: the
          // tree was being watched for the whole of it, so "nothing changed" is
          // an answer rather than an absence of one. This is the sentence the
          // arming gate above exists to make true — and the interval is the one
          // actually spent watching, not the timeout that was asked for.
          const others = d.events.length
            ? ` ${d.events.length} other event${d.events.length === 1 ? '' : 's'} did happen and ` +
              `${d.events.length === 1 ? 'is' : 'are'} below.`
            : '';
          return said(
            `Nothing changed under ${wire} on ${id} in the ${waited}s it spent watching.${others} ` +
              `The tree was being watched for the whole of that and still is, so this is an ` +
              `answer rather than a gap. Call again to keep waiting; nothing is missed between ` +
              `calls.` +
              interrupted() +
              renamed +
              evicted +
              (d.loss ? ' Some events were lost before they could be read — see lost.' : ''),
            answer,
          );
        }

        const d = sub.read({ since, limit, through: hit });
        const last = d.events[d.events.length - 1];
        const extras = d.loss ? await reconcile(session, id, extra.signal) : {};
        const earlier = d.events.length - 1;
        // The one `lost` that is not a re-read: it says the tree is not being
        // watched, so it is the request failing rather than the watch reporting.
        // It arrives as an ordinary file.changed and would otherwise be
        // described by changeLine, which has nothing useful to say about it.
        if (((last?.data as Record<string, unknown> | undefined)?.lost ?? '') === 'unwatchable') {
          return refused(
            `${unwatchable(wire)} It was being watched until now; from here it is not.` +
              interrupted() +
              renamed +
              evicted,
            { ...body(id, d, sub, sub.watching), watch: wire, ...extras },
          );
        }
        // A `through` read can come back empty when another call on this
        // computer consumed the matched event first — the ring is one buffer
        // with one delivered cursor, and two overlapping waits can both match
        // before either reads. Announcing "a change" over an empty list would be
        // a change the caller is never shown.
        if (!last) {
          return said(
            `Something changed under ${wire} on ${id}, and another call on this computer was ` +
              `handed it before this one could read it — the events are in that call's answer, ` +
              `not below. Nothing is lost; look there, or call again for whatever comes next.` +
              interrupted() +
              renamed +
              evicted,
            { ...body(id, d, sub, sub.watching), watch: wire, ...extras },
          );
        }
        return said(
          `${changeLine(last, id)} after ${waited}s` +
            (earlier > 0 ? `, and ${earlier} event${earlier === 1 ? '' : 's'} before it` : '') +
            '.' +
            interrupted() +
            renamed +
            evicted,
          { ...body(id, d, sub, sub.watching), watch: wire, ...extras },
        );
      }),
  );

  server.registerTool(
    'poll_events',
    {
      title: 'Read what has happened',
      description:
        'Everything the computer has reported that you have not been handed yet, without waiting. This server holds the event stream open between your turns, so this drains what accumulated while you were doing something else — including while you were running other tools on the same machine. Use it after a long exec, or whenever you want to know what changed without spending a screenshot. Returns immediately, and an empty list genuinely means nothing has happened.',
      inputSchema: {
        ...idArg,
        since: z
          .string()
          .optional()
          .describe(
            'A cursor from an earlier call. Omit it and you get everything since the last time you read, which is what you usually want.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe(
            'At most this many, oldest first. The rest stay buffered and come back on the next call — more_waiting says how many.',
          ),
      },
      // Deliberately not readOnlyHint, for the reason exec_poll is not: both of
      // these CONSUME. `sub.read()` advances the model's place in the buffer, so
      // the events it returns are events no later call can return. Clients treat
      // the hint as licence to call without asking and to retry a call that
      // timed out, and a retried read silently drops whatever the first attempt
      // had already taken — the same defect one tool over, with a ring in this
      // session instead of a cursor in the guest. Nothing is created and nothing
      // is destroyed, which is what made the annotation look right.
    },
    ({ computer_id, since, limit }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const sub = session.events.open(id);
        // The one thing this tool waits for. Opening a socket takes a round
        // trip for the URL and another for the handshake, and a first call that
        // answered "nothing has happened" before either had finished would be
        // saying something it does not know.
        const started = Date.now();
        await attached(sub, extra.signal);
        const state = sub.state;
        if (state.status === 'stopped') {
          return stopped(session, id, state.reason, sub, { since, limit });
        }
        if (extra.signal?.aborted) return cancelledDuringAttach(id);
        if (!sub.eventTypes) return unattached(id, Date.now() - started);

        const d = sub.read({ since, limit });
        const extras = d.loss ? await reconcile(session, id, extra.signal) : {};
        if (!d.events.length) {
          // The one case where "this is an answer rather than a gap" is exactly
          // wrong: a gap whose surviving events were all read already leaves an
          // empty batch beside a real hole. The reconciled state is attached
          // either way; the sentence has to agree with it.
          if (d.loss) {
            return said(
              `Nothing new on ${id} that survived — there is a hole in the history here, and what ` +
                `was in it is gone.${reconciled(extras)}`,
              { ...body(id, d, sub, sub.watching), ...extras },
            );
          }
          return said(
            `Nothing new on ${id}. The stream is open and buffering, so this is an answer rather ` +
              `than a gap: nothing has been reported since you last read.`,
            { ...body(id, d, sub, sub.watching), ...extras },
          );
        }
        const kinds = [...new Set(d.events.map((e) => e.type))].join(', ');
        return said(
          `${d.events.length} event${d.events.length === 1 ? '' : 's'} on ${id}: ${kinds}.` +
            (d.more
              ? ` ${d.more} more ${d.more === 1 ? 'is' : 'are'} buffered — call again for ${d.more === 1 ? 'it' : 'them'}.`
              : ''),
          { ...body(id, d, sub, sub.watching), ...extras },
        );
      }),
  );
};
