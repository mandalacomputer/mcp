#!/usr/bin/env node

/**
 * Refuse to publish the platform's internals from this public repository.
 *
 * This repo is public. The platform it speaks to is not. Everything here is
 * written by reading that platform, and the reading leaves fingerprints — file
 * names, internal function names, quoted source comments — in comments that
 * SHIP: `dist/*.d.ts` carries every doc comment to npm, and without
 * `removeComments` the `//` bodies go with it.
 *
 * WHY THIS IS A CHECK AND NOT ANOTHER SCRUB. OPL-4613 scrubbed forty-one of
 * these out of this repo and said in its own commit message that the scan
 * "wants to be a check rather than a one-off". It stayed a one-off. Seven
 * survived it and five more arrived the following week.
 *
 * WHY THE LIST IS NOT WRITTEN BY HAND. The first cut of this file listed the
 * names the scrub had just removed and certified the repo clean while more were
 * still shipping (/code-review). `internal-names.sha256` is DERIVED instead,
 * from the declarations in the platform's own source, by a script that lives
 * there. Regenerating it is a command rather than an act of memory.
 *
 * WHY THE NAMES ARE HASHED. A list of a private system's internal names,
 * published in a public repo, is a small map of that system. So this carries
 * SHA-256 prefixes. A match is still reported BY NAME, because the name is
 * already in the file being scanned; what this file cannot do is hand a reader
 * the set of names to go looking for.
 *
 * WHAT IS FORBIDDEN, and it is deliberately narrow — this is not a secret
 * scanner:
 *
 *   - platform source paths, BY SHAPE rather than by prefix. This client has no
 *     Go, so any `<something>.go` in it names somebody else's file; the first
 *     cut required a `server/` prefix and let a bare one ship in `dist/`.
 *     Likewise `lib/<module>` and `web/lib/<module>`, extension or not.
 *   - identifiers declared in the platform and not in this library.
 *   - nothing else. Prose about what the platform DOES is the point of this
 *     client's comments and must stay.
 *
 * WHAT TO WRITE INSTEAD: the caller-facing consequence. "The platform sets `id`
 * on every row it emits" says everything the internal spelling said, to a reader
 * holding this library rather than casing the platform.
 *
 * WHAT IS ALLOWED THROUGH: the surface checker and its tables, which mirror the
 * platform's routes and constants because that is their whole job, and which are
 * not shipped. Allowlisted BY FILE, so a reference anywhere else still fails.
 *
 * Run over the working tree (`npm run check:internals`) or over commit messages,
 * which is the half a file scan cannot see — a message is public the moment it
 * is pushed:
 *
 *   node scripts/check-internals.mjs --messages origin/main..HEAD
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = join(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = join(HERE, '..');
const DIGESTS = join(HERE, 'internal-names.sha256');

/** Files that may carry the platform's names because mirroring them is their job. */
const ALLOWED = new Set([
  'scripts/check-surface.mjs',
  'scripts/check-internals.mjs',
  'test/allowlist.ts',
  'test/surface-parser.test.ts',
  'test/api-parity.test.ts',
  'test/check-internals.test.ts',
]);

/** Everything a reader of this project can see. */
const SCANNED_DIRS = ['src', 'test', 'scripts', '.github'];
const SCANNED_FILES = ['README.md', 'SECURITY.md', 'package.json'];
const SUFFIXES = new Set(['.ts', '.tsx', '.mjs', '.js', '.md', '.json', '.yml', '.yaml']);

const PATH_PATTERNS = [
  [/\b[A-Za-z_][A-Za-z0-9_/]*\.go\b/g, 'names a platform source file'],
  [/\b(?:web\/)?lib\/[A-Za-z][A-Za-z0-9_]*(?:\.ts)?\b/g, 'names a platform module'],
  // Not preceded by a path separator: `@modelcontextprotocol/sdk/server/mcp`
  // is a package subpath, not the platform's tree.
  [/(?<![\w/@.-])server\/[A-Za-z][A-Za-z0-9_/]*\b/g, 'names a platform module'],
];

const IDENTIFIER = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
const MIN_IDENTIFIER = 7;

function loadDigests() {
  if (!existsSync(DIGESTS)) {
    console.error(
      'check-internals: internal-names.sha256 is missing — regenerate it from the platform.',
    );
    process.exit(2);
  }
  return new Set(
    readFileSync(DIGESTS, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

export function scanText(text, label, digests) {
  const problems = [];
  text.split('\n').forEach((line, i) => {
    let hits = [];
    for (const [pattern, why] of PATH_PATTERNS) {
      for (const hit of line.match(pattern) ?? []) hits.push([hit, why]);
    }
    // A path can answer to two rules, and reporting one reference twice trains
    // a reader to skim the output. The longer span wins.
    hits = hits.filter(([h]) => !hits.some(([o]) => o !== h && o.includes(h)));
    for (const [hit, why] of hits) problems.push(`${label}:${i + 1}: ${why}: ${hit}`);
    for (const token of line.match(IDENTIFIER) ?? []) {
      if (token.length < MIN_IDENTIFIER) continue;
      const digest = createHash('sha256').update(token).digest('hex').slice(0, 12);
      if (digests.has(digest)) {
        problems.push(`${label}:${i + 1}: names a platform identifier: ${token}`);
      }
    }
  });
  return problems;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SUFFIXES.has(entry.slice(entry.lastIndexOf('.')))) out.push(full);
  }
}

function scanFiles(digests) {
  const targets = [];
  for (const dir of SCANNED_DIRS) {
    const full = join(ROOT, dir);
    if (existsSync(full) && statSync(full).isDirectory()) walk(full, targets);
  }
  for (const file of SCANNED_FILES) {
    const full = join(ROOT, file);
    if (existsSync(full)) targets.push(full);
  }
  const problems = [];
  for (const full of [...new Set(targets)].sort()) {
    const rel = relative(ROOT, full).split(sep).join('/');
    if (ALLOWED.has(rel)) continue;
    problems.push(...scanText(readFileSync(full, 'utf8'), rel, digests));
  }
  return problems;
}

function scanMessages(range, digests) {
  let log;
  try {
    log = execFileSync('git', ['log', '--format=%H%x00%B%x00', range], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A shallow checkout has no `origin/main` to diff against, and a stack
    // trace here reads as the tool being broken rather than as the range being
    // unavailable — which is how a CI step gets deleted.
    const detail =
      String(err.stderr ?? '')
        .trim()
        .split('\n')
        .pop() || 'no such range';
    console.error(
      `check-internals: cannot read commit messages for '${range}' (${detail}).\n` +
        '  In CI this usually means a shallow clone: set fetch-depth: 0 on actions/checkout.',
    );
    process.exit(2);
  }
  const problems = [];
  const chunks = log.split('\0');
  for (let i = 0; i + 1 < chunks.length; i += 2) {
    const sha = chunks[i].trim();
    if (sha) problems.push(...scanText(chunks[i + 1], `commit ${sha.slice(0, 9)}`, digests));
  }
  return problems;
}

function parseRange(argv) {
  const flag = argv.indexOf('--messages');
  const inline = argv.find((a) => a.startsWith('--messages='));
  if (inline) {
    const value = inline.slice('--messages='.length);
    if (!value) fail('--messages needs a revision range, e.g. --messages origin/main..HEAD');
    return value;
  }
  if (flag === -1) return undefined;
  const value = argv[flag + 1];
  // Bare `--messages` scanned nothing and printed the all-clear (/code-review).
  if (!value || value.startsWith('-')) {
    fail('--messages needs a revision range, e.g. --messages origin/main..HEAD');
  }
  return value;
}

function fail(message) {
  console.error(`check-internals: ${message}`);
  process.exit(2);
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const range = parseRange(process.argv.slice(2));
  const digests = loadDigests();
  const problems = [...scanFiles(digests), ...(range ? scanMessages(range, digests) : [])];

  if (problems.length === 0) {
    console.log(
      `check-internals — nothing of the platform's is being published from the tree${range ? ` and ${range}` : ''}.`,
    );
    process.exit(0);
  }

  console.error("check-internals — the platform's internals are not this repo's to publish:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\n  Say what the platform DOES, not which of its files or functions does it. The\n' +
      '  behaviour is what a reader of this library can act on; the name is only useful\n' +
      '  to somebody casing the platform. See this script for the rule.',
  );
  process.exit(1);
}
