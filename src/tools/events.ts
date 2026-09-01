import { z } from 'zod';
import type { ComputerEvent, Delivery, Subscription } from '../events.js';
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

/** One event's type and the thing about it worth putting in a sentence. */
function name(ev: ComputerEvent): string {
  const data = (ev.data ?? {}) as Record<string, unknown>;
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

/** The body both tools answer with, minus the keys there is nothing to say about. */
function body(id: string, d: Delivery): Record<string, unknown> {
  const out: Record<string, unknown> = { computer: id, events: d.events, cursor: d.cursor };
  if (d.more) out.more_waiting = d.more;
  if (d.loss) out.lost = d.loss;
  // Only where it is news. `can_emit` is what stops a model waiting for
  // something this machine will never produce, and the opening frame is the one
  // place that answer exists — but repeating it on every poll would be a field
  // that means nothing on the ninety-ninth call.
  if (d.attached && d.hello) {
    out.can_emit = d.hello.events;
    if (d.hello.windows) out.windows_on_attach = d.hello.windows;
  }
  return out;
}

/**
 * A subscription that has stopped, said once, with whatever it was still
 * holding, and with what to do about it.
 *
 * Dropped as it is reported, and that is what makes the last sentence true. A
 * stopped subscription would otherwise sit in the hub until the idle sweep took
 * it, answering "suspended" for five minutes after `start_computer` had already
 * fixed it — a model told to fix something, doing so, and being told the same
 * thing again is a model that stops believing the tool. The cursor is kept, so
 * the stream that opens next resumes rather than restarts.
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
 */
function stopped(
  session: Session,
  id: string,
  reason: string,
  sub: Subscription,
  read: { since?: string; limit: number },
) {
  const d = sub.read(read);
  session.events.drop(id, reason, true);
  const n = d.events.length;
  const held = n
    ? `${n} event${n === 1 ? '' : 's'} had already arrived before it stopped and ${n === 1 ? 'is' : 'are'} ` +
      `below — ${n === 1 ? 'it is' : 'they are'} the last this stream has. `
    : '';
  return refused(
    `${held}The event stream for ${id} is not running: ${reason}. Fix the cause and call again: the next ` +
      `call opens a fresh stream and resumes from the last event you were handed, so whatever the ` +
      `platform can still replay you will still be given, and whatever it cannot comes back as a ` +
      `stated gap rather than as silence.`,
    n || d.loss ? body(id, d) : undefined,
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
            `${can.join(', ')}. A guest with nowhere to run its watcher — a ` +
            `Windows one, or a Linux one whose hardware carries no terminal channel — never ` +
            `produces the guest-reported half of this stream, so this wait could only ever ` +
            `have ended at its timeout. Use screenshot and list_windows on this computer.`
          );
        };

        let hit = await sub.waitFor(matches, AbortSignal.abort(), undefined, since);
        if (hit === undefined) {
          const already = cannotEmit();
          if (already) return refused(already);
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
              (d.loss ? ' Some events were lost before they could be read — see lost.' : ''),
            { ...body(id, d), ...extras },
          );
        }

        const d = sub.read({ since, limit, through: hit });
        const last = d.events[d.events.length - 1];
        const extras = d.loss ? await reconcile(session, id, extra.signal) : {};
        const before = d.events.length - 1;
        return said(
          `${last ? name(last) : 'An event'} on ${id} after ${waited}s` +
            (before > 0 ? `, and ${before} before it` : '') +
            '.' +
            (last?.synthesized
              ? ' This one is synthesized: the desktop was ALREADY up when this stream attached, ' +
                'and computer.ready is announced once per desktop session — so the real event had ' +
                'happened before there was anything here to hear it, and waiting for it would have ' +
                'waited forever.'
              : ''),
          { ...body(id, d), ...extras },
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
                `was in it is gone. See lost for what is known about it, and windows_now and ` +
                `computer_now for where the computer actually stands, which is what the missing ` +
                `events would have told you.`,
              { ...body(id, d), ...extras },
            );
          }
          return said(
            `Nothing new on ${id}. The stream is open and buffering, so this is an answer rather ` +
              `than a gap: nothing has been reported since you last read.`,
            { ...body(id, d), ...extras },
          );
        }
        const kinds = [...new Set(d.events.map((e) => e.type))].join(', ');
        return said(
          `${d.events.length} event${d.events.length === 1 ? '' : 's'} on ${id}: ${kinds}.` +
            (d.more ? ` ${d.more} more are buffered — call again for them.` : ''),
          { ...body(id, d), ...extras },
        );
      }),
  );
};
