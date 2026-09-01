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

import { posix } from 'node:path';
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

/**
 * One nominated tree, as the opening frame reports it back.
 *
 * `path` is the nomination as the HOST normalised it, and that is the spelling
 * every `file.changed` carries in `watch` — so a client matching on what it
 * sent matches nothing the day the two differ. What this server does about that
 * is {@link Subscription.hostPath}: it goes on nominating in its own spelling,
 * because that is what every reconnect has to re-send, and matches in the
 * host's.
 *
 * `armed` is the field a client gets wrong. A tree is not being watched because
 * the socket accepted the nomination: the guest has to be asked, and on a
 * computer nobody has opened a terminal on the host must install the watcher
 * into the guest first. `true` here means live NOW and no event is coming to
 * say so — somebody else nominated it first and the guest answers a nomination
 * once. `false` means wait for `{watch, armed: true}` on the stream. The same
 * split as `ready`: state in `hello`, transitions on the stream.
 */
export type Watched = { path: string; armed: boolean };

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
  /**
   * The trees this stream reports `file.changed` under, normalised by the host.
   *
   * ABSENT rather than empty when nothing was nominated, and the difference is
   * the one that matters here: absent is also what a host that has never heard
   * of `&watch=` sends back to a nomination, and this server has to be able to
   * tell "you asked for nothing" from "this host cannot honour what you asked
   * for" without waiting out a timeout to discover it.
   */
  watching?: Watched[];
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

/**
 * How many trees ONE stream may nominate, which is the platform's own cap.
 *
 * There is a second, larger one this client cannot enforce: a computer watches
 * at most 32 distinct trees across every stream open on it, and a nomination
 * past that is refused on the upgrade — which reaches a websocket client as a
 * socket that would not open and nothing else. See {@link Subscription.nominate}
 * for what is done about that.
 */
export const MAX_WATCHES = 4;

/**
 * How many connections in a row may fail to open before a watch is blamed.
 *
 * A watch is the one thing on this URL a HOST can refuse: a path it will not
 * honour is a `400` on the upgrade, and a nomination past the 32 trees a
 * computer will watch is a `409`. Neither status nor body reaches a websocket
 * client — undici reports both as "Received network error or non-101 status
 * code" — so a refused watch is indistinguishable here from a host that is
 * down, and the reconnect loop would ask for the same refused set forever.
 *
 * That is not a file watch failing. It is the WHOLE STREAM failing: the window
 * events, the process exits and the readiness that were arriving before anybody
 * asked about a directory all stop, and nothing ever says why. So after this
 * many failures the newest nomination is shed and the stream is allowed back —
 * newest because it is the one that has just changed, and the older ones were
 * connecting a moment ago. Two rather than one, because a single failed
 * connection is ordinary weather.
 */
const WATCH_SHED_AFTER = 2;

/** The platform's bound on one nominated path, in BYTES rather than characters. */
export const MAX_WATCH_PATH_BYTES = 256;

/**
 * A nominated path, in the spelling the host will accept — or a refusal saying
 * why it will not.
 *
 * A mirror of the platform's `cleanWatchPath`, and mirrored rather than left to
 * the server for one reason: a path the host refuses is a `400` on the UPGRADE,
 * and an upgrade that fails reaches a websocket client as an error event with
 * no status and no body. Undici says "Received network error or non-101 status
 * code" and that is the whole of it. So a bad path sent optimistically is
 * indistinguishable here from a host that is down, and the answer a model would
 * get is a reconnect loop under "could not open the event stream" — for a
 * mistake that is entirely visible before anything is sent.
 *
 * Normalising rather than refusing the shapes people actually type is the
 * platform's choice and is kept: a trailing slash and a `.` segment name one
 * directory unambiguously. What must not happen is normalising SILENTLY, since
 * the cleaned form is what events carry and what a caller has to match on — so
 * the tools say what a path became when it changed.
 */
export function cleanWatchPath(input: string): string {
  if (!input) throw new MandalaError('a watch path cannot be empty');
  if (Buffer.byteLength(input, 'utf8') > MAX_WATCH_PATH_BYTES) {
    throw new MandalaError(
      `a watch path may be at most ${MAX_WATCH_PATH_BYTES} bytes; that one is ` +
        `${Buffer.byteLength(input, 'utf8')}`,
    );
  }
  // A lone surrogate is a string JavaScript will hold and UTF-8 cannot carry.
  // The round trip replaces one with U+FFFD, which is the cheapest way to ask
  // "would this survive being sent" without hand-decoding the code units.
  if (Buffer.from(input, 'utf8').toString('utf8') !== input) {
    throw new MandalaError('a watch path must be valid UTF-8');
  }
  // Refused rather than escaped, as the platform refuses them: the value ends
  // up in log lines and in an opening frame, so a newline in one is a caller
  // choosing what somebody else's terminal renders.
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new MandalaError('a watch path cannot contain control characters');
    }
  }
  if (!input.startsWith('/')) {
    throw new MandalaError(
      `a watch path must be absolute, and ${JSON.stringify(input)} is not. Paths on this stream ` +
        "are the guest's own, so there is no working directory here for a relative one to be " +
        'relative to.',
    );
  }
  // Go's `path.Clean` and not Node's `normalize`, which differ on exactly one
  // thing that matters: normalize keeps a trailing slash and Clean does not,
  // and the cleaned form is the one every event echoes.
  let c = posix.normalize(input);
  if (c.length > 1 && c.endsWith('/')) c = c.slice(0, -1);
  if (c === '/') {
    throw new MandalaError(
      'watching / is not a nomination; name the directory you are waiting on. The root is every ' +
        'tree at once, which would spend the directory budget on /usr before reaching anything ' +
        'you care about and then report nothing but loss.',
    );
  }
  return c;
}

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
  /**
   * The trees nominated on this stream, oldest nomination first.
   *
   * Held here rather than on the socket because it OUTLIVES the socket: it is
   * what every reconnect re-nominates, and a set that lived on the connection
   * would be silently dropped by the first reconnect — leaving a model waiting
   * on a tree nobody was watching any more, which is the one failure this whole
   * feature is built to make impossible.
   */
  #watches: string[] = [];
  /**
   * What the host calls each nominated tree, when that is not what we called it.
   *
   * The reference says to match on what `hello` gives back rather than on what
   * you sent, and this is that — kept as a MAP rather than by overwriting the
   * nominations, which is the shape that reads naturally and is wrong. The
   * nominations are what goes back on the URL at every reconnect, so replacing
   * them with the host's spelling makes this client's idea of a tree drift one
   * rename per connection; and if the two normalisations ever disagreed about a
   * path, every call naming it would see a tree it had not nominated, reopen
   * the socket, and be renamed again. One end has to be fixed, and it is the
   * end that does the sending.
   *
   * Filled by position, which is exactly what the platform promises: it
   * de-duplicates and preserves order, and this client never nominates a
   * duplicate, so entry i of the echo is nomination i.
   */
  #hostName = new Map<string, string>();
  /** Whether each nominated tree is being watched YET. See {@link Watched}. */
  #armed = new Map<string, boolean>();
  /**
   * How many times each tree has come up, so a RE-arm can be told from the one
   * a caller waited for.
   *
   * A second `armed` is not a duplicate to suppress: it says the watch was
   * interrupted and is reporting from here, so anything that happened in
   * between was never reported and the tree has to be re-read. A wait that
   * matched only on file paths would sit through that and then say nothing
   * changed.
   */
  #armGen = new Map<string, number>();
  /**
   * The STANDING loss on each tree, cleared when it arms.
   *
   * Standing is the whole of what this holds, and it is why a `flood` is not in
   * it. A flood is a burst: the tree changed faster than the cap allows it to be
   * reported, and once the burst is over the tree is being reported normally
   * again — so remembering one would make every later answer about a tree that
   * saw one build hedge forever. `budget` and `unwatchable` are conditions
   * rather than moments: part of the tree is not being watched, or none of it
   * is, and both stay true until something changes them.
   */
  #watchLost = new Map<string, string>();
  /**
   * Trees this subscription inherited from one that went away.
   *
   * A tree is watched by the CONNECTION, so the reap that took the previous
   * subscription also stopped the guest watching — and inotify reports changes
   * and not state, so nothing that happened in between was recorded anywhere for
   * a replay to hand back. Re-nominating gets the watch going again and says
   * nothing about the hole, which would leave a model reading a perfectly
   * ordinary "nothing changed" over minutes during which nothing was looking.
   * Said once, on the first answer about the tree, and then forgotten.
   */
  #interrupted = new Set<string>();
  /**
   * Trees this stream stopped nominating because the connection carrying them
   * would not open. See {@link WATCH_SHED_AFTER}.
   */
  #watchRefused = new Set<string>();
  /** Consecutive connections that never reached an opening frame while watching. */
  #upgradeFailures = 0;
  /**
   * Whether the host echoed `watching` for a nomination this stream made.
   *
   * `undefined` until an opening frame has been seen with something nominated.
   * A host that predates `file.changed` ignores `&watch=` rather than refusing
   * it, so the socket opens, nothing is watched, and no event ever arrives —
   * a silence indistinguishable from a quiet directory. This is how that is
   * told apart, and it is the only way: the frame is the whole of the answer.
   */
  #watchingEchoed?: boolean;
  /**
   * The trees the connection now open put on its URL, and whether it has
   * greeted.
   *
   * Two fields for one question — "is the tree I just nominated actually on the
   * wire" — and the question has to be asked that way rather than by counting
   * opening frames. A nomination can land while a connection is IN FLIGHT: the
   * socket dropped, the reconnect has already built its URL from the old watch
   * set, and its `hello` is still coming. Counting frames, that frame answers
   * the nomination — and it is a frame from a connection that never carried it,
   * so its missing `watching` reads as a host that ignores watches and the
   * caller is refused for a reason that is not true.
   */
  #sent: string[] = [];
  #greeted = false;
  /**
   * Whether the socket now closing was closed by THIS side to re-nominate.
   *
   * A watch set is a connection parameter, so adding one means opening a new
   * connection. The reconnect floor in {@link #loop} exists to stop a host that
   * sends `hello` and closes from becoming a spin loop; a reconnect this side
   * asked for is not that, and paying half a second for one would be half a
   * second added to every first watch on a tree.
   */
  #renominate = false;
  #state: SubscriptionState = { status: 'connecting' };
  #wake = new Set<() => void>();
  #socket?: EventSocket;
  #abort = new AbortController();
  #lastUsed = Date.now();
  #running = false;

  constructor(
    api: Api,
    computerId: string,
    socketFor: EventSocketFactory,
    since?: string,
    watches: string[] = [],
  ) {
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
    // And what it was watching, for the same reason and with a sharper edge.
    // A tree stops being watched when the socket carrying it closes, so a reap
    // silently ends every watch on that computer — and the next answer about
    // one would be an honest-looking "nothing changed" over a window during
    // which nothing was watching, which is the one thing a file watch must
    // never produce. Nominating them again on the first connection is what
    // makes the tool's promise that a nomination lasts across turns true.
    this.#watches = watches.slice(0, MAX_WATCHES);
    for (const w of this.#watches) this.#interrupted.add(w);
  }

  /** The trees this stream nominates, in this client's own spelling. */
  get nominations(): string[] {
    return [...this.#watches];
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

  /**
   * The trees nominated on this stream, and whether each is live yet.
   *
   * In the HOST's spelling, because that is the one every event carries and so
   * the one a reader of this has to be able to match on.
   */
  get watching(): Watched[] {
    return this.#watches.map((path) => ({
      path: this.hostPath(path),
      armed: this.#armed.get(path) === true,
    }));
  }

  /** What the host calls a tree this stream nominated. Its own name until it says. */
  hostPath(nominated: string): string {
    return this.#hostName.get(nominated) ?? nominated;
  }

  /** Whether this tree is being watched right now. */
  isArmed(path: string): boolean {
    return this.#armed.get(path) === true;
  }

  /**
   * Which arming of this tree is current.
   *
   * Compared rather than read: a caller holds the number from when it started
   * waiting and asks whether it still holds, which is how a re-arm ends a wait
   * that was looking for file paths.
   */
  armGeneration(path: string): number {
    return this.#armGen.get(path) ?? 0;
  }

  /** The last thing this tree said it had lost, if it has said one since arming. */
  lostFor(path: string): string | undefined {
    return this.#watchLost.get(path);
  }

  /**
   * Whether this host honoured the nomination at all.
   *
   * `undefined` while nothing has been nominated or no opening frame has been
   * seen since. `false` is a host with no `file.changed` — see
   * {@link #watchingEchoed}.
   */
  get watchesHonoured(): boolean | undefined {
    return this.#watchingEchoed;
  }

  /** Whether the connection now open nominated this tree and has greeted. */
  nominationLive(path: string): boolean {
    return this.#greeted && this.#sent.includes(path);
  }

  /**
   * Whether this tree is being watched RIGHT NOW, connection included.
   *
   * The question {@link isArmed} does not answer and the one a quiet answer has
   * to be built on. `#armed` is what the last opening frame said, and it is
   * deliberately not cleared when a socket dies — clearing it would make every
   * routine reconnect look like a re-arm, which is a "go and re-read the tree"
   * for an interruption the platform's own replay covered. But a tree on a
   * connection that is not up is not being watched at this instant, and a tool
   * that said "watched for the whole of that and still is" while reconnecting
   * would be wrong about the half of that sentence it can actually check.
   */
  watchLive(path: string): boolean {
    return this.nominationLive(path) && this.isArmed(path);
  }

  /** Whether this stream is still nominating this tree at all. */
  nominates(path: string): boolean {
    return this.#watches.includes(path);
  }

  /** Whether the connection carrying this tree was refused. See {@link WATCH_SHED_AFTER}. */
  watchWasRefused(path: string): boolean {
    return this.#watchRefused.has(path);
  }

  /**
   * Whether this tree went unwatched between a previous subscription and this
   * one, and has not been told about it yet. Reading it CLEARS it: it is a
   * thing to say once.
   */
  takeInterruption(path: string): boolean {
    return this.#interrupted.delete(path);
  }

  /** Mark it in use, so the idle sweep leaves it alone. */
  touch(): void {
    this.#lastUsed = Date.now();
  }

  /**
   * Ask this stream to report file changes under a tree.
   *
   * The one thing on this socket that has to be ASKED for: without a nomination
   * no `file.changed` can arrive at all, which makes a watch a connection
   * parameter rather than an event type to add to a list. So nominating
   * something new reopens the connection — with this subscription's own
   * `since`, so the reconnect resumes rather than restarts and nothing on the
   * stream is missed by it.
   *
   * Already-nominated is a no-op that moves the tree to the front of the queue,
   * and that ordering is what {@link MAX_WATCHES} costs: a fifth tree evicts the
   * one nobody has asked about for longest. Evicting rather than refusing is
   * deliberate — a model that has moved on to a different directory should not
   * have to know that four earlier ones are in the way — but it is never
   * SILENT, because a dropped watch is a tree that stops reporting. The caller
   * is handed what went and says so.
   *
   * It says only what it EVICTED, and not whether it reopened anything. The
   * caller has a sharper question than "did this change something" —
   * {@link nominationLive}, which asks whether the open connection is carrying
   * the tree — and the two differ in the case that matters: a nomination this
   * call did not change can still be off the wire, because the connection
   * carrying it dropped a moment ago.
   */
  nominate(path: string): { evicted?: string } {
    this.touch();
    const at = this.#watches.indexOf(path);
    if (at >= 0) {
      // Most recently asked about goes last, so the eviction below always takes
      // the tree that has waited longest for somebody to care about it.
      this.#watches.splice(at, 1);
      this.#watches.push(path);
      return {};
    }
    this.#watches.push(path);
    let evicted: string | undefined;
    if (this.#watches.length > MAX_WATCHES) {
      evicted = this.#watches.shift();
      if (evicted !== undefined) {
        this.#armed.delete(evicted);
        this.#watchLost.delete(evicted);
        this.#hostName.delete(evicted);
        this.#interrupted.delete(evicted);
        // The arm generation is deliberately NOT deleted. It has to stay
        // monotonic per path, because a waiter parked on this tree is holding a
        // number from before the eviction: reset to zero and re-nominated, the
        // tree would come back at one and that waiter would read an eviction as
        // a re-arm — "reporting starts here, re-read the tree" about a tree that
        // had simply been taken away from it. Eviction is told by membership,
        // which is what `nominates` is for.
      }
    }
    // Closed rather than aborted: `#loop` is still running and its next turn
    // reads `#watches` for the new connection. The flag is what keeps that turn
    // from paying the reconnect floor for a reconnection this side chose.
    // A nomination is also a retry. Whatever this stream concluded about this
    // path last time — that its connection would not open, that the tree was
    // never watched — is a fact about a moment that has passed: the computer may
    // since have dropped below its tree limit, and the directory may since
    // exist. Starting the shed budget again is the same decision.
    this.#watchRefused.delete(path);
    this.#upgradeFailures = 0;
    this.#renominate = true;
    this.#socket?.close();
    this.#wakeAll();
    return { evicted };
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

  /**
   * Wait until the open connection is carrying this tree and has greeted.
   *
   * The counterpart to {@link attached} for a nomination, and separate for the
   * reason the two of them are separate from {@link waitFor}: what is being
   * waited for is not an event, so a predicate over the ring would never be
   * evaluated on a computer where nothing is happening. `attached` cannot serve
   * here either — it is satisfied the moment `#types` is set, which a
   * nomination does not clear, so it would return at once and leave the caller
   * reading the PREVIOUS connection's `watching`.
   */
  async nominated(path: string, deadline: AbortSignal, cancel?: AbortSignal): Promise<void> {
    while (!this.nominationLive(path) && this.#state.status !== 'stopped') {
      if (deadline.aborted || cancel?.aborted) return;
      // A tree this stream has given up on will never come live by waiting: it
      // is not on the URL any more, by decision rather than by weather. Waiting
      // out the deadline for it would turn an answer this server already has
      // into a timeout the caller has to interpret.
      if (this.#watchRefused.has(path)) return;
      await this.#park(deadline, cancel);
    }
  }

  /**
   * Wait until this tree is actually being watched.
   *
   * The whole reason a file watch needs its own wait. `hello` accepting a
   * nomination is not the tree being watched: the guest has to be asked, and on
   * a computer nobody has opened a terminal on the host installs the watcher
   * into the guest first — seconds, not milliseconds. inotify reports changes
   * and not state, so nothing that happens in that window is ever reported.
   * Returning before this is what makes a tool say "nothing changed" about a
   * window during which nothing was watching, which is the one sentence a
   * server whose whole promise is that it was listening must not say.
   *
   * Returns on the deadline, on a stopped stream, and on an `unwatchable` —
   * which is the one `lost` that means the tree is not being watched at all,
   * and so is not something more waiting will fix. The caller reads
   * {@link isArmed} to find out which it got.
   */
  async armedWait(path: string, deadline: AbortSignal, cancel?: AbortSignal): Promise<void> {
    while (!this.isArmed(path) && this.#state.status !== 'stopped') {
      if (deadline.aborted || cancel?.aborted) return;
      if (this.#watchLost.get(path) === 'unwatchable') return;
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
      // The one refusal a websocket cannot report, answered by elimination.
      // A watch is the only thing on this URL a host will refuse outright, and
      // it refuses it on the UPGRADE — where there is no status and no body for
      // a client to read. Left alone, one nomination the host will not honour
      // is the whole stream gone: no windows, no process exits, no readiness,
      // reconnecting forever with nothing ever saying why.
      if (reached) this.#upgradeFailures = 0;
      else if (this.#sent.length && ++this.#upgradeFailures >= WATCH_SHED_AFTER) this.#shed();
      // A reconnection THIS side asked for, to put a new watch set on the URL.
      // It skips the floor below, which exists for a host that keeps hanging up
      // on us rather than for a connection we closed on purpose — and paying it
      // would put half a second on every first watch of a tree, in front of an
      // arming the caller is already waiting on.
      if (this.#renominate) {
        this.#renominate = false;
        continue;
      }
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
    if (url) {
      // Parsed HERE, where every other events_url decision is made, rather than
      // beside the socket. A string that is not a URL is the same fact as the
      // missing one below — there is nothing to connect to — and this method is
      // the one place that says so with a sentence instead of an exception.
      //
      // It used to throw from inside the connection's Promise executor, which
      // REJECTED: nothing between there and `#run` catches, so the subscription
      // reached a terminal `stopped` reading "the event stream failed: Invalid
      // URL". Settling it is the same outcome said properly. Retrying it
      // forever would be worse than either — the URL is re-read on every
      // attempt, so a value the platform keeps sending is a poll of
      // `GET /computers/:id` every fifteen seconds for the life of the session,
      // under a wait that keeps answering "nothing happened".
      try {
        new URL(url);
      } catch {
        throw new SettledError(
          `${this.computerId} has an events_url this client cannot parse (${JSON.stringify(url)}), ` +
            'so there is nowhere to connect. This is the platform sending something unexpected rather ' +
            'than a passing condition — screenshot and list_windows still work.',
        );
      }
      return url;
    }
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
    this.#greeted = false;
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
        // Inside the try with the socket it is for, so that nothing in this
        // executor can reject: a rejection here escapes `#loop` — which does
        // not catch — and `#run` turns it into a terminal `stopped`, which is
        // not what a failure to open one connection means. `#url()` has already
        // settled a value that cannot parse, so this is belt and braces on the
        // path that used to throw.
        const target = new URL(url);
        if (this.#resume) target.searchParams.set('since', this.#resume);
        // Repeated rather than comma-joined, which is the platform's own
        // decision and worth mirroring exactly: a directory may contain a
        // comma, and a list format that cannot represent every value it is a
        // list of is a bug waiting for the first tenant with one.
        //
        // `append` and not `set`: the second call to `set` replaces the first.
        target.searchParams.delete('watch');
        // Snapshotted as it goes on the URL. This is what the opening frame's
        // `watching` is measured against, and what says whether a nomination
        // made a moment ago is on this connection or on the next one.
        this.#sent = [...this.#watches];
        for (const w of this.#sent) target.searchParams.append('watch', w);
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
        // A connection that has ended is not carrying anything, whatever it was
        // greeted with. Without this the window between one connection ending
        // and the next opening reads as a tree still on the wire.
        this.#greeted = false;
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
      watching: watched(frame.watching),
    };
    this.#hello = hello;
    this.#types = hello.events;
    this.#greeted = true;
    this.#adoptWatching(hello.watching);
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

  /**
   * Take the host's word for what this stream is watching.
   *
   * Its spelling and not ours, and that is the point: the host normalises a
   * nomination — a trailing slash and a `.` segment are cleaned away — and the
   * cleaned form is what every `file.changed` carries in `watch`. A client that
   * went on matching what it SENT would match nothing the first time the two
   * differed, and this server cleans a path the same way precisely so that they
   * do not — which is a reason to check rather than a reason not to look.
   *
   * The armed map is REPLACED rather than merged, because a new connection is
   * where the authoritative answer lives. The guest answers a nomination once,
   * so a tree somebody else armed sends this connection no event at all and the
   * opening frame is the only place its state is stated. Merging would leave a
   * stale `true` on a tree that had since gone unwatchable, which is the
   * wait-forever bug pointed the other way.
   */
  #adoptWatching(watching?: Watched[]): void {
    // Measured against what THIS connection sent rather than against the
    // current nomination set, which are the same list except in the one case
    // that matters: a nomination made while a connection was in flight.
    const sent = this.#sent;
    // Both cleared whatever the answer. An alias belongs to the connection that
    // stated it, and a stale one would map a nomination onto a name the host is
    // no longer using — every event under it dropped as being about a tree
    // nobody asked for. And a connection carrying no watches is watching
    // nothing, so a surviving `armed` would be a live tree that is not one.
    this.#hostName.clear();
    const armed = new Map<string, boolean>();
    if (!sent.length) {
      this.#watchingEchoed = undefined;
      this.#armed = armed;
      return;
    }
    // A host answering about a different number of trees than it was asked
    // about has said something this client cannot line up, and guessing which
    // nomination it dropped would be inventing the one fact the caller needs.
    // Read as "not honoured", which is the answer that gets said out loud.
    this.#watchingEchoed = watching !== undefined && watching.length === sent.length;
    if (!watching || !this.#watchingEchoed) {
      this.#armed = armed;
      return;
    }
    sent.forEach((nominated, i) => {
      const w = watching[i];
      if (w.path !== nominated) this.#hostName.set(nominated, w.path);
      armed.set(nominated, w.armed);
      // A tree that comes up armed on a connection that found it unarmed is a
      // real transition and bumps the generation; one that was already armed is
      // the same arming reported again by a socket that reconnected under it,
      // and bumping there would tell every waiter to go and re-read a tree
      // nothing had interrupted.
      if (w.armed && !this.isArmed(nominated)) this.#bumpArm(nominated);
      // Whatever this tree had lost belongs to the connection that reported it.
      // The guest re-states itself to a new nomination, so carrying a stale
      // `unwatchable` forward would refuse a wait on a tree that had since
      // appeared.
      this.#watchLost.delete(nominated);
    });
    this.#armed = armed;
  }

  /**
   * Stop nominating the newest tree, so the rest of the stream can come back.
   *
   * Newest because it is the one that has just changed: the connections before
   * it were opening, so whatever the host is refusing arrived with this. Shed
   * one at a time rather than all of them, since three working watches must not
   * be thrown away for a fourth the host will not take.
   *
   * The path is remembered rather than forgotten. A tree that silently stopped
   * being nominated would be answered with an ordinary "not being watched yet"
   * for as long as the caller kept asking, and the caller would keep asking —
   * so {@link watchWasRefused} is what lets the tool say the real thing, which
   * is that the connection carrying it would not open at all.
   */
  #shed(): void {
    const shed = this.#watches.pop();
    this.#upgradeFailures = 0;
    if (shed === undefined) return;
    this.#watchRefused.add(shed);
    this.#armed.delete(shed);
    this.#watchLost.delete(shed);
    this.#hostName.delete(shed);
    this.#interrupted.delete(shed);
    this.#wakeAll();
  }

  #bumpArm(path: string): void {
    this.#armGen.set(path, (this.#armGen.get(path) ?? 0) + 1);
  }

  /**
   * What a `file.changed` says about the TREE, as opposed to about a file.
   *
   * Three payload shapes share one type here, and only one of them is a change:
   * `{watch, path, kind, dir}` is a file, `{watch, armed}` is the tree becoming
   * live, and `{watch, lost}` is the tree saying this stream's picture of it is
   * wrong. The last two are state, and are recorded BEFORE the event is pushed
   * so that a waiter woken by the push reads the state the push is about.
   *
   * Only `unwatchable` disarms. `flood` and `budget` both say the tree IS being
   * watched and is being reported incompletely — treating them as a disarm
   * would answer the next wait with "this tree is not being watched" about a
   * tree that is, forever, because nothing would arm it again.
   */
  #onFileFrame(frame: ComputerEvent): void {
    const data = frame.data as Record<string, unknown> | undefined;
    const named = str(data?.watch);
    if (!named) return;
    // Back into this client's own spelling, since that is what every nomination
    // is keyed by here. Ours already in the ordinary case, where the host's
    // normalisation and this file's agree and the map is empty.
    const watch = this.#watches.find((w) => this.hostPath(w) === named);
    if (!watch) return;
    const lost = str(data?.lost);
    if (data?.armed === true) {
      this.#watchLost.delete(watch);
      // Always a transition, never a restatement, and that is the host's
      // guarantee rather than an assumption. The guest re-states `armed` for
      // every tree it is already watching whenever the host nominates anything
      // — which happens whenever any subscriber on this computer arrives — and
      // the host DROPS those, delivering one only when its own record says the
      // tree was not armed. So a frame that gets here means the watch really
      // was interrupted and is reporting from HERE, and anything that happened
      // in between was never reported.
      //
      // Compared against this client's own idea of armed instead, a re-arm
      // after a stop and a start would look like a restatement — nothing here
      // clears the flag when the link goes down — and the wait that should have
      // said "re-read the tree" would have gone on waiting on a tree whose
      // history had a hole in it.
      this.#bumpArm(watch);
      this.#armed.set(watch, true);
      return;
    }
    if (lost) {
      // Only the standing ones. `budget` says part of this tree is not being
      // watched and stays true until a narrower path is nominated; a later wait
      // on it must not answer "nothing changed" as though the whole tree had
      // been covered. `unwatchable` says none of it is. A `flood` is neither: it
      // is a burst that is over, and holding onto one would make every answer
      // about a tree that ever saw a build hedge for the rest of the session.
      if (lost === 'budget' || lost === 'unwatchable') this.#watchLost.set(watch, lost);
      if (lost === 'unwatchable') this.#armed.set(watch, false);
    }
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
    if (frame.type === 'file.changed') this.#onFileFrame(frame);
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
   * Where each computer's stream had got to when its subscription went away,
   * and what it was watching.
   *
   * A reap is not a decision to forget. Five minutes without a tool call is an
   * ordinary thing for a model to do — a long `exec`, a detour onto another
   * machine — and a subscription that reopened at the head afterwards would
   * lose exactly the `process.exited` the detour was waiting on. Reopening with
   * this asks the platform to replay from there instead, and where it cannot,
   * the answer is an honest gap rather than silence.
   *
   * The nominations ride with the cursor because they have the same shape of
   * consequence and a worse failure. A tree is watched by the CONNECTION, so a
   * reap ends every watch on that computer — and a stream that came back
   * watching nothing would answer the next question about a tree with a
   * perfectly ordinary "nothing changed", over a window during which nothing
   * was looking. One map rather than two, so an entry is evicted whole.
   */
  readonly #memory = new Map<string, { cursor?: string; watches: string[] }>();
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
      const held = this.#memory.get(computerId);
      sub = new Subscription(this.#api, computerId, this.#socketFor, held?.cursor, held?.watches);
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
    const watches = sub.nominations;
    sub.close(reason);
    this.#subs.delete(computerId);
    if (remember && (at || watches.length)) {
      // Delete before set so a repeated id is the newest entry and the oldest
      // is the one evicted.
      this.#memory.delete(computerId);
      this.#memory.set(computerId, { cursor: at, watches });
      for (const key of this.#memory.keys()) {
        if (this.#memory.size <= EventHub.#MAX_REMEMBERED) break;
        this.#memory.delete(key);
      }
    } else {
      this.#memory.delete(computerId);
    }
    if (!this.#subs.size) this.#stopSweep();
  }

  /** Close every socket. The session is over, or the process is going away. */
  closeAll(): void {
    for (const [id, sub] of this.#subs) {
      sub.close('the session ended');
      this.#subs.delete(id);
    }
    this.#memory.clear();
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

/**
 * `hello.watching`, or `undefined` for a frame that carried none.
 *
 * `armed` is read as TRUE ONLY, on the same reasoning as `ready` above: an
 * armedness nobody claimed is one to wait for, and waiting on a tree that is
 * already live ends when the next thing happens under it. Concluding a tree is
 * live because a field was malformed is the unrecoverable half — it hands a
 * model a silence it will read as "nothing changed".
 */
const watched = (v: unknown): Watched[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: Watched[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const path = str((e as Record<string, unknown>).path);
    if (!path) continue;
    out.push({ path, armed: (e as Record<string, unknown>).armed === true });
  }
  return out;
};

/**
 * A pause that ends early when the stream is closed.
 *
 * `unref`'d for the reason the idle sweep is: a timer is not a reason for a
 * process to stay alive. The reconnect backoff is the one timer a subscription
 * holds while it has no socket, and a ref'd one kept an stdio server up after
 * its client had gone. Nothing is lost by it — a client that is still attached
 * holds stdin, which keeps the loop running on its own — and it is a backstop
 * rather than the fix: `runStdio` closes the session on stdin EOF, and this is
 * what covers the window where the socket is already down.
 */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    t.unref?.();
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
