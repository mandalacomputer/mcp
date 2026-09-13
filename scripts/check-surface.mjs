#!/usr/bin/env node
/**
 * Diff the mirrors in test/allowlist.ts against the platform's surface manifest
 * — the routes, and the parameters each route takes.
 *
 * The mirror is what keeps this SDK honest about what exists, and a mirror
 * nobody compares is just a comment. That is not hypothetical:
 * `computers/:id/exec/:pid` (both verbs) and `GET computers/:id/snapshots`
 * reached the platform without any SDK's surface test noticing, because "every
 * call lands on an allowlisted route" stays true when the allowlist is the stale
 * one. The parameter half exists because the route half was not enough: four
 * documented parameters were unreachable on routes the SDK reached, and a route
 * table cannot see any of them.
 *
 * What this compares against is the platform's `surface-manifest.json`: a file
 * the platform generates from its own tables, verifies byte-for-byte in its own
 * suite, and commits like a lockfile — the routes, the parameters per route, and
 * its limits keyed by what each number means. This used to be a scanner over
 * the platform's TypeScript source, read as text with no parser, and every
 * review of it found another construct it read wrong. The manifest is the
 * platform saying what its surface is, once, in a form a client can read without
 * guessing.
 *
 * The mirror is IMPORTED, not scanned: Node strips the types off
 * test/allowlist.ts itself (22.18 and later), so the tables compared are the
 * ones the suite pins, and a second reader over them cannot disagree with it.
 *
 * FAIL-CLOSED. The recurring defect in the scanners was a false all-clear —
 * reporting the mirror in step because the scan had silently read nothing — and
 * a JSON diff can do that too. So a manifest that is missing, unparseable, of a
 * version this does not know, with no routes, with a parameter on a route it
 * does not list, or a comparison that ends up covering zero parameters, is a
 * failure that names the problem, never an empty comparison that passes.
 *
 * Exits 0 and says so when the platform repo is not checked out. That is the
 * ordinary case in CI on this repository, and failing over it would make the
 * check something people learn to ignore. What is not that case is an operator
 * who named a directory: `MANDALA_PLATFORM_REPO` is an assertion that the repo
 * is at that path, and a path that turns out not to hold it is a mistake to
 * report rather than a repo to go looking for elsewhere.
 *
 * Where it is enforced is the platform's own CI, which checks this repo out
 * beside itself and runs this script against it. What this prints is the routes
 * and parameters that have not shipped yet, and this repository's Actions logs
 * are world-readable where the platform's are not — so the comparison runs
 * there, and here it is what catches drift before a push.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

/** The platform's surface manifest, at the root of its checkout. */
const MANIFEST = 'surface-manifest.json';
/**
 * Files that identify a platform checkout, named for identity only and never
 * read. Deliberately NOT the manifest: a checkout recognized by the very file
 * the comparison needs is one that "is not the platform" the moment that file
 * is missing, and an export that predated or lost the manifest then skipped at
 * exit 0 instead of failing (review of the Python client's adoption).
 */
const MARKERS = ['web/lib/surface.ts', 'web/lib/apidoc.ts'];
/** The manifest format this reads. A version this has not heard of is refused. */
const MANIFEST_VERSION = 1;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const KINDS = ['query:', 'header:', 'body:'];

/** The platform checkout to compare against, or null when there is none. */
function platformRepo() {
  // Resolved against this repo the way the guesses below are. Left raw it
  // resolves against the working directory instead, so the same value means two
  // different directories depending on where npm was invoked.
  const asked = process.env.MANDALA_PLATFORM_REPO
    ? resolve(repo, process.env.MANDALA_PLATFORM_REPO)
    : undefined;
  const candidates = [
    asked,
    resolve(repo, '..', 'mandala-computer'),
    resolve(repo, '..', 'app'),
  ].filter(Boolean);

  const isPlatform = (dir) => MARKERS.every((marker) => existsSync(join(dir, marker)));
  if (asked && !isPlatform(asked)) {
    // The one machine where this gate is enforced is the one that sets this
    // variable, for three SDKs at once. A checkout path that moves, or a
    // variable that fails to expand, would otherwise be indistinguishable from
    // "no platform here" — three green no-ops over three mirrors nobody compared.
    console.error(
      `check:surface — MANDALA_PLATFORM_REPO is set to ${asked}, which does not hold ${MARKERS.join(' and ')}.\n` +
        '  Point it at a platform checkout, or unset it to skip the comparison.',
    );
    process.exitCode = 1;
    return null;
  }

  const found = candidates.find(isPlatform);
  if (!found) {
    console.log(
      'check:surface — platform repo not found, skipping.\n' +
        `  Looked in: ${candidates.join(', ')}\n` +
        `  Set MANDALA_PLATFORM_REPO to compare against ${MANIFEST}.`,
    );
    return null;
  }
  return found;
}

/**
 * The manifest, checked to the shape this compares — every check a way the
 * scanners once printed a false all-clear, made into a failure that says which.
 */
function readManifest(platform) {
  const path = join(platform, MANIFEST);
  if (!existsSync(path)) {
    throw new Error(`${path} is not there — the checkout predates the manifest, or lost it`);
  }
  let manifest;
  try {
    const text = readFileSync(path, 'utf8');
    // An object, not the key itself: the empty string is a legal key, and a
    // truthiness check on it abandoned the walk at the first repeated `""`.
    const twice = repeatedKey(text);
    if (twice) throw new Error(`the key ${JSON.stringify(twice.key)} appears twice in one object`);
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} cannot be read: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${path} is not a JSON object`);
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(
      `${path} is manifest version ${JSON.stringify(manifest.version)}; this reader knows ${MANIFEST_VERSION}`,
    );
  }
  if (!Array.isArray(manifest.routes) || !manifest.routes.length) {
    throw new Error(`${path} lists no routes`);
  }
  for (const entry of manifest.routes) {
    const parts = typeof entry === 'string' ? entry.split(' ') : [];
    if (parts.length !== 2 || !METHODS.has(parts[0])) {
      throw new Error(
        `${path} holds a route that is not 'METHOD pattern': ${JSON.stringify(entry)}`,
      );
    }
  }
  const listed = new Set(manifest.routes);
  const { parameters } = manifest;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error(`${path} has no parameters table`);
  }
  for (const [route, names] of Object.entries(parameters)) {
    if (!listed.has(route)) {
      throw new Error(`${path} documents parameters for a route it does not list: ${route}`);
    }
    if (
      !Array.isArray(names) ||
      !names.every((n) => typeof n === 'string' && KINDS.some((k) => n.startsWith(k)))
    ) {
      throw new Error(
        `${path} holds a parameter list this cannot read, on ${route}: ${JSON.stringify(names)}`,
      );
    }
  }
  return { manifest, path };
}

/**
 * The first key that appears twice in one JSON object, as `{ key }`, or null.
 *
 * `JSON.parse` keeps the LAST of two equal keys and says nothing, so a manifest
 * carrying a route's parameters twice compared against whichever came second
 * and silently ignored the other. Two answers to one question is a manifest
 * this cannot read, and the parser has no hook for it — so the text is walked
 * once, strings stepped over, keys recorded per object. Each key is DECODED
 * before comparing: `"DELETE"` and `"DELETE"` are one key to the parser,
 * and a walk over the raw text called them two (review).
 */
function repeatedKey(text) {
  const objects = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = ++i;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (expectKey && objects.length) {
        const key = JSON.parse(`"${text.slice(start, i)}"`);
        const keys = objects[objects.length - 1];
        if (keys.has(key)) return { key };
        keys.add(key);
        expectKey = false;
      }
    } else if (ch === '{') {
      objects.push(new Set());
      expectKey = true;
    } else if (ch === '}') {
      objects.pop();
      expectKey = false;
    } else if (ch === '[') {
      // Inside an array, a string is a value; a nested object resets this.
      expectKey = false;
    } else if (ch === ',' && objects.length && !inArray(text, i, objects)) {
      expectKey = true;
    }
  }
  return null;
}

// A comma at object level separates members, and one inside an array that sits
// inside an object separates values; the difference is which opened last.
function inArray(text, at, objects) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '"') {
      // Step back over a string, escapes and all.
      let j = i - 1;
      while (j >= 0 && !(text[j] === '"' && text[j - 1] !== '\\')) j--;
      i = j;
      continue;
    }
    if (ch === ']' || ch === '}') depth++;
    else if (ch === '[' || ch === '{') {
      if (depth === 0) return ch === '[';
      depth--;
    }
  }
  return !objects.length;
}

/**
 * A TypeScript module of this repo, imported as the suite imports it — Node
 * strips the types itself from 22.18 on — or a failure that says why not.
 */
async function imported(relative) {
  const file = join(repo, relative);
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(
      `${file} could not be imported: ${error.message}\n` +
        '  This script imports it as TypeScript, which Node strips itself from 22.18 on.',
    );
  }
}

await main();

async function main() {
  const platform = platformRepo();
  if (!platform) return;

  let read;
  let tables;
  let limits;
  try {
    read = readManifest(platform);
    tables = await imported('test/allowlist.ts');
    ({ LIMITS: limits } = await imported('src/limits.ts'));
  } catch (error) {
    // Named, and a failure: the checkout is the platform and the comparison
    // could not be made, which is the third state between "no checkout" and
    // "in step" — the one the scanners used to report as the second.
    console.error(`check:surface — the comparison could not be made.\n  ! ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const { manifest, path } = read;
  const platformRoutes = new Set(manifest.routes);
  const mirrorRoutes = tables.ALLOWED;
  const mirrorParams = tables.PARAMETERS;

  const problems = [];
  const missingRoutes = [...platformRoutes].filter((r) => !mirrorRoutes.has(r)).sort();
  const extraRoutes = [...mirrorRoutes].filter((r) => !platformRoutes.has(r)).sort();
  if (missingRoutes.length) {
    problems.push(
      'routes the platform exposes that the mirror does not list:\n' +
        missingRoutes.map((r) => `  + ${r}`).join('\n') +
        '\n\n  Add each to ALLOWED in test/allowlist.ts. If this SDK cannot call it yet,\n' +
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

  // Every route the platform lists takes a (possibly empty) set: the manifest
  // lists only the routes that have parameters, the mirror lists every route, and
  // the diff has to see both sides the same way.
  const shared = [...platformRoutes].filter((r) => mirrorRoutes.has(r)).sort();
  const missingParams = [];
  const extraParams = [];
  let counted = 0;
  for (const route of shared) {
    const theirs = new Set(manifest.parameters[route] ?? []);
    const ours = new Set(mirrorParams.get(route) ?? []);
    counted += theirs.size;
    for (const p of [...theirs].sort()) if (!ours.has(p)) missingParams.push(`${route}  ${p}`);
    for (const p of [...ours].sort()) if (!theirs.has(p)) extraParams.push(`${route}  ${p}`);
  }
  if (shared.length && !counted) {
    // The count in the success line is also the only evidence the parameter half
    // ran. Both sides empty is not a match, it is a comparison that did not
    // happen — the vacuous all-clear this whole gate exists to refuse.
    problems.push(
      `compared zero parameters across ${shared.length} shared routes.\n\n` +
        '  Every documented parameter is missing from the manifest, or its table was\n' +
        '  read as empty. Either way nothing was compared, which is not a pass.',
    );
  }
  if (missingParams.length) {
    problems.push(
      'documented parameters the mirror does not list:\n' +
        missingParams.map((p) => `  + ${p}`).join('\n') +
        '\n\n  Add each to PARAMETERS in test/allowlist.ts. If this SDK cannot send it yet,\n' +
        '  add it to UNIMPLEMENTED_PARAMETERS too, so the gap stays a number.',
    );
  }
  if (extraParams.length) {
    problems.push(
      'parameters the mirror lists that the platform does not document:\n' +
        extraParams.map((p) => `  - ${p}`).join('\n') +
        '\n\n  Either the platform dropped these, or the mirror invented them.',
    );
  }

  // The limits, every one this repo mirrors, against the manifest's: a ceiling
  // that moved upstream turns a courtesy refusal into a refusal of a call the
  // platform would have taken, with nothing failing anywhere to say so — which is
  // why they are compared here, where the platform's own CI runs this, rather than
  // in a test that skips without a checkout (review).
  const drifted = [];
  for (const [key, mine] of Object.entries(limits)) {
    const theirs = manifest.limits?.[key];
    if (typeof theirs !== 'number')
      drifted.push(`  ! ${key} is ${mine} here, and the platform does not publish it`);
    else if (theirs !== mine)
      drifted.push(`  ! ${key} is ${mine} here, but the platform's is ${theirs}`);
  }
  if (drifted.length) {
    problems.push(
      `limits that have moved:\n${drifted.join('\n')}\n\n  Update src/limits.ts. A number this SDK refuses at that the platform no\n  longer does is a refusal of a call that would have worked.`,
    );
  }

  if (problems.length) {
    console.error(
      `check:surface — the mirror has drifted from the platform.\n\n${problems.join('\n\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `check:surface — the mirror matches the platform (${platformRoutes.size} routes, ${counted} parameters, ${Object.keys(limits).length} limits, from ${path}).`,
  );
}
