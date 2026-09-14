#!/usr/bin/env node
/**
 * Diff the mirrors in test/allowlist.ts against the platform's published
 * surface manifest — the routes, the parameters each route takes, and the
 * numeric limits this server refuses against.
 *
 * The mirror is the thing that keeps this server honest about what exists, and
 * a mirror nobody compares is just a comment. This does the comparison whenever
 * the platform repo happens to be checked out — next door by default, or
 * wherever MANDALA_PLATFORM_REPO points.
 *
 * The parameter half exists because the route half was not enough, and this
 * repository is where that was proved. `Range` landed on `GET
 * computers/:id/files` in OPL-3727, with this server named in the commit
 * message as the caller it was for, and this script said "in step with
 * the platform (N routes)" the whole time — because a header is a new
 * PARAMETER on a route that already existed, and a route table cannot see one.
 * The call lands in the right place either way; the only thing missing is the
 * argument that made it worth making. read_file went on telling models it
 * "cannot page" for as long as nobody happened to read the platform's changelog.
 *
 * The limits half is new (OPL-4851) and closes the same kind of hole one step
 * further out. `src/paths.ts` turns away a clipboard write over 64 KiB and a
 * webhook description over 200 characters before the request is made, to save a
 * round trip. Nothing compared those numbers to the platform's, so a ceiling
 * that drifted upward would have this server refusing calls the platform would
 * have taken — with no failure anywhere, because the request that would have
 * proved it is the one never sent. What a model is told about a refusal it
 * cannot see through is the whole of what it knows.
 *
 * Exits 0 and says so when the platform repo is not checked out. That is the
 * ordinary case in CI on this repository, and failing over it would make the
 * check something people learn to ignore. What is not that case is an operator
 * who named a directory: `MANDALA_PLATFORM_REPO` is an assertion that the repo
 * is at that path, and a path that turns out not to hold it is a mistake to
 * report rather than a repo to go looking for elsewhere.
 *
 * Where it is enforced is the platform's own CI, which checks this repo out
 * beside itself and runs this script against it (OPL-3916). This repository had
 * a job of its own that did the reverse, and it never once ran: the token it
 * needed was never set, so every run printed the skip above and passed. Beyond
 * that, what this prints is routes, parameters and limits that have not shipped
 * yet, and this repository's Actions logs are world-readable the day it goes
 * public, where the platform's are not.
 *
 * So on a machine that has both this is what catches drift before a push, and
 * everywhere else it is what the platform runs.
 *
 * NOTHING HERE PARSES TYPESCRIPT ANY MORE (OPL-4851)
 * =================================================
 *
 * This script used to read the platform's `web/lib/surface.ts` and
 * `web/lib/apidoc.ts` as TEXT, through ~860 lines of hand-written scanner in
 * `scripts/surface-text.mjs`, and to read its own mirror with regexes over
 * `test/allowlist.ts`.
 *
 * Across eleven adversarial review rounds the three clients' scanners produced,
 * and then closed, at least a dozen distinct FAIL-OPENS — runs that printed "the mirror
 * matches the platform" without having read it. A `.concat` after the leading
 * array. A decoy table inside a type annotation. A projection callback that
 * ignored its argument. `.add` after the constructor. An extra callback
 * parameter whose default ran. A computed key in a destructured parameter. A
 * type assertion that was really a comparison chain. A line comment ended by a
 * carriage return. Each was fixed and the next spelling arrived, because
 * recognising TypeScript is a TypeScript parser's job and this was not one.
 *
 * Both sides are now read rather than recognised:
 *
 * - The platform's, from `surface-manifest.json` (platform OPL-4827), which it
 *   generates from the same tables its API reference and OpenAPI document are
 *   built from. One `JSON.parse`.
 * - This repo's, by importing `test/allowlist.ts` directly. Node strips the
 *   types; the tables arrive as the objects the suite itself uses, so there is
 *   no second reading of the mirror that can disagree with the first.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

/**
 * What identifies a platform checkout, and what is then required of it.
 *
 * Asking for both at once conflates two different answers: "this directory is
 * not the platform, so there is nothing here to compare" and "this is the
 * platform and a file this reads has moved" — and the second, answered as the
 * first, takes the whole gate down silently.
 *
 * The MARKER is deliberately NOT the manifest, even though the manifest is now
 * the only platform file read. A marker and a read file have opposite failure
 * modes: make them the same and a checkout that has LOST its manifest stops
 * being recognised as the platform at all, so the loud "a platform checkout
 * with no …" at exit 1 becomes a silent "platform repo not found, skipping" at
 * exit 0. That is the original fail-open, wearing a tidier hat.
 */
export const MARKER = 'web/lib/surface.ts';
export const MANIFEST = 'surface-manifest.json';

/** The manifest layouts this reader understands. */
const SUPPORTED_VERSIONS = new Set([1]);

/** The platform checkout to compare against, or null when there is none. */
function platformRepo() {
  // Resolved against this repo the way the guesses below are. Left raw it
  // resolves against the working directory instead, so the same value means two
  // different directories depending on where npm was invoked, and the "Looked
  // in" line prints one relative path beside two absolute ones — which reads as
  // the directory the operator meant rather than the one that was searched.
  const asked = process.env.MANDALA_PLATFORM_REPO
    ? resolve(repo, process.env.MANDALA_PLATFORM_REPO)
    : undefined;
  const candidates = [
    asked,
    resolve(repo, '..', 'mandala-computer'),
    resolve(repo, '..', 'app'),
  ].filter(Boolean);

  if (asked && !existsSync(join(asked, MARKER))) {
    // The one machine where this gate is enforced is the one that sets this
    // variable, for three SDKs at once. A checkout path that moves, or a
    // variable that fails to expand, would otherwise be indistinguishable from
    // "no platform here" — three green no-ops, three surface mirrors nobody
    // compared, on the only run that compares them.
    console.error(
      `check:surface — MANDALA_PLATFORM_REPO is set to ${asked}, which does not hold ${MARKER}.\n` +
        '  Point it at a platform checkout, or unset it to skip the comparison.',
    );
    process.exitCode = 1;
    return null;
  }

  const found = candidates.find((dir) => existsSync(join(dir, MARKER)));
  if (!found) {
    console.log(
      'check:surface — platform repo not found, skipping.\n' +
        `  Looked in: ${candidates.join(', ')}\n` +
        `  Set MANDALA_PLATFORM_REPO to compare against ${MANIFEST}.`,
    );
    return null;
  }

  if (!existsSync(join(found, MANIFEST))) {
    console.error(
      `check:surface — ${found} is a platform checkout with no ${MANIFEST}.\n` +
        '  That file IS the comparison, so its absence is drift rather than a reason to\n' +
        '  skip: either the platform stopped generating it, or this is a partial checkout.',
    );
    process.exitCode = 1;
    return null;
  }
  return found;
}

/**
 * The first key named twice in one object, anywhere in `text`, or null.
 *
 * Only ever called on text `JSON.parse` has already accepted, which is what
 * makes this total: it never has to decide whether the document is valid, only
 * where its object keys are.
 *
 * A string literal is the one construct that can hide a `{`, `}` or `:`, so
 * skipping strings correctly — respecting backslash escapes — is the whole of
 * the work. Within an object, a string is a KEY when it is the first token
 * after `{` or after a `,` at that object's own depth; `:` ends that position.
 * Arrays push a frame too, so `[{"a":1},{"a":2}]` is two objects and not a
 * duplicate.
 */
function duplicateKey(text) {
  // One frame per `{` or `[`. `keys` is null for an array frame, and
  // `expectKey` says whether the next string at this depth is a key.
  const stack = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // The whole quoted token, quotes included, so it can be DECODED. Compared
      // raw, `"routes"` and `"\u0072outes"` are two different spellings — and
      // they are one key to `JSON.parse`, so the second silently replaces the
      // first and this would have seen no duplicate at all. Every escape is the
      // same hole: `\/`, `\"`, `\\`.
      const start = i;
      for (i++; text[i] !== '"'; i++) if (text[i] === '\\') i++;
      const top = stack[stack.length - 1];
      if (expectKey && top?.keys) {
        // Safe: this only ever runs on text `JSON.parse` has already accepted,
        // so the token between these quotes is a valid JSON string.
        const key = JSON.parse(text.slice(start, i + 1));
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        expectKey = false;
      }
      continue;
    }
    if (ch === '{') {
      stack.push({ keys: new Set() });
      expectKey = true;
    } else if (ch === '[') {
      stack.push({ keys: null });
      expectKey = false;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      expectKey = false;
    } else if (ch === ',') {
      expectKey = Boolean(stack[stack.length - 1]?.keys);
    }
  }
  return null;
}

/**
 * The platform's inventory of its own v1 surface, or a thrown explanation.
 *
 * Every shape this cannot read throws. Reading JSON removes the grammar that
 * defeated the old scanner; it does not by itself remove the failure mode,
 * because a missing key read as an empty table is the same green run over
 * nothing. So none of these may be forgiven:
 *
 * - a file that is not JSON, or is JSON that is not an object;
 * - a `version` this reader does not know, which is the sharpest of them — a
 *   future layout that moved `parameters` under a new key reads, leniently, as
 *   a platform that documents no parameters at all;
 * - a missing top-level key, a malformed route, a duplicate route, a parameter
 *   table naming a route that is not in `routes`, a parameter with no
 *   `query:`/`header:`/`body:` kind, or a non-integer limit.
 */
function readManifest(platform) {
  const path = join(platform, MANIFEST);
  const bad = (why) => new Error(`${MANIFEST} ${why}`);

  const text = readFileSync(path, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw bad(`could not be read as JSON: ${err.message}`);
  }
  // `JSON.parse` keeps the LAST occurrence of a repeated key and says nothing,
  // at every depth — and a reviver cannot see it, because the object is already
  // built by the time the reviver runs. So a manifest carrying two `routes`
  // tables, two entries for one route under `parameters`, or one limit written
  // twice with different values would be compared against whichever copy came
  // last, with the other discarded before any check below saw it: a green run
  // over data this never read.
  //
  // Found by an adversarial review of the Python SDK's copy of this check,
  // where `object_pairs_hook` closes it in one line. There is no such hook here,
  // hence `duplicateKey` — which is a scanner, and therefore worth saying why it
  // is not the thing this change deletes. JSON's grammar is tiny and total, the
  // text has ALREADY been accepted by a real parser before this looks at it, and
  // the only construct that can hide a brace or a colon is a string literal,
  // which is four lines to skip correctly. A bug in it refuses a manifest that
  // was fine; a bug in the TypeScript reader accepted a platform it had not read.
  // `!== null`, not truthiness. A repeated EMPTY key returns `''`, and a
  // truthiness test reads that as "no duplicate" — so `{"":0,"":1,...}` ahead of
  // a conflicting table disabled the rest of this scan entirely.
  const duplicate = duplicateKey(text);
  if (duplicate !== null) throw bad(`names ${JSON.stringify(duplicate)} twice in one object`);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw bad('is not a JSON object');
  }
  if (!Number.isInteger(data.version)) {
    throw bad(`has no integer 'version' (got ${JSON.stringify(data.version)})`);
  }
  if (!SUPPORTED_VERSIONS.has(data.version)) {
    throw bad(
      `is version ${data.version}, and this reader knows ${[...SUPPORTED_VERSIONS].join(', ')}. ` +
        'Teach it the new layout rather than comparing against a guess',
    );
  }
  for (const key of ['routes', 'parameters', 'limits']) {
    if (!(key in data)) throw bad(`has no '${key}'`);
  }

  if (!Array.isArray(data.routes) || data.routes.length === 0) {
    throw bad("'routes' is not a non-empty array");
  }
  const routes = new Set();
  for (const entry of data.routes) {
    if (typeof entry !== 'string') {
      throw bad(`'routes' holds a non-string entry: ${JSON.stringify(entry)}`);
    }
    // One space, method first. A pattern cannot contain a space, so a second
    // one is a malformed entry rather than something to normalise away.
    const space = entry.indexOf(' ');
    const method = space === -1 ? '' : entry.slice(0, space);
    const pattern = space === -1 ? '' : entry.slice(space + 1);
    if (!method || !pattern || method !== method.toUpperCase() || pattern.includes(' ')) {
      throw bad(`'routes' entry is not 'METHOD pattern': ${JSON.stringify(entry)}`);
    }
    if (routes.has(entry)) throw bad(`'routes' lists ${JSON.stringify(entry)} twice`);
    routes.add(entry);
  }

  const documented = data.parameters;
  if (documented === null || typeof documented !== 'object' || Array.isArray(documented)) {
    throw bad("'parameters' is not an object");
  }
  // The manifest omits a route that documents none, so those are filled back in
  // as empty sets. Read literally it would be 27 routes "no longer documented
  // upstream" on a mirror that is exactly right — the kind of noise that gets a
  // check ignored, which is the failure one step past a false green.
  const parameters = new Map([...routes].map((route) => [route, new Set()]));
  for (const [route, names] of Object.entries(documented)) {
    if (!routes.has(route)) {
      throw bad(`'parameters' documents '${route}', which is not in 'routes'`);
    }
    if (!Array.isArray(names)) throw bad(`'parameters' for '${route}' is not an array`);
    const set = new Set();
    for (const name of names) {
      if (typeof name !== 'string') {
        throw bad(`'parameters' for '${route}' holds a non-string: ${JSON.stringify(name)}`);
      }
      // An unprefixed name would compare equal to nothing in the mirror and
      // read as one missing parameter plus one stale one, which describes a
      // reader that has lost the vocabulary rather than a platform that changed.
      if (!/^(query|header|body):/.test(name)) {
        throw bad(
          `'parameters' for '${route}' holds '${name}', which names no query:, header: ` +
            'or body: field',
        );
      }
      set.add(name);
    }
    parameters.set(route, set);
  }

  const published = data.limits;
  if (published === null || typeof published !== 'object' || Array.isArray(published)) {
    throw bad("'limits' is not an object");
  }
  const limits = new Map();
  for (const [key, value] of Object.entries(published)) {
    if (!Number.isInteger(value)) {
      throw bad(`'limits' entry '${key}' is ${JSON.stringify(value)}, which is not an integer`);
    }
    limits.set(key, value);
  }

  return { routes, parameters, limits };
}

/**
 * Whether this module was RUN rather than imported.
 *
 * Same shape as check-internals.mjs's, and for the same reason: the test suite
 * imports this file to read {@link MARKER} and {@link MANIFEST} rather than
 * spelling a platform path of its own, and an import that ran the gate would
 * compare the real checkout as a side effect of collecting tests.
 */
function isEntrypoint() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // An importing process can have an argv entry that is not a file.
    return false;
  }
}

if (isEntrypoint()) await main();

async function main() {
  const platform = platformRepo();
  if (!platform) return;

  let manifest;
  try {
    manifest = readManifest(platform);
  } catch (err) {
    console.error(
      `\ncheck:surface — ${err.message}.\n\n` +
        '  This check compares nothing it cannot read: a manifest it does not understand\n' +
        '  is a failure rather than a green run over an empty table.',
    );
    process.exitCode = 1;
    return;
  }

  // The mirror, as the objects the suite itself uses. Imported rather than
  // scraped: a second reading of our own tables is one more thing that can
  // disagree with what the tests actually pin.
  //
  // Node strips the types. A runtime old enough to refuse that is told so
  // plainly, because the alternative — falling back to reading the file as text
  // — is the thing this change exists to delete.
  let mirror;
  try {
    mirror = await import('../test/allowlist.ts');
  } catch (err) {
    console.error(
      `check:surface — could not import test/allowlist.ts: ${err.message}\n` +
        '  This needs a Node with TypeScript type stripping (22.18+ or 24+); this is ' +
        `${process.version}.`,
    );
    process.exitCode = 1;
    return;
  }
  const { ALLOWED: mirrorRoutes, PARAMETERS: mirrorParams, LIMITS: mirrorLimits } = mirror;

  const problems = [];

  // --- routes ---------------------------------------------------------------

  const missingRoutes = [...manifest.routes].filter((r) => !mirrorRoutes.has(r)).sort();
  const extraRoutes = [...mirrorRoutes].filter((r) => !manifest.routes.has(r)).sort();

  if (missingRoutes.length) {
    problems.push(
      'routes the platform exposes that the mirror does not list:\n' +
        missingRoutes.map((r) => `  + ${r}`).join('\n') +
        '\n\n  Add each to V1_ROUTES in test/allowlist.ts. If this server cannot call it,\n' +
        '  add it to UNIMPLEMENTED too, so the gap stays a number somebody has to edit down.',
    );
  }
  if (extraRoutes.length) {
    problems.push(
      'routes the mirror lists that the platform does not expose:\n' +
        extraRoutes.map((r) => `  - ${r}`).join('\n') +
        '\n\n  Either the platform dropped these, or the mirror invented them. A call to\n' +
        "  one of these 404s in a user's hands.",
    );
  }

  // --- parameters -----------------------------------------------------------

  // Only over the routes both tables agree exist. A route missing from the
  // mirror is already reported above, and reporting each of its parameters again
  // buries the one line that says what to do about it.
  const shared = [...manifest.routes].filter((r) => mirrorRoutes.has(r)).sort();
  const missingParams = [];
  const extraParams = [];
  let counted = 0;

  for (const route of shared) {
    const theirs = manifest.parameters.get(route) ?? new Set();
    // The mirror stores each route's parameters as an ARRAY, which is the
    // readable shape for a table people edit. Into a Set here rather than
    // `.includes` in the loop below, so a name listed twice over there cannot
    // change what this compares.
    const ours = new Set(mirrorParams.get(route) ?? []);
    counted += theirs.size;
    for (const p of [...theirs].sort()) if (!ours.has(p)) missingParams.push(`${route}  ${p}`);
    for (const p of [...ours].sort()) if (!theirs.has(p)) extraParams.push(`${route}  ${p}`);
  }

  // The number the success line prints is also the one thing that says the
  // parameter comparison happened at all. Many routes document parameters, so a
  // run that agreed about every route and compared none of them read the route
  // keys in a shape the two sides no longer share — a green line over an empty
  // loop. Kept from the text-scanning version, because the failure it guards
  // against is about the two key formats agreeing, not about how they were read.
  if (shared.length && !counted) {
    problems.push(
      `compared zero parameters across ${shared.length} shared routes.\n\n` +
        '  Both sides came back empty, so the parameter half agreed about nothing and\n' +
        '  said it matched. The route key format on one side or the other changed.',
    );
  }
  if (missingParams.length) {
    problems.push(
      'parameters the platform documents that the mirror does not list:\n' +
        missingParams.map((p) => `  + ${p}`).join('\n') +
        '\n\n  Add each to PARAMETERS in test/allowlist.ts. If this server cannot send it,\n' +
        '  add it to UNIMPLEMENTED_PARAMETERS too — which is the line that makes the gap\n' +
        "  somebody's to close rather than nobody's to notice.",
    );
  }
  if (extraParams.length) {
    problems.push(
      'parameters the mirror lists that the platform does not document:\n' +
        extraParams.map((p) => `  - ${p}`).join('\n') +
        '\n\n  Either the platform dropped these, or the mirror invented them. One this\n' +
        '  server actually sends is a field the platform ignores, silently.',
    );
  }

  // --- limits ---------------------------------------------------------------

  const drifted = [];
  const withdrawn = [];
  for (const [key, ours] of mirrorLimits) {
    if (!manifest.limits.has(key)) {
      // Refused rather than skipped, and it is the quietest of the three
      // drifts: the server goes on refusing values early against a ceiling the
      // platform has stopped publishing, so a call it would have taken is
      // turned away here and nothing anywhere says why.
      withdrawn.push(`  ! ${key} (mirrored as ${ours}) is not in the manifest's limits`);
      continue;
    }
    const theirs = manifest.limits.get(key);
    if (theirs !== ours) {
      drifted.push(`  ! ${key} is ${ours} in this server, but ${theirs} upstream`);
    }
  }
  if (withdrawn.length) {
    problems.push(
      'limits this server refuses against that the platform no longer publishes:\n' +
        `${withdrawn.join('\n')}\n\n` +
        '  Has the number been renamed, or withdrawn? Until this is answered the server\n' +
        '  is turning callers away on a ceiling nobody upstream is asserting.',
    );
  }
  if (drifted.length) {
    problems.push(
      'limits that have drifted from the platform:\n' +
        `${drifted.join('\n')}\n\n` +
        '  Update the constant in src/, and LIMITS in test/allowlist.ts beside it —\n' +
        '  test/limits.test.ts is what holds those two together.',
    );
  }

  if (!problems.length) {
    console.log(
      `check:surface — the mirror matches the platform (${mirrorRoutes.size} routes, ` +
        `${counted} parameters, ${mirrorLimits.size} limits).`,
    );
    return;
  }

  for (const p of problems) console.error(`\ncheck:surface — ${p}`);
  // The checkout location is deliberately NOT printed. This output gets pasted
  // into pull requests on a public repository, and the absolute path of a
  // developer's checkout of the private platform repo has no business there.
  // Whoever runs this knows where they pointed it; set MANDALA_PLATFORM_REPO
  // if it needs saying.
  // Set rather than exited on. stdout and stderr are asynchronous when they are
  // a pipe, which is what CI gives them, and `process.exit` abandons whatever is
  // still queued — on the one path whose whole output is the report that says
  // what to fix. Returning lets node drain them and leave with this status.
  process.exitCode = 1;
}
