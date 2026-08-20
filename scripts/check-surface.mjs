#!/usr/bin/env node
/**
 * Diff the mirrored allowlist in test/allowlist.ts against the real one in the
 * platform repo.
 *
 * The mirror is the thing that keeps this server honest about which routes
 * exist, and a mirror nobody compares is just a comment. This does the
 * comparison whenever the platform repo happens to be checked out — next door
 * by default, or wherever MANDALA_PLATFORM_REPO points.
 *
 * Exits 0 and says so when the platform repo is not there. That is the ordinary
 * case in CI on this repository, and failing over it would make the check
 * something people learn to ignore. Where it matters is on a machine that has
 * both, and in any job that checks out both — which is where a route added
 * upstream should stop being invisible.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const candidates = [
  process.env.MANDALA_PLATFORM_REPO,
  resolve(repo, '..', 'gorillacloud'),
  resolve(repo, '..', 'mandala-computer'),
].filter(Boolean);

const platform = candidates.find((dir) => existsSync(join(dir, 'web/lib/surface.ts')));
if (!platform) {
  console.log(
    'check:surface — platform repo not found, skipping.\n' +
      '  Looked in: ' +
      candidates.join(', ') +
      '\n' +
      '  Set MANDALA_PLATFORM_REPO to compare against web/lib/surface.ts.',
  );
  process.exit(0);
}

const source = readFileSync(join(platform, 'web/lib/surface.ts'), 'utf8');

/** Pull one `export const NAME: Route[] = [...]` table out, balanced by bracket depth. */
function table(name) {
  const decl = `export const ${name}: Route[] = [`;
  const start = source.indexOf(decl);
  if (start === -1) throw new Error(`${name} not found in web/lib/surface.ts`);
  // The opening bracket of the table, not the one in `Route[]` a few characters
  // earlier — which is what an indexOf('[') from the start of the declaration
  // finds, and which closes immediately.
  let depth = 0;
  let i = start + decl.length - 1;
  const from = i;
  for (; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']' && --depth === 0) break;
  }
  const body = source.slice(from + 1, i);
  const routes = [];
  // Entries are object literals, split by brace depth rather than by
  // `/\{[^{}]*\}/g`. That grammar cannot express nesting: give an entry a nested
  // literal — a `handler: {}`, an options bag — and the regex matches the INNER
  // braces, which carry no method and no pattern, while the entry that does
  // carry them is never seen as a whole. The route then goes missing from
  // `upstream`, and a missing route is not a failure here: it shows up as a `-`
  // line telling the reader the platform has dropped a route it still serves,
  // or, if the mirror is missing it too, as silence. A checker whose failure
  // mode is a false all-clear is worse than no checker.
  //
  // The `!routes.length` guard below only catches a parse that found nothing at
  // all, which is exactly the case a partial parse is not.
  for (let j = 0, depth = 0, from = 0; j < body.length; j++) {
    if (body[j] === '{') {
      if (depth++ === 0) from = j;
    } else if (body[j] === '}' && --depth === 0) {
      const entry = body.slice(from, j + 1);
      const method = /method:\s*'([^']+)'/.exec(entry)?.[1];
      const pattern = /pattern:\s*'([^']+)'/.exec(entry)?.[1];
      if (method && pattern) routes.push(`${method} ${pattern}`);
    }
  }
  if (!routes.length)
    throw new Error(`parsed ${name} but found no routes — has its shape changed?`);
  return routes;
}

const upstream = new Set(table('V1_ROUTES'));

const mirrorSource = readFileSync(join(repo, 'test/allowlist.ts'), 'utf8');
const mirror = new Set(
  [...mirrorSource.matchAll(/^\s*r\('([A-Z]+)',\s*'([^']+)'\)/gm)].map((m) => `${m[1]} ${m[2]}`),
);

const added = [...upstream].filter((r) => !mirror.has(r)).sort();
const removed = [...mirror].filter((r) => !upstream.has(r)).sort();

if (!added.length && !removed.length) {
  console.log(`check:surface — in step with ${platform} (${upstream.size} routes).`);
  process.exit(0);
}

console.error(`check:surface — the mirror in test/allowlist.ts disagrees with ${platform}:\n`);
for (const r of added) {
  console.error(`  + ${r}\n      on the platform, not in the mirror. Add it, and either write a`);
  console.error('      tool for it or pin it in UNIMPLEMENTED.');
}
for (const r of removed) {
  console.error(
    `  - ${r}\n      in the mirror, gone from the platform. Any tool calling it now 404s.`,
  );
}
process.exit(1);
