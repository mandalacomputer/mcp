#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULT_BASE_URL } from './api.js';
import { runHttp } from './http.js';
import { SERVER_VERSION } from './server.js';
import { runStdio } from './stdio.js';

const USAGE = `mandala-computer-mcp — drive a Mandala Computer desktop over MCP

  mandala-computer-mcp                 stdio (what an MCP client spawns)
  mandala-computer-mcp --http [--port 3000]   hosted, callers bring their own key

Environment
  MANDALA_API_KEY      com_… from Settings → API keys. Required on stdio; over
                       HTTP each caller sends their own as a bearer token.
  MANDALA_BASE_URL     default ${DEFAULT_BASE_URL}
  MANDALA_COMPUTER_ID  bind a computer at startup, so use_computer is not needed.
                       stdio only — over HTTP it is ignored rather than bound
                       into every caller's session
  MANDALA_MODEL_KEY    an Anthropic key; enables the run_agent tool. stdio only
                       — over HTTP each caller sends their own X-Model-Key, and
                       this is ignored rather than spent on their runs
  MANDALA_NO_LIFECYCLE 1, true, yes or on to withhold create_computer,
                       clone_computer, clone_snapshot, delete_computer and
                       delete_snapshot. Any other value is refused rather than
                       read as off, since a typo here would leave them enabled
  PORT, HOST           for --http (default 3000, 127.0.0.1)
  MANDALA_ALLOWED_HOSTS, MANDALA_ALLOWED_ORIGINS
                       comma-separated; which Host and Origin values to answer
                       to. A loopback bind defaults to the address it was given,
                       so rebinding protection is on without configuration

Flags override the environment.`;

type Flags = Record<string, string | boolean>;

/**
 * The flags that are a yes-or-no and never take a value.
 *
 * Without this list every flag eats the next token, so `--http false` sets
 * `http` to the string "false" — which is truthy, and starts the HTTP server
 * the user just said they did not want. `--no-lifecycle false` withheld the
 * lifecycle tools for the same reason. A flag that means "on" is on by being
 * present, and anything following it is the next argument, not its value.
 */
const BOOLEAN = new Set(['help', 'h', 'version', 'v', 'http', 'no-lifecycle']);

/**
 * The yes-or-no flags whose VALUE is checked against a vocabulary.
 *
 * Not all of them, because the argument for refusing an unrecognised spelling
 * does not reach the other four. `--http` and `--no-lifecycle` decide what the
 * server exposes, so reading a misspelled no as a yes arms something — a
 * listener nobody asked for, or the withholding of tools somebody wanted.
 * `--help` and `--version` print and exit: nothing is armed either way, and
 * refusing `--help=` would turn the one flag people reach for when they are
 * already confused into another error. They keep the older, looser reading.
 */
const CHECKED = new Set(['http', 'no-lifecycle']);

const KNOWN = new Set([
  ...BOOLEAN,
  'port',
  'host',
  'base-url',
  'computer',
  'key',
  'allowed-hosts',
  'allowed-origins',
]);

/** What `--http=…` may say to mean no. */
const FALSEY = new Set(['false', '0', 'no', 'off']);

/** And its mirror, for the environment variables that are a yes-or-no. */
const TRUTHY = new Set(['true', '1', 'yes', 'on']);

/**
 * The value of a yes-or-no FLAG, refusing a spelling it does not know.
 *
 * The same vocabulary and the same refusal as {@link envFlag} below, because
 * `--no-lifecycle=…` and `MANDALA_NO_LIFECYCLE=…` are two spellings of one
 * control and it would be a poor joke for them to disagree about what `yes`
 * means. Only the wording of the message differs, since one names a flag and
 * the other a variable.
 */
function boolFlag(name: string, inline: string): boolean {
  const v = inline.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSEY.has(v)) return false;
  throw new Error(
    `--${name}=${inline} is not a yes or a no. Use one of ${[...TRUTHY].join(', ')} to turn it ` +
      `on — as does --${name} with no value at all — or one of ${[...FALSEY].join(', ')} to ` +
      'turn it off.',
  );
}

/**
 * A yes-or-no environment variable, refusing a spelling it does not know.
 *
 * REFUSED rather than read as no, which is the decision worth recording.
 * `MANDALA_NO_LIFECYCLE` withholds the tools that create and delete computers,
 * so it is a safety control, and the two wrong answers do not cost the same: an
 * unrecognised value read as "no" leaves those tools registered on a server
 * whose operator believes they are gone, and says nothing. A typo is far more
 * likely than a deliberate `MANDALA_NO_LIFECYCLE=ture`, and the loud version
 * costs one clear line at startup.
 *
 * Empty is unset, as everywhere else here — the ordinary shape of an unquoted
 * assignment in a compose file, and `env` has already turned it into undefined.
 */
function envFlag(name: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  // Here as well as in `env`, rather than only there. `env` folds an empty
  // variable to undefined before this sees it, but that is the caller's
  // behaviour and this reads as a general helper — `lifecycleEnabled` takes its
  // value as a parameter, so a caller passing `process.env.X` straight in would
  // otherwise refuse to start over `X=`, which is what an unquoted assignment
  // in a compose file writes and what plugin.json's `${MANDALA_NO_LIFECYCLE:-}`
  // expands to when it is unset.
  if (!v) return false;
  if (TRUTHY.has(v)) return true;
  if (FALSEY.has(v)) return false;
  throw new Error(
    `${name}=${raw} is not a yes or a no. Use one of ${[...TRUTHY].join(', ')} to turn it on, ` +
      `or one of ${[...FALSEY].join(', ')} (or leave it unset) to turn it off.`,
  );
}

/**
 * argv into flags.
 *
 * Exported for the tests, which is worth one line of surface: this is the one
 * place a mistyped value becomes a credential or a URL that is subtly not what
 * was typed, and the failure it produces surfaces somewhere else entirely.
 */
export function parse(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Single-dash short forms, for the two that every CLI is expected to
    // answer. Skipping anything without a `--` meant `-h` fell through to a
    // normal startup and exited 2 with "No API key" — the one message least
    // like the help that was asked for. Only these two: a general short-flag
    // grammar would have to guess which take values, and none of the rest here
    // has a short form to guess about.
    if (arg === '-h' || arg === '-v') {
      flags[arg === '-h' ? 'help' : 'version'] = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(
        `unexpected argument ${arg}. This program takes flags, not commands — try --help.`,
      );
    }
    // Split at the first `=`, not with `split('=', 2)` — the limit argument
    // discards the remainder rather than keeping it, so `--key=com_a=b` would
    // silently yield `com_a`. Values with an `=` in them are the ordinary case
    // here: API keys, base URLs with a query, and allowed-origin lists.
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const name = eq < 0 ? body : body.slice(0, eq);
    const inline = eq < 0 ? undefined : body.slice(eq + 1);
    if (!KNOWN.has(name)) {
      throw new Error(
        `unknown flag --${name}. Valid flags are: ${[...KNOWN].map((flag) => `--${flag}`).join(', ')}`,
      );
    }
    // `--http=false` has to mean false. It is the one spelling that carries an
    // explicit answer, and reading it as the truthy string "false" would turn
    // the clearest way to say no into a yes.
    //
    // Matched against BOTH vocabularies rather than "anything that is not a no
    // is a yes", which is what this was and which made a misspelling of a NO
    // into a YES. `--http=ture` started a network listener the operator was
    // trying not to start, and `--no-lifecycle=fasle` withheld the tools that
    // make and destroy computers from someone who meant to keep them. The
    // second fails safe and the first does not, so the loose reading had to go
    // (OPL-4515).
    //
    // Refused rather than defaulted, which is the same call `envFlag` makes one
    // screen up for the environment half of the same controls, and the message
    // is deliberately its twin. An empty `--http=` is refused too: it is
    // neither a yes nor a no, and `--port=` is already refused for being
    // neither a number nor absent. Refusing is also the only answer to `--http=`
    // that neither arms nor disarms — reading it as "off" would let a launcher
    // template whose variable failed to expand quietly turn a safety control
    // off, which is the failure this whole change is about.
    //
    // Only the flags in CHECKED: `--help` and `--version` arm nothing, so the
    // argument does not reach them and they keep the looser reading.
    if (BOOLEAN.has(name)) {
      flags[name] =
        inline === undefined
          ? true
          : CHECKED.has(name)
            ? boolFlag(name, inline)
            : !FALSEY.has(inline.trim().toLowerCase());
    } else if (inline !== undefined) flags[name] = inline;
    // PRESENT, not truthy. `--key ""` is a value token like any other, and a
    // truthiness test skipped it: the flag became the boolean `true` and the
    // empty token came round again as a stray argument, so the two spellings of
    // one flag disagreed — `--key=` is the empty value `str()` documents, while
    // `--key ""` died with `unexpected argument .`, naming nothing the user
    // could act on.
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return flags;
}

/**
 * Did these flags ask for the help, or for the version?
 *
 * Both spellings of each, and exported for the same reason `parse` is: `--v`
 * parses to a `v` flag that nothing then read, so it started a server instead
 * of printing a number, while `--h` had always been handled. The asymmetry was
 * invisible in `parse`'s own output — the flag was there, and the failure was
 * the one line further down that did not look for it.
 */
export const wantsHelp = (flags: Flags): boolean => Boolean(flags.help || flags.h);
export const wantsVersion = (flags: Flags): boolean => Boolean(flags.version || flags.v);

/** Whether lifecycle tools survive the flag/environment precedence rules. */
export function lifecycleEnabled(flags: Flags, configured = env('MANDALA_NO_LIFECYCLE')): boolean {
  // Presence is what establishes precedence. `--no-lifecycle=false` carries a
  // false value deliberately and must not fall through to a true environment.
  // Validated before precedence is applied, and that ordering is the point. A
  // misspelling is a mistake to report whether or not a flag happens to sit in
  // front of it: an operator who set MANDALA_NO_LIFECYCLE=ture meaning to
  // withhold the tools, under a launcher that also passes --no-lifecycle=false,
  // would otherwise get exactly the silent arming this refusal exists to stop.
  const fromEnv = envFlag('MANDALA_NO_LIFECYCLE', configured);
  const disabled = Object.hasOwn(flags, 'no-lifecycle') ? Boolean(flags['no-lifecycle']) : fromEnv;
  return !disabled;
}

/**
 * The port to listen on, or a refusal naming what was wrong with it.
 *
 * `--port` with nothing after it parses as the boolean true, and `Number(true)`
 * is 1 — a privileged port nobody asked for, which also swallows the PORT
 * environment variable on the way past, since `??` sees a value. Better to say
 * so than to fail later with EACCES on a number the user never typed.
 */
export function port(flag: string | boolean | undefined): number {
  if (flag === true) throw new Error('--port needs a number, e.g. --port 3000');
  // A flag that is PRESENT decides, even when it is empty — the same rule `str`
  // applies to every other value flag, and the one the usage text promises when
  // it says flags override the environment. `--port=` used to trim to `''` and
  // fall through `||` to PORT, so the clearest way to say "not the environment's
  // port" silently deferred to the environment. It is not a port either, so it
  // is refused rather than turned into the default.
  if (typeof flag === 'string' && !flag.trim()) {
    throw new Error('--port needs a number, e.g. --port 3000');
  }
  // `??` is not enough here: PORT='' is a set-but-empty variable, which is the
  // ordinary shape of an unset value in shell and compose files, and it passes
  // `??` intact. `Number('')` is 0, which passes every check below and means
  // "any free port" — so a server asked for 3000 bound something random and
  // said so only in a line nobody reads.
  const given = typeof flag === 'string' ? flag.trim() : '';
  const fromEnv = process.env.PORT?.trim() ?? '';
  const raw = given || fromEnv || '3000';
  // Decimal digits only. `Number('0x12')` is 18 and `Number('1e3')` is 1000,
  // both integers in range, so they used to bind those ports — the same
  // `Number()` footgun this function already refuses for `true` and `''`.
  // `contentLength` already gates on `/^\d+$/` before converting (adversarial
  // review, OPL-4314).
  if (!/^\d+$/.test(raw)) {
    throw new Error(`not a port number: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`not a port number: ${raw}`);
  }
  return n;
}

/**
 * A flag's value as a string, or a refusal naming the flag.
 *
 * `--key` with nothing after it parses as the boolean `true`, and every one of
 * these values is then used as a string. Cast rather than checked, that ends as
 * `Authorization: Bearer true` — a 401 from the platform that names nothing a
 * reader could act on — or, for `--base-url`, a TypeError thrown from inside
 * `String.prototype.replace` that mentions neither the flag nor the mistake.
 * `port()` has always said so for its own flag; this says it for the rest.
 */
export function str(flag: string | boolean | undefined, name: string): string | undefined {
  if (flag === true) throw new Error(`--${name} needs a value, e.g. --${name} <value>`);
  if (flag === false || flag === undefined) return undefined;
  // `--key=` is a value, and an empty one. `flag || undefined` folded it back
  // into "not given", so the environment answered instead and the flag the
  // usage text promises would override it did the opposite of nothing — it
  // silently deferred. Trimmed for the reason `env` below is: an id or a key
  // that arrived through a shell with a newline on it is not a different id.
  return flag.trim();
}

/**
 * An environment variable, trimmed, and absent when that leaves nothing.
 *
 * `port()` has always done this and the rest did not, which is a strange place
 * to draw the line: the values that arrive with whitespace on them are the ones
 * read out of a `.env` file, a Kubernetes secret or a `docker run --env-file`,
 * and those carry keys, base URLs and computer ids far more often than they
 * carry ports. Each failed differently and none of them named the cause — a
 * trailing newline on an API key is rejected by Node's own header validation
 * before the request is made, one on a base URL parses into a hostname nothing
 * resolves, and one on a computer id reaches the platform trimmed while staying
 * untrimmed in this process. An empty variable is treated as unset, which is
 * what an unquoted assignment in a compose file usually means.
 */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

const list = (v: string | undefined) =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

async function main(): Promise<void> {
  const flags = parse(process.argv.slice(2));
  if (wantsHelp(flags)) {
    console.log(USAGE);
    return;
  }
  if (wantsVersion(flags)) {
    // The same constant the server reports over the protocol. Printed from two
    // places, a `--version` and an initialize response drift apart silently,
    // and the number people quote in a bug report is the one that lies.
    console.log(SERVER_VERSION);
    return;
  }

  // `??` rather than `||` throughout, now that `str` distinguishes "not given"
  // from "given as empty". `--base-url=` means the default, not the
  // environment; a flag that is present says what it says.
  const base = {
    baseUrl: (str(flags['base-url'], 'base-url') ?? env('MANDALA_BASE_URL')) || DEFAULT_BASE_URL,
    computerId: str(flags.computer, 'computer') ?? env('MANDALA_COMPUTER_ID'),
    modelKey: env('MANDALA_MODEL_KEY'),
    lifecycle: lifecycleEnabled(flags),
  };

  if (flags.http) {
    await runHttp({
      ...base,
      port: port(flags.port),
      host: (str(flags.host, 'host') ?? env('HOST')) || '127.0.0.1',
      allowedHosts: list(
        str(flags['allowed-hosts'], 'allowed-hosts') ?? env('MANDALA_ALLOWED_HOSTS'),
      ),
      allowedOrigins: list(
        str(flags['allowed-origins'], 'allowed-origins') ?? env('MANDALA_ALLOWED_ORIGINS'),
      ),
    });
    return;
  }

  const fromFlag = str(flags.key, 'key');
  const apiKey = fromFlag ?? env('MANDALA_API_KEY') ?? '';
  // An argument vector is not a private place. `--key com_…` is readable by any
  // `ps` on the machine, is what a shell writes into its history, and is what a
  // process-exec audit log records verbatim — none of which is true of the
  // environment variable that does the same job. The flag stays, because a
  // caller launching several servers under different keys has a real use for
  // it, but it should not be the quiet default anybody reaches for. Warned
  // rather than refused, and the value itself is never echoed.
  if (fromFlag) {
    console.error(
      'WARNING: --key puts your API key in this process’s command line, where `ps`, the shell ' +
        'history and any exec audit log can read it. Prefer MANDALA_API_KEY.',
    );
  }
  if (!apiKey) {
    // stderr and a non-zero exit, not a thrown stack. On stdio the client sees
    // a process that died; the person reading the log needs the one sentence
    // that tells them what to set.
    console.error(
      'No API key. Set MANDALA_API_KEY (Settings → API keys at https://app.mandala.computer), ' +
        'or run with --http and let each caller send their own.',
    );
    process.exit(2);
  }
  await runStdio({ ...base, apiKey });
}

/**
 * Is this module the program, rather than something a test imported?
 *
 * argv[1] is resolved through symlinks first, and that is the point rather
 * than a nicety: npm installs `bin` as a symlink under node_modules/.bin, Node
 * resolves the ESM entry through it but leaves argv[1] as the symlink path, so
 * the raw comparison never matched. `npx mandala-computer-mcp` — every client
 * spawning the installed binary — exited 0 with no server and no message.
 */
export function isEntrypoint(moduleUrl: string, arg: string | undefined): boolean {
  if (!arg) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(arg)).href;
  } catch {
    // argv[1] naming something unreadable is not this file being run.
    return false;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
