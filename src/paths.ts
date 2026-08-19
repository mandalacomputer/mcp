/**
 * Every path this server can reach, and every body it can send.
 *
 * Built in one place for the reason mandala-computer-python builds them in one
 * place: the surface test pins what this server calls against the platform's
 * `V1_ROUTES` allowlist, and a URL assembled at a call site is a URL that test
 * cannot see. Anything absent from the allowlist is a 404 in a user's hands
 * rather than a failure here.
 */

export const TEMPLATES = 'templates';
export const SIZES = 'sizes';
export const COMPUTERS = 'computers';
export const SNAPSHOTS = 'snapshots';

export const computer = (id: string) => `computers/${encodeURIComponent(id)}`;

/**
 * start | stop | suspend | restart | clone | screenshot | input | exec |
 * windows | files | snapshots | schedule | agent
 */
export const computerAction = (id: string, action: string) => `${computer(id)}/${action}`;

/** A background command's guest pid (OPL-3584). */
export const execHandle = (id: string, pid: number) => `${computer(id)}/exec/${pid}`;

/** One window on the desktop (OPL-3583). The id is `0x2600003`-shaped. */
export const window_ = (id: string, windowId: string) =>
  `${computer(id)}/windows/${encodeURIComponent(windowId)}`;

export const snapshot = (id: string) => `snapshots/${encodeURIComponent(id)}`;

/** restore | clone */
export const snapshotAction = (id: string, action: string) => `${snapshot(id)}/${action}`;

// --- bodies ---------------------------------------------------------------

type Json = Record<string, unknown>;

/** Drop the keys a caller did not set, rather than sending them as null.
 *
 * Omission is meaningful on create: the platform applies the template's
 * defaults only where a key is absent, so an explicit null overrides a good
 * default with nothing.
 */
export function omitUndefined(body: Json): Json {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

export function createBody(args: {
  name?: string;
  size?: string;
  template?: string;
  cpu?: number;
  ram_mb?: number;
  disk_gb?: number;
  resolution?: string;
  start?: boolean;
}): Json {
  const { start = true, ...rest } = args;
  return { ...omitUndefined(rest as Json), start };
}

/**
 * The shell command that puts a URL on the guest's screen.
 *
 * The browser is named rather than asked for, and the reasoning is the platform
 * SDK's: `xdg-open`, `exo-open`, `sensible-browser` and `x-www-browser` are all
 * on the base image and all exit 0 while launching nothing, because the image's
 * default-browser association points at a desktop entry it does not ship. Exit 0
 * and an unchanged screen is the worst shape a failure can take — a model reads
 * the success, screenshots, sees nothing, and concludes the page is blank.
 *
 * One place, so that when the platform fixes the association (OPL-3376) this is
 * the line that changes rather than every prompt that ever asked for a browser.
 */
export function openUrlCommand(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('url must not be empty');
  // Quoting stops the URL reaching the shell as anything but one argument. It
  // cannot stop the browser reading a leading dash as a flag, and no URL starts
  // with one, so that is refused outright rather than quoted.
  if (trimmed.startsWith('-')) throw new Error(`url must not start with '-': ${trimmed}`);
  return `nohup firefox ${shellQuote(trimmed)} >/dev/null 2>&1 &`;
}

/** POSIX single-quoting: the only characters that survive are the ones inside. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function execBody(args: {
  command: string;
  timeout_s?: number;
  desktop?: boolean;
  background?: boolean;
  cwd?: string;
}): Json {
  const body: Json = { command: args.command };
  if (args.timeout_s !== undefined) body.timeout_s = args.timeout_s;
  // Omitted rather than sent empty: the platform's default is the system
  // context, and "desktop" is the only other value it accepts.
  if (args.desktop) body.session = 'desktop';
  if (args.background) body.background = true;
  if (args.cwd) body.cwd = args.cwd;
  return body;
}

// --- input ----------------------------------------------------------------
//
// The verb set is Anthropic's computer tool, in full, because the platform's
// /input endpoint speaks it and accepts both that vocabulary and a flatter one.
// Which spelling each body uses below is chosen for whichever is unambiguous —
// see the note on scroll, where the two genuinely differ in meaning.

export const MODIFIER_JOIN = '+';

export function pointerBody(action: string, x: number, y: number): Json {
  return { action, x, y };
}

/**
 * Half a coordinate, refused rather than completed with a zero.
 *
 * Same reasoning as `dragBody` below, which has always refused half an origin:
 * a caller naming only `y` meant to name a point, and quietly filling `x` with
 * 0 sends the pointer to the edge of the screen while the tool reports acting
 * "where the pointer was". The action succeeds, at the wrong place, and nothing
 * says so.
 */
function wholePoint(x?: number, y?: number): void {
  if ((x === undefined) !== (y === undefined)) {
    throw new Error('give both x and y, or neither — half a coordinate is not a point');
  }
}

/**
 * A click, optionally at a point and optionally with keys held down.
 *
 * No coordinate means "where the pointer already is", which is a real and
 * different request from clicking (0, 0) — the corner of the screen. So the
 * keys are omitted rather than sent as zeros; the platform carries that
 * distinction all the way down to `inputWire` in server/input.go.
 */
export function clickBody(
  action: string,
  x: number | undefined,
  y: number | undefined,
  modifiers: string[] = [],
): Json {
  wholePoint(x, y);
  const body: Json = { action };
  if (x !== undefined && y !== undefined) {
    body.x = x;
    body.y = y;
  }
  if (modifiers.length) body.text = modifiers.join(MODIFIER_JOIN);
  return body;
}

/**
 * A press, a move and a release — one gesture, not two clicks.
 *
 * Half an origin is refused here rather than dropped. A drag naming only
 * `from_x` reads as a caller who meant to give a starting point, and silently
 * ignoring the half they gave produces a drag that succeeds while selecting a
 * different region: the worst shape a mistake can take, because nothing reports
 * it.
 */
export function dragBody(toX: number, toY: number, fromX?: number, fromY?: number): Json {
  if ((fromX === undefined) !== (fromY === undefined)) {
    throw new Error('give both from_x and from_y, or neither');
  }
  const body: Json = { action: 'left_click_drag', coordinate: [toX, toY] };
  if (fromX !== undefined && fromY !== undefined) body.start_coordinate = [fromX, fromY];
  return body;
}

export function buttonBody(action: string, x?: number, y?: number): Json {
  wholePoint(x, y);
  const body: Json = { action };
  if (x !== undefined && y !== undefined) {
    body.x = x;
    body.y = y;
  }
  return body;
}

export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

/**
 * A wheel scroll, optionally at a point and optionally with keys held.
 *
 * `coordinate` and not the flat pair, and that is not a style choice. The
 * platform reads a flat `x:0, y:0` on a scroll as "no position" — it has to,
 * because that is what every defaulted scroll sent before the keys became
 * optional — so a caller who genuinely means the top-left corner cannot say so
 * that way. `coordinate` has no such history.
 */
export function scrollBody(args: {
  direction: ScrollDirection;
  amount: number;
  x?: number;
  y?: number;
  modifiers?: string[];
}): Json {
  const body: Json = {
    action: 'scroll',
    scroll_direction: args.direction,
    amount: args.amount,
  };
  wholePoint(args.x, args.y);
  if (args.x !== undefined && args.y !== undefined) {
    body.coordinate = [args.x, args.y];
  }
  if (args.modifiers?.length) body.text = args.modifiers.join(MODIFIER_JOIN);
  return body;
}

export const typeBody = (text: string): Json => ({ action: 'type', text });

export function keyBody(keys: string[], holdSeconds?: number): Json {
  if (!keys.length) throw new Error('press_key needs at least one key');
  if (holdSeconds === undefined) return { action: 'key', keys };
  if (holdSeconds <= 0) throw new Error('hold_seconds must be positive');
  return { action: 'hold_key', keys, duration: holdSeconds };
}

/**
 * A pause inside the guest.
 *
 * Capped at 30 seconds by the platform, and asking for longer is refused rather
 * than truncated — a wait here is a held HTTP request crossing a reverse proxy,
 * and 100 seconds would not return, it would fail. The cap is checked here too
 * so a model learns the limit from the tool's own error instead of spending a
 * round trip on it.
 */
export function waitBody(seconds: number): Json {
  if (seconds <= 0) throw new Error('seconds must be positive');
  if (seconds > 30)
    throw new Error('the platform caps a wait at 30 seconds; ask again to wait longer');
  return { action: 'wait', duration: seconds };
}

export const cursorBody = (): Json => ({ action: 'cursor_position' });

// --- windows, snapshots, schedule -----------------------------------------

export const WINDOW_ACTIONS = [
  'focus',
  'raise',
  'minimize',
  'maximize',
  'unmaximize',
  'close',
  'move',
  'resize',
] as const;
export type WindowAction = (typeof WINDOW_ACTIONS)[number];

export function windowBody(args: {
  action: WindowAction;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): Json {
  return omitUndefined({ ...args });
}

export const snapshotBody = (memory: boolean): Json => ({ memory });

export function scheduleBody(args: {
  enabled: boolean;
  hour: number;
  minute?: number;
  tz?: string;
}): Json {
  const { enabled, hour, minute = 0, tz = 'UTC' } = args;
  if (hour < 0 || hour > 23) throw new Error('hour must be 0-23');
  if (minute < 0 || minute > 59) throw new Error('minute must be 0-59');
  return { enabled, hour, minute, tz };
}

export function agentBody(args: {
  prompt: string;
  max_steps?: number;
  system?: string;
  stream: boolean;
}): Json {
  return omitUndefined({ ...args } as Json);
}
