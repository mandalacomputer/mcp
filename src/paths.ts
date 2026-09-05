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
/** The JSON Schema for a `mandala/v1` document (platform OPL-3568). */
export const TEMPLATE_SCHEMA = 'templates/schema';
/** Check a document without publishing it. Side-effect free, and claims no ref. */
export const TEMPLATE_VALIDATE = 'templates/validate';
/**
 * Every build this account has started (platform OPL-3791).
 *
 * A collection, like {@link MOVES} and for the same reason: a build is a job
 * rather than a property of a computer, and it outlives the request that
 * started it.
 */
export const BUILDS = 'builds';
export const SIZES = 'sizes';
export const COMPUTERS = 'computers';
export const SNAPSHOTS = 'snapshots';
/**
 * Every move on the account, live and recently finished (OPL-3766).
 *
 * A collection and not `computers/:id/move`, which is the platform's own
 * decision and worth knowing here: a per-computer read could not tell a computer
 * with no move from an id that does not exist, so there is no such route. The
 * poll filters this by `computer_id`.
 */
export const MOVES = 'moves';

/** What the account has used, over a window. Account-scoped, like {@link MOVES}. */
export const USAGE = 'usage';
/**
 * How long automatic snapshots are kept — the plan's retention window.
 *
 * Account-scoped like {@link USAGE} and {@link MOVES}, and answered by the
 * control plane rather than by a hypervisor, so it cannot come back short the
 * way a fleet listing can. Read-only: the plan owns retention, and there is no
 * write on any surface.
 */
export const RETENTION = 'retention';
/**
 * The account's webhook subscriptions (platform OPL-4300; OPL-4306 here).
 *
 * Account-scoped like {@link USAGE}: a subscription receives events from many
 * computers, so it belongs to the account and not to any of them. Answered by
 * the control plane from its own tables, never by a hypervisor.
 */
export const WEBHOOKS = 'webhooks';

/**
 * An RFC 3339 timestamp WITH a time zone, which is the only kind `GET /usage`
 * takes.
 *
 * Checked here rather than left to the platform, because the mistake this
 * catches does not look like one. `2026-08-01T00:00:00` has no zone, and the
 * zone that would have to be assumed is the server's rather than the caller's —
 * so a lenient reading does not fail, it answers a window shifted by however
 * many hours, on the one call whose output somebody compares against a bill. A
 * model writing a date by hand is exactly the caller that produces this.
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** The window to ask about, or undefined for the account's billing period. */
export function usageQuery(from?: string, to?: string): Record<string, string> | undefined {
  const query: Record<string, string> = {};
  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value === undefined) continue;
    if (!RFC3339.test(value)) {
      throw new Error(
        `${name} must be an RFC 3339 timestamp with a time zone, e.g. 2026-08-01T00:00:00Z — ` +
          `got ${JSON.stringify(value)}`,
      );
    }
    query[name] = value;
  }
  // `to` alone is measured from the start of the CURRENT billing period, not
  // from the start of the one `to` falls in, so it answers a window the caller
  // did not ask for rather than failing. Both descriptions say this is refused;
  // this is where it is refused.
  if (to !== undefined && from === undefined) {
    throw new Error(
      'to on its own is measured from the current billing period rather than from the period it ' +
        'names — send from as well to ask about a window that has closed, or omit both for this period',
    );
  }
  return Object.keys(query).length ? query : undefined;
}

/**
 * One path segment, checked before it is encoded.
 *
 * `encodeURIComponent` leaves `.` alone — it is unreserved, so an id of `..`
 * survives it byte for byte — and `new URL` then resolves the dot segment away:
 * `computers/../exec` becomes `/api/v1/exec`, a different route than the tool
 * asked for, reached with the caller's key and reported as whatever that route
 * answers. An id is opaque and never legitimately contains a slash or is a bare
 * run of dots, so those are refused here rather than encoded into something
 * that normalises later.
 */
function segment(kind: string, value: string): string {
  const v = value.trim();
  if (!v) throw new Error(`${kind} must not be empty`);
  if (/^\.+$/.test(v)) throw new Error(`${kind} must not be '${v}'`);
  if (v.includes('/') || v.includes('\\')) {
    throw new Error(`${kind} must not contain a slash: ${v}`);
  }
  return encodeURIComponent(v);
}

export const computer = (id: string) => `computers/${segment('computer_id', id)}`;

/**
 * start | stop | suspend | restart | clone | screenshot | input | exec |
 * windows | files | snapshots | schedule | agent
 */
export const computerAction = (id: string, action: string) => `${computer(id)}/${action}`;

/** A background command's guest pid (OPL-3584). */
export const execHandle = (id: string, pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`pid must be a positive safe integer: ${pid}`);
  }
  return `${computer(id)}/exec/${pid}`;
};

/** One window on the desktop (OPL-3583). The id is `0x2600003`-shaped. */
export const window_ = (id: string, windowId: string) =>
  `${computer(id)}/windows/${segment('window_id', windowId)}`;

/**
 * One published template, by the two halves of its ref (platform OPL-3789).
 *
 * Two segments and not one, because that is the shape of the route: the
 * platform reduces `templates/<a>/<b>` to `templates/:namespace/:name`, so a
 * ref handed over whole — `acc-1/devbox@1.0.0` — would be percent-encoded into
 * one segment and reach a route that does not exist. The version is a QUERY
 * parameter on this path, not part of it; see {@link templateVersionQuery}.
 */
export const templateRef = (namespace: string, name: string) =>
  `${TEMPLATES}/${segment('namespace', namespace)}/${segment('name', name)}`;

/** MAJOR.MINOR.PATCH, no leading zeros — the platform's own version grammar. */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/**
 * The `version` query parameter, refused when it is not a version.
 *
 * Absence and emptiness have to be different things here, and a model is the
 * caller most likely to conflate them. The platform answers 400 for a version
 * that is empty or malformed rather than defaulting, and that refusal exists
 * because of a real defect: `?version=` read as "no version was named" and
 * retired an entire template, irreversibly.
 *
 * This server cannot send that. `undefined` omits the parameter — which on a
 * retire means EVERY version — and anything else has to be a version. A model
 * that passes an empty string is told what a version looks like, before
 * anything is deleted.
 */
export function templateVersionQuery(version?: string): Record<string, string> {
  if (version === undefined) return {};
  if (!VERSION.test(version)) {
    throw new Error(
      `version must be MAJOR.MINOR.PATCH with no leading zeros (got ${JSON.stringify(version)}). ` +
        `Omit it entirely to name the whole template.`,
    );
  }
  return { version };
}

/**
 * The document a publish, a validate or a build sends.
 *
 * Raw bytes, not a JSON envelope: the platform reads JSON or YAML off the body
 * itself, so a wrapper would be a document the validator never sees — and one
 * that parses, so the failure would be a complaint about the wrapper's fields.
 */
export function templateDocument(document: string): Uint8Array {
  if (typeof document !== 'string' || !document.trim()) {
    throw new Error('document must be a non-empty template document, as JSON or YAML');
  }
  return new TextEncoder().encode(document);
}

export const build = (id: string) => `${BUILDS}/${segment('build_id', id)}`;

/** progress | events */
export const buildAction = (id: string, action: string) => `${build(id)}/${action}`;

/**
 * `no_reuse`, sent only when it is asked for.
 *
 * Omitted rather than sent as `false`, and the reason is the documented schema
 * rather than a claim about the parser: lib/apidoc gives this parameter
 * `enum: ['true']`, so `true` is the only value the reference admits.
 *
 * This said the platform reads the key's PRESENCE, which is false —
 * server/buildjob.go reads `Get("no_reuse") == "true"`. The request was right
 * either way; the stated reason was not (/code-review, OPL-3835).
 */
export const buildQuery = (noReuse?: boolean): Record<string, string> =>
  noReuse ? { no_reuse: 'true' } : {};

export const snapshot = (id: string) => `snapshots/${segment('snapshot_id', id)}`;

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
 * SDK's: Firefox by name, not `xdg-open` or one of the other portable wrappers.
 * Naming it keeps the choice in one place — this function is the only thing that
 * decides which browser the guest opens, so a change of image, or of which
 * browser we want, is a change here rather than in every prompt that ever asked
 * for a browser.
 */
export function openUrlCommand(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('url must not be empty');
  // Quoting stops the URL reaching the shell as anything but one argument. It
  // cannot stop the browser reading a leading dash as a flag, and no URL starts
  // with one, so that is refused outright rather than quoted.
  if (trimmed.startsWith('-')) throw new Error(`url must not start with '-': ${trimmed}`);
  // Refused here, where the caller can act on it. `execBody` refuses the same
  // text a moment later, but `open_url` takes no `command` — a refusal naming
  // one, and telling the caller to cut it on a character boundary, names a
  // parameter they cannot see and never passed. `z.string().url()` accepts an
  // unpaired surrogate, so this is the check, not a second opinion.
  if (hasUnpairedSurrogate(trimmed)) {
    throw new Error(
      'url must not contain an unpaired surrogate — half of a character, usually from a string cut ' +
        'through the middle of an emoji. It is not valid UTF-8, so the browser would be asked for an ' +
        'address other than the one you sent.',
    );
  }
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
  env?: Record<string, string>;
}): Json {
  // A NUL ends a C string, and the command is the one field on this route that
  // reaches the guest without anything checking it. `execEnv` below refuses one
  // for this exact reason, and the platform refuses one in `cwd` and in every
  // file path — `validGuestPath` rejects the whole control range — but its only
  // test on `command` is that it is not empty (server/api.go). So a command
  // carrying a NUL is truncated at the guest's argv boundary: a shorter command
  // than the caller wrote runs, and its exit code is reported as an ordinary
  // success. The same shape as the surrogate refusals — a call that works and
  // does something other than what was asked.
  if (args.command.includes('\0')) {
    throw new Error(
      'command must not contain a NUL: a NUL ends a C string, so the guest would run only the part ' +
        'in front of it and report that as a success.',
    );
  }
  // The other half of that same shape. A command cut through the middle of an
  // emoji reaches the guest as U+FFFD — `JSON.stringify` escapes the lone code
  // unit and Go's `encoding/json` decodes it to the replacement character — so
  // a command that is not the one asked for runs, and its exit code is reported
  // as an ordinary success. `cwd` names a directory that then does not exist,
  // which fails loudly, but it is the same corruption and the same refusal.
  if (hasUnpairedSurrogate(args.command)) {
    throw new Error(
      'command must not contain an unpaired surrogate — half of a character, usually from a string ' +
        'cut through the middle of an emoji. It is not valid UTF-8: the guest would receive a ' +
        'replacement character in its place and run a command other than the one you sent, then ' +
        'report that as a success. Send the whole character, or cut the command on a character boundary.',
    );
  }
  if (args.cwd !== undefined && hasUnpairedSurrogate(args.cwd)) {
    throw new Error(
      'cwd must not contain an unpaired surrogate — half of a character, usually from a string cut ' +
        'through the middle of an emoji. It is not valid UTF-8, so the guest would look for a ' +
        'directory whose name is not the one you sent.',
    );
  }
  const body: Json = { command: args.command };
  if (args.timeout_s !== undefined) body.timeout_s = args.timeout_s;
  // Omitted rather than sent empty: the platform's default is the system
  // context, and "desktop" is the only other value it accepts.
  if (args.desktop) body.session = 'desktop';
  if (args.background) body.background = true;
  if (args.cwd) body.cwd = args.cwd;
  const env = execEnv(args.env);
  if (env) body.env = env;
  return body;
}

/**
 * The environment for one command, refused here rather than at the platform.
 *
 * An empty object is dropped rather than sent, for the reason `desktop` is
 * dropped: `execEnvList` returns nil for `len(env) == 0`, so an empty object and
 * an absent one are already the same request, and the one that says so in fewer
 * fields is the one worth sending.
 *
 * The three rules below are checked in this process because the platform checks
 * them AFTER it has resumed the computer. `POST computers/:id/exec` runs its
 * `use` — which wakes a suspended guest and bills the resume — before `Exec`
 * ever looks at the environment, so a malformed name costs a machine coming up
 * to be told no. They are also the rules that will not drift: they are what an
 * entry IS in the list the guest agent takes, `NAME=value` strings separated by
 * NULs, rather than policy. The ceilings on how many entries and how long one
 * may be (64 and 4096 bytes, execbg.go) are policy, are the platform's to
 * change, and are deliberately not repeated here.
 *
 * The `=` case is the one a model actually gets wrong. `{'FOO=bar': ''}` is the
 * assignment written into the name, which is the same mistake as writing the
 * assignment into the command line — so the refusal says the shape rather than
 * just the rule.
 *
 * The UNPAIRED SURROGATE is not one of the platform's rules and is not being
 * mirrored from it. It is this server's own refusal to send text that silently
 * becomes something else, the one {@link clipboardBody}, {@link typeBody} and
 * `write_file` already make: `JSON.stringify` escapes the lone code unit, Go's
 * `encoding/json` decodes it to U+FFFD, and the guest gets an environment value
 * that is not the one the caller asked for while the call reports success. A
 * model emitting half of a truncated emoji is the ordinary way in, and env is
 * the fourth path a caller's own characters take into the guest.
 */
export function execEnv(env?: Record<string, string>): Json | undefined {
  if (!env) return undefined;
  const entries = Object.entries(env);
  if (entries.length === 0) return undefined;
  for (const [name, value] of entries) {
    if (!name) throw new Error('env has an entry with an empty name');
    if (name.includes('=')) {
      throw new Error(
        `env name must not contain '=': ${name}. The name and the value are separate here — pass {FOO: 'bar'}, not {'FOO=bar': ''}.`,
      );
    }
    // A NUL ends a C string, so the guest agent would take the half in front of
    // it and drop the rest without saying so.
    if (name.includes('\0') || value.includes('\0')) {
      throw new Error(`env entry ${name} must not contain a NUL`);
    }
    if (hasUnpairedSurrogate(name) || hasUnpairedSurrogate(value)) {
      throw new Error(`env entry ${name}: ${envSurrogateRefusal}`);
    }
  }
  return Object.fromEntries(entries);
}

const envSurrogateRefusal =
  'that name or value has an unpaired surrogate in it — half of a character, usually from a ' +
  'string cut through the middle of an emoji. It is not valid UTF-8: it reaches the guest as a ' +
  'replacement character, so the command would run with an environment that is not the one you ' +
  'asked for and the call would report success. Nothing was run. Send the whole character, or ' +
  'cut the text on a character boundary.';

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

/**
 * Text typed at the keyboard, checked the way the clipboard's is.
 *
 * The same silent corruption {@link clipboardBody} refuses and `write_file`
 * refuses, on the third path that carries a caller's own characters into the
 * guest: `JSON.stringify` escapes a lone surrogate and Go's `encoding/json`
 * decodes it to U+FFFD.
 *
 * What happens NEXT is this route's own, and it is worth stating precisely
 * rather than borrowing the clipboard's sentence. The platform's `type` handler
 * walks runes and looks each one up in `charKeys` — a printable-ASCII map — and
 * `continue`s past anything it does not find (server/input.go). So the
 * replacement character is not typed onto the desktop; it is DROPPED, and the
 * tool goes on to report `Typed N character(s).` counting the character that
 * never arrived. Either way the screen does not hold what the caller asked for
 * and the answer says it does, which is the thing worth refusing. NOT extended
 * to a NUL for the same reason: the platform skips an unmappable rune rather
 * than truncating the string at it, so a NUL is no more special there than any
 * other unmappable character, and singling it out would be a rule about one
 * codepoint dressed as a rule about corruption (/code-review, OPL-4244).
 */
export function typeBody(text: string): Json {
  if (hasUnpairedSurrogate(text)) throw new Error(typedSurrogateRefusal);
  return { action: 'type', text };
}

const typedSurrogateRefusal =
  'that text has an unpaired surrogate in it — half of a character, usually from a string cut ' +
  'through the middle of an emoji. It is not valid UTF-8: it reaches the guest as a replacement ' +
  'character, which is not a key the desktop can type, so it would be dropped and the count ' +
  'reported back would include it. Nothing was typed. Send the whole character, or cut the text ' +
  'on a character boundary.';

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

/**
 * The body for a window action, with the arguments that action needs.
 *
 * Checked here for the reason `wholePoint` is: the window manager places the
 * frame where it likes and applications snap to their own grid, so a move that
 * arrived with half a coordinate does not come back looking wrong — it comes
 * back looking like the window manager's usual approximation. A `resize` with
 * neither dimension is the same shape of failure, one the platform would have
 * to guess its way out of.
 */
export function windowBody(args: {
  action: WindowAction;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): Json {
  if (args.action === 'move' && (args.x === undefined || args.y === undefined)) {
    throw new Error('move needs both x and y — half a coordinate is not a place');
  }
  if (args.action === 'resize' && args.width === undefined && args.height === undefined) {
    throw new Error('resize needs width, height, or both');
  }
  if (args.action === 'move') return { action: args.action, x: args.x, y: args.y };
  if (args.action === 'resize') {
    return omitUndefined({ action: args.action, width: args.width, height: args.height });
  }
  return { action: args.action };
}

/**
 * The most text `PUT /computers/{id}/clipboard` carries INTO a guest, in bytes.
 *
 * Mirrored so a request that can only fail is not made. NOT machine-checked —
 * `scripts/check-surface.mjs` reads the platform's `web/lib`, and this number
 * lives in its `server/clipboard.go` as `clipboardWriteMax`. It is not
 * arbitrary: the platform puts the text inside one argument of one command,
 * Linux caps a single argv string at 128 KiB, and two layers of base64 stand
 * between the text and that ceiling, so each byte costs about 1.8 of it. Past
 * the cap `execve` fails with E2BIG rather than truncating.
 *
 * The READ cap is 128 KiB, a different bound on a different channel, and is
 * deliberately not mirrored: nothing here can meet it, since that text comes
 * from the guest.
 */
export const MAX_CLIPBOARD_BYTES = 64 * 1024;

/**
 * Said in full, because the model reading it did not choose those bytes on
 * purpose and cannot see them: a lone surrogate arrives from a string that was
 * cut in the middle of an emoji, or from JSON that carried one escaped.
 */
const surrogateRefusal =
  'that text has an unpaired surrogate in it — half of a character, usually from a string cut ' +
  'through the middle of an emoji. It is not valid UTF-8, and sending it would put a replacement ' +
  'character on the desktop rather than what you meant, so nothing was written. Send the whole ' +
  'character, or cut the text on a character boundary.';

/**
 * Whether a string carries half a character.
 *
 * Its own predicate because there is more than one way into this failure and
 * they do not share a refusal sentence. The clipboard's says "on the desktop";
 * `write_file` puts the same broken byte into a file on a disk. What they DO
 * share is the check, and that is the part worth having in one place — a second
 * hand-rolled surrogate walk is a second chance to get the pairing backwards.
 *
 * Walked in UTF-16 code units, because that is what the flaw is made of: a high
 * surrogate is legal where a low one follows it and is half a character
 * anywhere else. `for...of` would not do — it yields the lone surrogate as a
 * string and hides which half it was.
 */
export function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/**
 * The body for a clipboard write, checked before it costs a round trip.
 *
 * Two of these refusals are the platform's own, mirrored so a call that can only
 * fail is not spent. The NUL is the one worth explaining: the platform confirms
 * a write by reading the selection back through a command substitution, and a
 * shell truncates that at the first NUL — so the write would land, the read-back
 * would disagree, and the answer would be a 409 inviting a retry at something
 * that had already worked.
 *
 * The UNPAIRED SURROGATE is not the platform's, and that is exactly why it is
 * here. Nothing refuses it anywhere on the path: `JSON.stringify` escapes the
 * lone code unit, Go's `encoding/json` decodes it to U+FFFD, and the desktop
 * ends up holding a replacement character where a caller's text was. A write
 * that succeeds with different text than was asked for is worse than one that
 * fails, and this is the last place that can tell the difference — `TextEncoder`
 * below has already made the substitution, which is why the scan runs before it.
 * The other two clients refuse it too (mandala-computer-typescript's
 * `clipboardBody`, and mandala-computer-python, where `str.encode` raises).
 *
 * The cap is counted in UTF-8 BYTES rather than characters. An emoji is four of
 * them, so a `text.length` check would pass four times the legal payload to an
 * execve that answers E2BIG.
 */
export function clipboardBody(text: string): Json {
  if (!text) throw new Error('there is no text to put on the clipboard');
  if (text.includes('\0')) {
    throw new Error('that text has a NUL byte in it, which a clipboard cannot carry');
  }
  if (hasUnpairedSurrogate(text)) throw new Error(surrogateRefusal);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_CLIPBOARD_BYTES) {
    throw new Error(
      `that is ${bytes} bytes of text; the clipboard takes at most ${MAX_CLIPBOARD_BYTES}`,
    );
  }
  return { text };
}

/**
 * The body for a capture: what to include, and what to call it.
 *
 * An args object rather than the bare boolean it was, matching `createBody` and
 * `execBody` next to it — `memory` was never going to be the only thing this
 * route took, and a second positional boolean is the kind of call site nobody
 * reads correctly.
 *
 * A name that is only whitespace is dropped rather than sent, and that is the
 * one case worth spelling out. The daemon defaults an EMPTY name to
 * "<computer> <timestamp>" and stores anything else exactly as it arrives (see
 * `newSnapMeta` in the platform's server/snapshot.go), so "   " is the single
 * input that produces a snapshot nobody can pick out of a list — a blank row
 * where the generated name it displaced would have said something.
 */
export function snapshotBody(args: { memory: boolean; name?: string }): Json {
  const name = args.name?.trim();
  return omitUndefined({ memory: args.memory, name: name || undefined });
}

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

/** One webhook subscription. The id is `whk-`-shaped. */
export const webhook = (id: string) => `${WEBHOOKS}/${segment('webhook_id', id)}`;

/** rotate | test | deliveries */
export const webhookAction = (id: string, action: string) => `${webhook(id)}/${action}`;

/** The platform's own caps (`DESCRIPTION_MAX`, `COMPUTERS_MAX` in its lib/webhooks). */
export const WEBHOOK_DESCRIPTION_MAX = 200;
export const WEBHOOK_COMPUTERS_MAX = 64;

/**
 * The body for a webhook create or update — the fields, checked before they
 * cost a round trip.
 *
 * Three of the platform's refusals are mirrored here, because each is a call
 * that can only fail: a url that is not `https:` or carries a username or
 * password, a description over the cap, and a `computers` filter over its cap.
 * The one that is NOT mirrored is the address check — that the hostname resolves
 * to a public address — because it is a DNS answer the platform gets at create
 * time, and a guess made here would be wrong in both directions.
 *
 * `events` and `computers` are de-duplicated rather than refused for repeats,
 * the way the platform stores them. The event vocabulary is not checked at all:
 * the platform refuses an unknown type with a 400 that lists the current ones,
 * and a list held here would refuse a type it had started accepting.
 *
 * Undefined fields are dropped. On an update that is what "leave it as it is"
 * means, and on a create it is what lets the platform apply its defaults.
 */
export function webhookBody(args: {
  url?: string;
  description?: string;
  events?: string[];
  computers?: string[];
  enabled?: boolean;
}): Json {
  let url: string | undefined;
  if (args.url !== undefined) {
    url = args.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`url is not a URL: ${JSON.stringify(args.url)}`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`url must be https://, and this one is ${parsed.protocol}//`);
    }
    if (parsed.username || parsed.password) {
      throw new Error('url must not carry a username or password');
    }
  }
  if (args.description !== undefined && args.description.length > WEBHOOK_DESCRIPTION_MAX) {
    throw new Error(
      `description is ${args.description.length} characters; the platform keeps at most ${WEBHOOK_DESCRIPTION_MAX}`,
    );
  }
  const events = args.events === undefined ? undefined : [...new Set(args.events)];
  // Trimmed BEFORE the de-duplication, and the trimmed ids are what is sent.
  // The tool's schema is a bare array of strings, so whatever a model writes
  // arrives verbatim: `['vm-1', ' vm-1']` deduped to two entries naming one
  // machine, both counted against the platform's cap, and the second of them a
  // filter that matches no computer — a subscription that silently delivers
  // nothing for a machine the caller asked for. `segment()` normalises an id on
  // every other route for the same reason, and `session.ts`'s `id()` lists what
  // it costs not to.
  const computers =
    args.computers === undefined ? undefined : [...new Set(args.computers.map((c) => c.trim()))];
  if (computers?.some((c) => !c)) {
    throw new Error('computers must not contain an empty id');
  }
  if (computers && computers.length > WEBHOOK_COMPUTERS_MAX) {
    throw new Error(
      `computers names ${computers.length} computers; the platform takes at most ${WEBHOOK_COMPUTERS_MAX} — filter at the receiver instead`,
    );
  }
  return omitUndefined({
    url,
    description: args.description,
    events,
    computers,
    enabled: args.enabled,
  });
}
