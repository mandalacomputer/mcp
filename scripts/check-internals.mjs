#!/usr/bin/env node
/**
 * Refuse to publish the platform's internals from this public repository.
 *
 * This repo is public. The platform it speaks to is not. Everything here is
 * written by reading that platform, and the reading leaves fingerprints — file
 * names, internal function names, quoted source comments — and here they reach a
 * MODEL: the tool descriptions in `src/tools/` are what an agent reads before it
 * acts, and they ship in the published server.
 *
 * OPL-4617 scrubbed two sites out of this repo and left nothing behind to catch
 * the next. Three survived it and four more arrived this week in a single batch
 * of fixes, three of those in commit messages and PR descriptions. This is the
 * check (OPL-4637).
 *
 * WHAT IS FORBIDDEN, and it is deliberately narrow — this is not a secret
 * scanner:
 *
 *   - platform source paths: `server/<file>.go`, `web/lib/<file>.ts`
 *   - the internal identifiers listed below
 *   - nothing else. Prose about what the platform DOES is the point of this
 *     client's comments and must stay.
 *
 * WHAT TO WRITE INSTEAD: the caller-facing consequence. "The platform sets `id`
 * on every row it emits" says everything "`projection.ts` sets `id`..." said, to
 * a reader who is holding this library rather than casing the platform.
 *
 * WHAT IS ALLOWED THROUGH: `scripts/check-surface.mjs` and the tests around it
 * name the two platform files they READ. That was OPL-4613's judgement and it
 * holds — a tool that self-evidently reads a private repo is the weakest thing
 * on this list, and it already refuses to run against the platform in public CI.
 * Allowlisted by FILE, so a reference anywhere else still fails.
 *
 * Run over the working tree (`npm run check:internals`) or over commit messages
 * (`node scripts/check-internals.mjs --messages origin/main..HEAD`), which is
 * the half a file scan cannot see: a commit message is public the moment it is
 * pushed, and three of this week's five were in messages and PR descriptions.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Files that may name the two platform paths they read. */
const ALLOWED = new Set([
  'scripts/check-surface.mjs',
  'scripts/check-internals.mjs',
  'test/allowlist.ts',
  'test/surface-parser.test.ts',
  'test/api-parity.test.ts',
]);

/** Scanned in full. `src/` ships; tests and the README are read on GitHub. */
const SCANNED = ['src', 'test', 'scripts', 'README.md'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.md']);

/**
 * One name per line, so adding the next is a one-line diff and the reason for
 * each stays visible in `git blame`.
 *
 * Names this library exports itself are deliberately absent, however faithfully
 * they mirror a platform constant: a check that cannot be satisfied without
 * renaming the public API is a check that gets deleted.
 */
const INTERNAL_NAMES = [
  'describeVM',
  'describeRow',
  'reserveBuild(?:Once)?',
  'CloneFromSnapshot',
  'holdHostRAM(?:Locked|Evicting)?',
  'runningRAMLocked',
  'startLocked',
  'buildErr',
  'publicComputer',
  'sessionComputer',
  'publicSnapshot',
  'checkExpectation',
  'applyWindowGeom',
  'emitFile',
  'admitStartLocked',
  'hostUsageLocked',
  'resumeIfSuspended',
  'writeUseErr',
  'actionStatusDef',
];

const PATTERNS = [
  [/\bserver\/[a-z_]+\.go\b/g, 'names a platform source file'],
  [/\bweb\/lib\/[a-z_]+\.ts\b/g, 'names a platform source file'],
  [
    /\b(?:projection|apidoc|surface|hvproxy|admission|hostroute)\.ts\b/g,
    'names a platform source file',
  ],
  [new RegExp(String.raw`\b(?:${INTERNAL_NAMES.join('|')})\b`, 'g'), 'names a platform identifier'],
];

const problems = [];

function scanText(text, label) {
  text.split('\n').forEach((line, i) => {
    for (const [pattern, why] of PATTERNS) {
      for (const hit of line.match(pattern) ?? []) {
        problems.push(`${label}:${i + 1}: ${why}: ${hit}`);
      }
    }
  });
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) scanFile(full);
  }
}

function scanFile(full) {
  const rel = relative(ROOT, full).split(sep).join('/');
  if (ALLOWED.has(rel)) return;
  scanText(readFileSync(full, 'utf8'), rel);
}

for (const entry of SCANNED) {
  const full = join(ROOT, entry);
  let stat;
  try {
    stat = statSync(full);
  } catch {
    continue;
  }
  if (stat.isDirectory()) walk(full);
  else scanFile(full);
}

const range = process.argv.includes('--messages')
  ? process.argv[process.argv.indexOf('--messages') + 1]
  : undefined;
if (range) {
  const log = execFileSync('git', ['log', '--format=%H%x00%B%x00', range], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const chunks = log.split('\0');
  for (let i = 0; i + 1 < chunks.length; i += 2) {
    const sha = chunks[i].trim();
    if (sha) scanText(chunks[i + 1], `commit ${sha.slice(0, 9)}`);
  }
}

if (problems.length === 0) {
  console.log("check-internals — nothing of the platform's is being published from here.");
  process.exit(0);
}

console.error("check-internals — the platform's internals are not this repo's to publish:\n");
for (const p of problems) console.error(`  ${p}`);
console.error(
  '\n  Say what the platform DOES, not which of its files does it. The behaviour is what a\n' +
    '  reader of this library can act on; the file name is only useful to somebody casing the\n' +
    '  platform. See this script for the rule.',
);
process.exit(1);
