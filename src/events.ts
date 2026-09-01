/**
 * What a computer is doing, held open on this side of the model.
 *
 * `GET computers/:id/events` (platform OPL-3785) is a websocket that says what
 * a computer is doing without being asked, so that an agent stops paying for a
 * screenshot to learn that nothing has changed. Every other client of that
 * stream hands it to its caller as an iterator, because every other caller sits
 * in a loop. A model does not: it takes turns, and between two turns there is
 * nobody here to read a socket.
 *
 * So the socket lives HERE, in the session, and the model holds nothing but a
 * cursor. One connection per computer, opened the first time a tool asks about
 * it, kept across turns, reaped when nothing has asked for a while. What
 * arrives while the model is thinking goes into a bounded ring, and the next
 * `poll_events` or `wait_for_event` is handed it in order. The model never
 * learns that a socket exists.
 *
 * That is the whole of OPL-3926's decision, and the alternative it rejects is
 * worth naming: an MCP `resources/subscribe` and a `notifications/*` doorbell.
 * The spec's notification filter is a closed vocabulary — `toolsListChanged`,
 * `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions` — with
 * no channel for a server's own domain events, so a `window.opened` could only
 * ride in as `resources/updated` on some URI, and that notification carries a
 * URI and no payload. The model would still have to read. Which makes the
 * doorbell an addition to this file rather than a replacement for it, and one
 * whose bell nothing on the other end rings yet.
 *
 * Written against the `events_url` entry in the platform's `web/lib/apidoc.ts`,
 * which is the reference this must not contradict.
 */

import { WebSocket as UndiciWebSocket } from 'undici';
import type { Api } from './api.js';
import { isTransientForPoll, MandalaError } from './errors.js';
import { type Computer, unwrapComputer } from './format.js';
import * as P from './paths.js';

/**
 * The part of a `WebSocket` this file uses.
 *
 * Structural rather than a named class, so undici's, the global one and a
 * test's stand-in all satisfy it without any of them being imported at the call
 * site. Nothing here ever sends: the stream is one-way, and the reference says
 * nothing a client writes to it means anything.
 */
export type EventSocket = {
  addEventListener(type: 'open', fn: () => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', fn: () => void): void;
  addEventListener(type: 'close', fn: () => void): void;
  close(): void;
};

export type EventSocketFactory = (url: string) => EventSocket;

/**
 * undici's `WebSocket`, not Node's global one.
 *
 * The same choice `api.ts` makes about `fetch` and for a plainer reason: this
 * package already depends on undici, `engines` says Node 20.3 and the global
 * `WebSocket` did not arrive unflagged until Node 22. A server that worked on
 * the Node it claims to support for every tool except these two would be a
 * worse failure than not shipping them, because it only appears at the moment
 * somebody waits for something.
 */
export const defaultEventSocket: EventSocketFactory = (url) =>
  new UndiciWebSocket(url) as unknown as EventSocket;

/**
 * One frame off the stream, as the platform wrote it.
 *
 * Deliberately NOT re-shaped into a typed union the way the SDKs do. What
 * reads this is a model reading JSON, so the platform's own spelling is the
 * one worth handing over — and the reference promises the vocabulary grows,
 * so a frame this build has never heard of has to arrive intact rather than be
 * flattened into whatever fields this file happened to know about.
 */
export type ComputerEvent = Record<string, unknown> & { type: string };

/** The opening frame, once per connection. */
export type Hello = {
  computer: string;
  cursor: string;
  /** Whether the desktop has ALREADY been announced ready for the session it is in. */
  ready: boolean;
  /** What THIS computer can emit — not everything the platform knows how to. */
  events: string[];
  /** The desktop as this host last saw it. Absent when a cursor was honoured. */
  windows?: unknown[];
};

/**
 * The frames that are statements about the STREAM rather than about the
 * computer.
 *
 * None of the three is delivered as an event here, which is the second half of
 * OPL-3926's decision. A model handed a `gap` frame — a type it has no
 * procedure for, on a client the reference cannot tell to "reconcile with a
 * listing" — will invent a recovery procedure. So a gap is answered inline
 * instead: see {@link Subscription.loss} and the state the tools attach to it.
 */
const STREAM_FRAMES = new Set(['gap', 'closed', 'capabilities']);

/** How many events one computer may hold for a model that has not read them. */
export const MAX_BUFFERED = 1024;

/** How long a subscription nothing has asked about is kept open. */
export const IDLE_REAP_MS = 5 * 60_000;

/** How often the hub looks for one to reap. */
const SWEEP_MS = 60_000;

/** First backoff step after a failed connection, doubling to {@link MAX_BACKOFF_MS}. */
const BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/** How long a connection has to reach its opening frame. */
const CONNECT_TIMEOUT_MS = 20_000;

type Buffered = { index: number; event: ComputerEvent };

/** What a read of the buffer hands back. */
export type Delivery = {
  events: ComputerEvent[];
  /** Where the caller is now, to pass back as `since`. */
  cursor: string;
  /** Events that were in the buffer and are not in this batch. Nothing is lost. */
  more: number;
  /**
   * What was lost before it could be read, and why — `undefined` when nothing
   * was. `events: null` is a number this server does not know rather than none:
   * a platform gap says the history is short, not how short.
   */
  loss?: Loss;
  /** The opening frame of the connection now open, if one has landed. */
  hello?: Hello;
  /** True on the first read of a subscription: the caller has no earlier place. */
  attached: boolean;
};

export type Loss = { events: number | null; reason: string };

/** Whether a subscription can still be expected to produce anything. */
export type SubscriptionState =
  | { status: 'connecting' | 'open' }
  /** Nothing more will arrive, and reopening would answer the same way. */
  | { status: 'stopped'; reason: string };

/**
 * One computer's event stream, held across turns.
 *
 * Single-consumer, like the session it belongs to. It keeps its own place in
 * the platform's stream so that a socket which drops mid-turn resumes rather
 * than restarts, and it keeps the model's place in the buffer so that a model
 * which asks nothing for four turns is still handed what happened during them.
 */
export class Subscription {
  readonly computerId: string;
  readonly #api: Api;
  readonly #socketFor: EventSocketFactory;

  #ring: Buffered[] = [];
  /** The index the next arriving event will be given. Never reused. */
  #nextIndex = 0;
  /** The index after the last event handed to the model. */
  #delivered = 0;
  /** Set once the model has read anything at all, so a first read can say so. */
  #read = false;
  #loss?: Loss;
  /** The platform cursor to resume from: after the last event RECEIVED. */
  #resume?: string;
  /**
   * Where this stream began, as a platform cursor.
   *
   * The seeded `since`, or the first opening frame's own cursor. It is what a
   * NEW subscription for this computer has to resume from when the model was
   * never handed anything, so that a buffer thrown away by a reap is replayed
   * rather than skipped.
   */
  #start?: string;
  /** The cursor after the last event actually handed to the model. */
  #deliveredCursor?: string;
  #hello?: Hello;
  #types?: string[];
  #state: SubscriptionState = { status: 'connecting' };
  #wake = new Set<() => void>();
  #socket?: EventSocket;
  #abort = new AbortController();
  #lastUsed = Date.now();
  #running = false;

  constructor(api: Api, computerId: string, socketFor: EventSocketFactory, since?: string) {
    // Never `extra.signal`. A subscription outlives the tool call that opened
    // it by design, and binding it to that call's signal would close the socket
    // the moment the turn that opened it ended — which is every turn.
    this.#api = api;
    this.computerId = computerId;
    this.#socketFor = socketFor;
    // Where a previous subscription for this computer had got to, if the hub
    // still remembers one. The first connection then asks the platform to
    // replay from there rather than joining at the head — see
    // {@link EventHub.open}, which is where that memory lives.
    this.#resume = since;
    this.#start = since;
  }

  /**
   * Where a REPLACEMENT for this subscription should start.
   *
   * The position after the last event the MODEL was handed — deliberately not
   * `#resume`, which is after the last event this SOCKET received. The two are
   * the same only when the model is caught up, and the case where they differ
   * is the case this exists for: events arrive, the model is busy on another
   * computer, the idle sweep reaps the subscription and its ring goes with it.
   * Handing the replacement `#resume` there would ask the platform to replay
   * from AFTER the unread events — losing exactly what the memory was meant to
   * preserve, and losing it silently, since a `since` the platform can honour
   * produces no gap.
   *
   * Before anything has been delivered the answer is where this stream began,
   * which replays the whole buffer.
   */
  get resumeCursor(): string | undefined {
    return this.#deliveredCursor ?? this.#start;
  }

  get state(): SubscriptionState {
    return this.#state;
  }

  get idleMs(): number {
    return Date.now() - this.#lastUsed;
  }

  /** What this computer can emit, as last stated. `undefined` before `hello`. */
  get eventTypes(): string[] | undefined {
    return this.#types ? [...this.#types] : undefined;
  }

  /** Mark it in use, so the idle sweep leaves it alone. */
  touch(): void {
    this.#lastUsed = Date.now();
  }

  /** Open the socket, if it is not already open. Returns at once. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#run();
  }

  /** Close the socket and stop reconnecting. The buffer goes with it. */
  close(reason = 'the subscription was closed'): void {
    this.#abort.abort();
    this.#state = { status: 'stopped', reason };
    this.#socket?.close();
    this.#socket = undefined;
    this.#wakeAll();
  }

  /** The index of the oldest event still buffered. */
  get #oldest(): number {
    return this.#ring.length ? this.#ring[0].index : this.#nextIndex;
  }

  /**
   * Everything the model has not been handed, oldest first.
   *
   * `since` is an override rather than the ordinary way in. A model that passes
   * nothing gets what it has not seen, which is what "what happened while I was
   * thinking" means and is the call that cannot be got wrong; a model that
   * keeps a cursor can rewind or resume with one. Both are the same position in
   * the end — this class holds it either way.
   */
  read(opts: { since?: string; limit: number; through?: number } = { limit: 100 }): Delivery {
    this.touch();
    const attached = !this.#read;
    this.#read = true;

    const from = this.resolveFrom(opts.since);
    const end = opts.through !== undefined ? opts.through + 1 : this.#nextIndex;
    const window = this.#ring.filter((b) => b.index >= from && b.index < end);
    // The OLDEST `limit`, not the newest, and the position advances only over
    // what is actually returned — so a batch that does not fit leaves the rest
    // buffered for the next call rather than dropping it. `through` is the one
    // exception: a wait has already promised to return the event it matched, so
    // it keeps the tail and says how much of the head it had to leave behind.
    let batch = window;
    let omitted = 0;
    if (window.length > opts.limit) {
      if (opts.through !== undefined) {
        batch = window.slice(window.length - opts.limit);
        omitted = window.length - opts.limit;
      } else {
        batch = window.slice(0, opts.limit);
      }
    }

    const last = batch.length ? batch[batch.length - 1] : undefined;
    if (last && last.index + 1 > this.#delivered) {
      const at = last.event.cursor;
      if (typeof at === 'string' && at) this.#deliveredCursor = at;
    }
    this.#delivered = Math.max(this.#delivered, last ? last.index + 1 : from);
    const loss = omitted
      ? {
          // An unknown count plus a known one is still unknown. Adding the two
          // would report a precise number for a hole nobody can measure, which
          // is the one thing a loss report must not do.
          events: this.#loss?.events === null ? null : (this.#loss?.events ?? 0) + omitted,
          reason: this.#loss
            ? `${this.#loss.reason}; and ${omitted} more than limit allowed were stepped over to reach the event you waited for`
            : `${omitted} events older than the one you waited for did not fit in limit and were stepped over`,
        }
      : this.#loss;
    this.#loss = undefined;

    return {
      events: batch.map((b) => b.event),
      cursor: this.#position(last),
      more: Math.max(0, this.#nextIndex - this.#delivered),
      loss,
      hello: this.#hello,
      attached,
    };
  }

  /**
   * Where a read or a wait starts: the model's own place, or the cursor it named.
   *
   * A cursor this buffer cannot place is not an error and not silence. It may
   * be from before the socket opened, from before a reap, or simply not one of
   * ours; either way the events between there and here are not something this
   * server holds, and saying so is the whole of the gap discipline — never a
   * frame the model has to interpret, always a sentence and, from the tool, the
   * state it would otherwise have gone to reconcile against.
   */
  resolveFrom(since?: string): number {
    // Where the model is, which is not where the socket is: it may be four
    // turns behind, and everything between the two is exactly what it has not
    // been handed yet.
    if (since === undefined) return Math.max(this.#delivered, this.#oldest);
    const at = this.#ring.findIndex((b) => b.event.cursor === since);
    if (at >= 0) return this.#ring[at].index + 1;
    // The position at the moment this connection attached, which is
    // legitimately older than anything in the ring on a quiet computer. The one
    // deliberate rewind: a caller asking for it is asking to be re-sent this
    // connection's whole buffer, and saying so exactly.
    if (since === this.#hello?.cursor) return this.#oldest;
    // Otherwise: the unread frontier, NOT the oldest thing still in the ring.
    // A delivered event stays in the ring until the cap evicts it, so answering
    // an unplaceable cursor with `#oldest` re-sent events the model already
    // had — while attaching a loss note that said they "were not kept", which
    // was false about exactly the events being re-sent.
    this.#loss ??= {
      events: null,
      reason:
        'that cursor is not a place this session can find, so whatever happened between it and ' +
        'the events below was not kept here',
    };
    return Math.max(this.#delivered, this.#oldest);
  }

  /**
   * Wait for an event this predicate accepts, or for the deadline.
   *
   * Resolves with the matching event's index, or `undefined` for a wait that
   * ended without one — a deadline, a caller who hung up, or a stream that
   * stopped. None of those three is an error here and the caller says which.
   */
  async waitFor(
    matches: (ev: ComputerEvent) => boolean,
    deadline: AbortSignal,
    cancel?: AbortSignal,
    since?: string,
    abandon?: () => boolean,
  ): Promise<number | undefined> {
    this.touch();
    const start = this.resolveFrom(since);
    for (;;) {
      // Clamped to what is still buffered on every turn, because the ring can
      // evict underneath a long wait. An event that arrived two turns ago and
      // has not been read still satisfies a wait for it — a wait that only ever
      // looked forward would hang on something that had already happened, which
      // is the defect `hello.ready` exists to prevent one level down.
      const from = Math.max(start, this.#oldest);
      const hit = this.#ring.find((b) => b.index >= from && matches(b.event));
      if (hit) return hit.index;
      if (deadline.aborted || cancel?.aborted) return undefined;
      if (this.#state.status === 'stopped') return undefined;
      // Asked on every wake, AFTER the buffered check, so an event that is
      // already here still wins. This is what makes a `capabilities` frame
      // arriving mid-wait answerable: the frame wakes every parked waiter but
      // is not itself an event, so a loop that only re-ran `matches` saw
      // nothing, parked again, and sat out the whole deadline on a computer
      // that could no longer produce what it was waiting for.
      if (abandon?.()) return undefined;
      await this.#park(deadline, cancel);
    }
  }

  /**
   * Wait until this subscription has an opening frame, or has stopped.
   *
   * Separate from {@link waitFor} rather than expressed as a predicate over it,
   * and the reason is worth keeping: `waitFor` evaluates its predicate against
   * BUFFERED EVENTS, so a condition that is not about an event — "has hello
   * landed" — is never evaluated at all on a computer where nothing is
   * happening. Written that way it does not answer late, it answers at the
   * deadline, on the one call where the deadline is twenty seconds.
   */
  async attached(deadline: AbortSignal, cancel?: AbortSignal): Promise<void> {
    while (!this.#types && this.#state.status !== 'stopped') {
      if (deadline.aborted || cancel?.aborted) return;
      await this.#park(deadline, cancel);
    }
  }

  /** Sleep until something changes here, or until either signal fires. */
  #park(deadline: AbortSignal, cancel?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.#wake.delete(done);
        deadline.removeEventListener('abort', done);
        cancel?.removeEventListener('abort', done);
        resolve();
      };
      this.#wake.add(done);
      deadline.addEventListener('abort', done, { once: true });
      cancel?.addEventListener('abort', done, { once: true });
    });
  }

  /** The cursor for a position, or the connection's own when nothing was read. */
  #position(last?: Buffered): string {
    const cursor = last?.event.cursor;
    if (typeof cursor === 'string' && cursor) return cursor;
    return this.#resume ?? this.#hello?.cursor ?? '';
  }

  #wakeAll(): void {
    for (const wake of [...this.#wake]) wake();
  }

  #push(event: ComputerEvent): void {
    this.#ring.push({ index: this.#nextIndex++, event });
    if (this.#ring.length > MAX_BUFFERED) {
      const evicted = this.#ring.splice(0, this.#ring.length - MAX_BUFFERED);
      // Only what the model had not been handed is a loss. Dropping events it
      // already read is the ring doing its job, and counting those would report
      // a hole where there is none.
      const unread = evicted.filter((b) => b.index >= this.#delivered).length;
      if (unread) {
        const before = this.#loss?.events;
        this.#loss = {
          events: before === null ? null : (before ?? 0) + unread,
          reason:
            `more than ${MAX_BUFFERED} events went unread on this computer, so the oldest were ` +
            'dropped here rather than by the platform',
        };
      }
    }
    this.#wakeAll();
  }

  /**
   * Connect, read, reconnect. Runs until {@link close} or until something says
   * that reopening cannot help.
   */
  async #run(): Promise<void> {
    try {
      await this.#loop();
    } catch (err) {
      // Nothing awaits this loop, so anything escaping it would be an
      // unhandled rejection and a stream that had silently stopped. Both are
      // worse than the sentence.
      this.#state = {
        status: 'stopped',
        reason: `the event stream failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      this.#wakeAll();
    }
  }

  async #loop(): Promise<void> {
    let backoff = BACKOFF_MS;
    while (!this.#abort.signal.aborted) {
      let url: string;
      try {
        url = await this.#url();
      } catch (err) {
        if (err instanceof SettledError) {
          this.#state = { status: 'stopped', reason: err.message };
          this.#wakeAll();
          return;
        }
        this.#state = { status: 'connecting' };
        await sleep(backoff, this.#abort.signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      // Checked HERE, between the read and the socket, because `#url()` is a
      // network round trip and a close can land inside it — a session ending, a
      // computer deleted, an idle drop. Without this the socket opened after
      // the abort is one nothing holds a reference to and nothing will ever
      // close: `close()` already ran, `#socket` was undefined at the time, and
      // an `abort` listener added to a signal that has ALREADY fired never
      // fires. It would sit open and buffering into an object nobody can read,
      // for as long as the process lives.
      if (this.#abort.signal.aborted) return;
      const reached = await this.#connection(url);
      if (this.#abort.signal.aborted) return;
      // A connection that got as far as its opening frame is not a failure,
      // however soon it died: a computer that restarts drops the socket every
      // time, and treating that as a failed attempt would back a healthy
      // stream off to fifteen seconds for doing what it always does.
      backoff = reached ? BACKOFF_MS : Math.min(backoff * 2, MAX_BACKOFF_MS);
      // A floor even on a connection that worked. A host that sends `hello`
      // and closes — which is what a subscriber being put down for not reading
      // looks like from here — would otherwise be a reconnect loop with no
      // interval at all, one `GET computers/:id` per turn of the event loop.
      if (!this.#abort.signal.aborted) {
        await sleep(reached ? BACKOFF_MS : backoff, this.#abort.signal);
      }
    }
  }

  /**
   * A fresh `events_url`, on every connection and every reconnect.
   *
   * Re-read rather than cached, because the credential in it is rotated by a
   * restart — and a restart is one of the ordinary reasons the socket dropped
   * in the first place. A reconnect over the old URL is a 401 that arrives as a
   * socket which closes with no status and no body, which is the least
   * debuggable failure this file can produce.
   *
   * The read is also what answers the two refusals a websocket cannot report.
   * The reference says a suspended computer is refused with `409` and
   * `resume_required`, and a stopped one with `409 unavailable`; neither status
   * nor body reaches a `WebSocket` client, so every client of this stream has
   * to infer them. Here they are not inferred at all — the status is on the
   * record this call already had to make for the URL.
   */
  async #url(): Promise<string> {
    let c: Computer;
    try {
      // Bound to this subscription's own signal. Without it a `closeAll()` on
      // session teardown leaves this fetch running to undici's 330-second
      // header timeout, with `#loop` parked inside it the whole time.
      c = unwrapComputer(
        await this.#api.with(this.#abort.signal).json('GET', P.computer(this.computerId)),
      );
    } catch (err) {
      // A question already answered ends the stream rather than being asked
      // again behind it: a deleted computer or a revoked key is otherwise a
      // reconnect loop with nothing to stop it, asking forever and never
      // saying the answer out loud.
      if (err instanceof Error && !isTransientForPoll(err)) throw new SettledError(err.message);
      throw err;
    }
    const status = c.status ?? 'unknown';
    if (status === 'suspended') {
      throw new SettledError(
        `${this.computerId} suspended, and the event stream is the one part of this API that does ` +
          'not resume a computer for you. Listening is not using, so a computer nobody touches ' +
          'suspends underneath its own stream. start_computer, then ask again.',
      );
    }
    if (status === 'stopped' || status === 'build-failed') {
      throw new SettledError(
        `${this.computerId} is ${status}, and only a running computer has an event stream. ` +
          'start_computer, then ask again.',
      );
    }
    if (status !== 'running') {
      // `starting`, `moving`, `creating` — states that clear on their own, so
      // they get the backoff rather than the refusal. Settling on everything
      // that was not `running` broke the flow the README advertises: a
      // create_computer followed at once by wait_for_event("computer.ready")
      // meets `starting`, which is the ordinary weather of a machine coming up
      // and is precisely what the caller is waiting through.
      throw new MandalaError(`${this.computerId} is ${status}; waiting for it to be running`);
    }
    const vnc = c.vnc as Record<string, unknown> | undefined;
    const url = typeof vnc?.events_url === 'string' ? vnc.events_url : undefined;
    if (url) return url;
    if (!vnc) {
      // The platform could not reach the host holding this computer, so it sent
      // no connect surface at all. Weather, and the backoff is the right
      // response to it — deliberately not settled.
      throw new MandalaError(
        `the platform returned no connect surface for ${this.computerId}; its host may be unreachable`,
      );
    }
    if (c.os === 'windows') {
      throw new SettledError(
        `${this.computerId} runs Windows, which has no event stream: there is nowhere in the ` +
          'guest to run the watcher its guest half needs. Use screenshot and list_windows.',
      );
    }
    throw new SettledError(
      `${this.computerId} has no events_url. Its host may predate the event stream (platform ` +
        'OPL-3785), or this API key may be a watch-only one, which is not given window titles.',
    );
  }

  /**
   * One connection, from the handshake to the close.
   *
   * Resolves `true` when the opening frame landed, which is what the caller
   * uses to tell a stream that keeps dropping from one that never started.
   */
  #connection(url: string): Promise<boolean> {
    // The same check as the one in `#loop`, kept here as well because this is
    // the method that would leak the socket, and a second caller must not be
    // able to reintroduce the leak by forgetting.
    if (this.#abort.signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      // Whether this connection can be handed events it missed. A connection
      // with no continuity is joining at the head, and everything before it is
      // simply not this stream's to report.
      const resuming = Boolean(this.#resume);

      let socket: EventSocket;
      try {
        // `since` is this subscription's own place, never the model's. The two
        // are different positions on purpose: the model may be four turns behind
        // and the socket must not re-request what is already in the ring.
        //
        // The URL is parsed INSIDE this try, with the socket it is for. `#url()`
        // returns any non-empty string the platform put in `events_url`, so a
        // relative or malformed one threw out of the Promise executor and
        // REJECTED — and nothing between here and `#run` catches, so the
        // subscription went to a terminal `stopped` with no backoff and no
        // reconnect. A failure to open a socket resolves `false` precisely so
        // the loop can back off and re-read the computer, which is also how a
        // rotated credential is picked up; a URL that would not parse is the
        // same kind of failure and gets the same answer.
        const target = new URL(url);
        if (this.#resume) target.searchParams.set('since', this.#resume);
        socket = this.#socketFor(target.toString());
      } catch {
        return resolve(false);
      }
      this.#socket = socket;
      if (this.#state.status !== 'stopped') this.#state = { status: 'connecting' };

      let settled = false;
      let opened = false;
      const finish = (reached: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#abort.signal.removeEventListener('abort', onAbort);
        if (this.#socket === socket) this.#socket = undefined;
        try {
          socket.close();
        } catch {
          // A socket that is already closed throws on some implementations and
          // not on others, and there is nothing to do about it either way.
        }
        if (this.#state.status !== 'stopped') this.#state = { status: 'connecting' };
        this.#wakeAll();
        resolve(reached);
      };

      // A handshake with nothing behind it — a host that accepts the TCP
      // connection and never upgrades — would otherwise hold this connection
      // open forever, and the reconnect that would have found a working host
      // never runs.
      const timer = setTimeout(() => finish(opened), CONNECT_TIMEOUT_MS);
      const onAbort = () => finish(opened);
      this.#abort.signal.addEventListener('abort', onAbort, { once: true });

      // Both listeners are guarded, because `finish()` does not stop a socket
      // from delivering. A `close()` is a handshake rather than an instant, and
      // a connect-timeout `finish` leaves the socket open by definition — so
      // frames from connection A could still arrive after `#loop` had given up
      // on it and opened connection B, into the same subscription: a second
      // synthesized readiness, events B will replay, a `stopped` state walked
      // back to `open` with `#loop` already returned.
      const mine = () => !settled && this.#socket === socket;
      socket.addEventListener('open', () => {
        if (!mine()) return;
        this.#state = { status: 'open' };
      });
      socket.addEventListener('message', (ev) => {
        if (!mine()) return;
        const frame = parse(ev.data);
        if (!frame) return;
        if (frame.type === 'hello') {
          opened = true;
          clearTimeout(timer);
          this.#onHello(frame, resuming);
          return;
        }
        this.#onFrame(frame);
      });
      socket.addEventListener('error', () => finish(opened));
      socket.addEventListener('close', () => finish(opened));
    });
  }

  #onHello(frame: ComputerEvent, resuming: boolean): void {
    const hello: Hello = {
      computer: str(frame.computer) ?? this.computerId,
      cursor: str(frame.cursor) ?? '',
      // TRUE only. A readiness nobody claimed is a readiness to wait for, which
      // is the recoverable half of being wrong: waiting on a desktop that is up
      // ends at the caller's timeout, while concluding a desktop is up because
      // a field was malformed hands the model a screen that is still booting.
      ready: frame.ready === true,
      events: list(frame.events) ?? [],
      windows: Array.isArray(frame.windows) ? frame.windows : undefined,
    };
    this.#hello = hello;
    this.#types = hello.events;
    this.#resume ??= hello.cursor || undefined;
    this.#start ??= hello.cursor || undefined;
    this.#state = { status: 'open' };

    // `computer.ready` fires once per desktop SESSION, so a stream that
    // attaches to a machine which has been up for an hour will never be sent
    // one — and a `wait_for_event(["computer.ready"])` over the raw socket
    // waits forever on a desktop that is already there. The opening frame says
    // which it is, and this is that answer arriving in the shape the model is
    // already reading.
    //
    // Only on a connection with no continuity. A resume either already had the
    // readiness or is about to be handed it out of the backlog, so nothing is
    // invented there. Per CONNECTION and not latched across them, which is the
    // lesson of the SDK's OPL-4206: a latch that remembered "already told them"
    // suppressed the readiness of a desktop the caller had never heard of,
    // because a display manager can be restarted inside a running computer and
    // that is a new session. One extra readiness is the cheaper wrong answer.
    if (hello.ready && !resuming) this.#pushReady(hello.cursor);
    this.#wakeAll();
  }

  /** The readiness that already happened, in the shape the model is reading. */
  #pushReady(cursor: string): void {
    this.#push({
      type: 'computer.ready',
      at: new Date().toISOString(),
      computer: this.computerId,
      cursor,
      source: 'daemon',
      data: {},
      // Flagged rather than passed off as the real thing, because it is not
      // one: it has no `seq`, and its `at` is when this server attached rather
      // than when the desktop came up.
      synthesized: true,
    });
  }

  #onFrame(frame: ComputerEvent): void {
    const cursor = str(frame.cursor);
    if (frame.type === 'gap') {
      // Never delivered. The model has no documented fallback for a `gap` and
      // no way to be told one mid-stream, so handing it the frame is handing it
      // a recovery procedure to invent. What it gets instead is a sentence and,
      // from the tool, the state it would have gone to reconcile against.
      const detail = str(frame.detail);
      this.#loss = {
        events: null,
        reason: detail
          ? `the platform could not replay that far: ${detail}`
          : 'the platform could not replay from where this stream had got to, so some events are gone',
      };
      // A gap's own cursor is where the replayable history now starts. Resuming
      // from it is legal and is what keeps the next reconnect from asking for
      // the same missing window again.
      const oldest = str((frame.data as Record<string, unknown> | undefined)?.oldest_cursor);
      if (cursor) this.#resume = cursor;
      else if (oldest) this.#resume = oldest;
      // A gapped resume counts as no continuity, so the readiness `#onHello`
      // declined to synthesize — because this connection was resuming, and a
      // resuming connection is about to be handed the backlog — has to be made
      // here instead. The backlog it would have been in is precisely what the
      // gap says is gone. Once per gap, and a second one is not a duplicate to
      // suppress: a display manager restarted inside a running computer is a
      // new desktop session, and a gap is exactly where the event saying so
      // went missing (the SDK's OPL-4206).
      // The floor moves with the gap when the model has been handed nothing
      // yet: the history before this point is what the gap says is gone, so a
      // replacement subscription resuming from where this one STARTED would ask
      // for a window that cannot be replayed and be told so a second time.
      if (!this.#deliveredCursor) this.#start = this.#resume;
      // Stamped with the GAP's position, not the opening frame's. A resumed
      // connection's `hello` carries the cursor it attached at, which can be
      // older than events the model has already been handed — and a synthesized
      // event carrying it would walk `#deliveredCursor` backwards, so the next
      // `since` re-delivered what had already been read, silently, with no gap
      // to report it.
      if (this.#hello?.ready) this.#pushReady(this.#resume ?? this.#hello.cursor);
      this.#wakeAll();
      return;
    }
    if (frame.type === 'capabilities') {
      // Replaces what `hello` advertised. It goes both ways: a guest that turns
      // out to have no watcher withdraws the half `hello` promised, and a
      // computer stopped and started under an open socket can acquire it.
      const events = list(frame.events);
      if (events) this.#types = events;
      this.#wakeAll();
      return;
    }
    // `closed` is this host saying it is ending the socket on purpose rather
    // than the socket simply dying. Nothing here needs to act on the
    // difference: the reconnect re-reads the computer either way, and that read
    // is what tells a machine somebody stopped from one that merely moved.
    if (STREAM_FRAMES.has(frame.type)) return;
    if (cursor) this.#resume = cursor;
    this.#push(frame);
  }
}

/**
 * Every computer this session is listening to.
 *
 * One per session and not one per process, for the reason `Session` itself is:
 * over the HTTP transport each caller arrives with their own key, and a
 * process-wide hub would hold one caller's socket open for another caller's
 * computer.
 */
export class EventHub {
  readonly #api: Api;
  readonly #socketFor: EventSocketFactory;
  readonly #subs = new Map<string, Subscription>();
  /**
   * Where each computer's stream had got to when its subscription went away.
   *
   * A reap is not a decision to forget. Five minutes without a tool call is an
   * ordinary thing for a model to do — a long `exec`, a detour onto another
   * machine — and a subscription that reopened at the head afterwards would
   * lose exactly the `process.exited` the detour was waiting on. Reopening with
   * this asks the platform to replay from there instead, and where it cannot,
   * the answer is an honest gap rather than silence.
   */
  readonly #resume = new Map<string, string>();
  /** Bound, so a session that touches thousands of computers cannot grow forever. */
  static readonly #MAX_REMEMBERED = 256;
  #sweep?: ReturnType<typeof setInterval>;

  constructor(api: Api, socketFor: EventSocketFactory = defaultEventSocket) {
    this.#api = api;
    this.#socketFor = socketFor;
  }

  /** This computer's subscription, opened if this is the first ask. */
  open(computerId: string): Subscription {
    let sub = this.#subs.get(computerId);
    if (!sub) {
      sub = new Subscription(this.#api, computerId, this.#socketFor, this.#resume.get(computerId));
      this.#subs.set(computerId, sub);
      sub.start();
      this.#startSweep();
    }
    sub.touch();
    return sub;
  }

  /**
   * Drop one, so the next ask opens a fresh socket and a fresh buffer.
   *
   * `remember` is the difference between a stream this session may want to
   * resume — reaped for idleness, stopped on a computer somebody suspended —
   * and one there is nothing left to resume: a deleted computer's cursor names
   * a position in a stream that no longer exists.
   */
  drop(computerId: string, reason: string, remember = false): void {
    const sub = this.#subs.get(computerId);
    if (!sub) return;
    const at = sub.resumeCursor;
    sub.close(reason);
    this.#subs.delete(computerId);
    if (remember && at) {
      // Delete before set so a repeated id is the newest entry and the oldest
      // is the one evicted.
      this.#resume.delete(computerId);
      this.#resume.set(computerId, at);
      for (const key of this.#resume.keys()) {
        if (this.#resume.size <= EventHub.#MAX_REMEMBERED) break;
        this.#resume.delete(key);
      }
    } else {
      this.#resume.delete(computerId);
    }
    if (!this.#subs.size) this.#stopSweep();
  }

  /** Close every socket. The session is over, or the process is going away. */
  closeAll(): void {
    for (const [id, sub] of this.#subs) {
      sub.close('the session ended');
      this.#subs.delete(id);
    }
    this.#resume.clear();
    this.#stopSweep();
  }

  #startSweep(): void {
    if (this.#sweep) return;
    this.#sweep = setInterval(() => {
      for (const [id, sub] of this.#subs) {
        // A stopped subscription is kept until something asks about it, so the
        // reason it stopped — suspended, deleted, Windows — is still there to
        // be reported once. The idle window is what eventually takes it.
        if (sub.idleMs < IDLE_REAP_MS) continue;
        this.drop(id, 'nothing asked about this computer for five minutes', true);
      }
      if (!this.#subs.size) this.#stopSweep();
    }, SWEEP_MS);
    // A timer is not a reason for a process to stay alive. Without this an
    // stdio server whose client has gone away, and every test that ever opened
    // a stream, hangs at exit until the sweep is cleared by hand.
    this.#sweep.unref?.();
  }

  #stopSweep(): void {
    if (!this.#sweep) return;
    clearInterval(this.#sweep);
    this.#sweep = undefined;
  }
}

/**
 * A failure that answers the same way however often it is asked.
 *
 * The reconnect loop's one branch: everything else is weather and is backed
 * off, and this ends the stream with the sentence saying why.
 */
class SettledError extends MandalaError {}

/** One text frame, as an object, or `undefined` for anything that is not one. */
function parse(data: unknown): ComputerEvent | undefined {
  const text =
    typeof data === 'string'
      ? data
      : data instanceof Uint8Array
        ? new TextDecoder().decode(data)
        : undefined;
  if (text === undefined) return undefined;
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return undefined;
  const type = (frame as Record<string, unknown>).type;
  if (typeof type !== 'string' || !type) return undefined;
  return frame as ComputerEvent;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const list = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : undefined;

/** A pause that ends early when the stream is closed. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
