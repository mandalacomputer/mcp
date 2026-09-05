#!/usr/bin/env node
/**
 * Diff the mirrors in test/allowlist.ts against the real tables in the platform
 * repo — the routes, and the parameters each route takes.
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
 * the platform (32 routes)" the whole time — because a header is a new
 * PARAMETER on a route that already existed, and a route table cannot see one.
 * The call lands in the right place either way; the only thing missing is the
 * argument that made it worth making. read_file went on telling models it
 * "cannot page" for as long as nobody happened to read the platform's changelog.
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
 * that, what this prints is routes and parameters that have not shipped yet,
 * and this repository's Actions logs are world-readable the day it goes public,
 * where the platform's are not.
 *
 * So on a machine that has both this is what catches drift before a push, and
 * everywhere else it is what the platform runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  balanced,
  entries,
  stripComments,
  topLevelField,
  topLevelKeys,
  topLevelValueAt,
} from './surface-text.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

// One marker identifies the checkout, and the rest of the layout is then
// required of it rather than searched for. Asking for both at once conflates
// two different answers: "this directory is not the platform, so there is
// nothing here to compare" and "this is the platform and a file this reads has
// moved" — and the second, answered as the first, takes the ROUTE half of the
// gate down as well, silently, over a file the route half never opens.
const MARKER = 'web/lib/surface.ts';
const ALSO_READ = ['web/lib/apidoc.ts'];

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
        '  Set MANDALA_PLATFORM_REPO to compare against web/lib.',
    );
    return null;
  }

  const missing = ALSO_READ.filter((file) => !existsSync(join(found, file)));
  if (missing.length) {
    console.error(
      `check:surface — ${found} is a platform checkout missing ${missing.join(', ')}.\n` +
        '  The file moved or was renamed. Until this reader is pointed at the new one\n' +
        '  the comparison below is partly blind, which is worse than it failing.',
    );
    process.exitCode = 1;
    return null;
  }
  return found;
}

main();

function main() {
  const platform = platformRepo();
  if (!platform) return;

  // --- reading TypeScript without a TypeScript loader ------------------------
  //
  // Both files are read as text and matched over, so this runs with no build
  // step and no dependency. Comments are stripped from anything matched, because
  // both are heavily commented and several of those comments quote the very
  // shapes being matched — over them, the regexes invent routes and parameters.
  // See scripts/surface-text.mjs, which is a copy of the same helpers in the
  // TypeScript SDK: a parser bug found in one is worth carrying to the other.

  // --- routes ---------------------------------------------------------------

  const surfaceSource = readFileSync(join(platform, 'web/lib/surface.ts'), 'utf8');

  /**
   * Pull one `export const NAME: Route[] = [...]` table out, entry by entry.
   *
   * Split by brace depth rather than matched with one regex across the whole
   * table. A `/method:.*?pattern:/` over the flat text is correct only while
   * every entry happens to write its method first: reorder two fields and the
   * lazy match joins one entry's method to the next entry's pattern. What comes
   * out is a route neither table has — and a route that is in neither is not a
   * failure here, it is silence. A checker whose failure mode is a false
   * all-clear is worse than no checker, which is what the brace walk is for and
   * why it survived the port.
   *
   * Slicing the entry is only half of it. Within one entry the fields are read
   * at that entry's own depth, because a nested literal can quote a `pattern` of
   * its own — an options bag, a `handler: {}` with a path in it — and a regex
   * over the entry takes whichever comes first.
   *
   * The split itself is `entries`, which skips literals rather than counting
   * every brace it sees. A raw count is the same bug one level down: a lone `}`
   * in a string desyncs the depth for good, and the entries after it are dropped
   * without a word.
   *
   * The `!routes.size` guard below only catches a parse that found nothing at
   * all, which is exactly what a mispaired parse is not.
   */
  function routeTable(name) {
    const decl = `export const ${name}: Route[] = [`;
    const start = surfaceSource.indexOf(decl);
    if (start === -1) throw new Error(`${name} not found in web/lib/surface.ts`);
    // The opening bracket of the table, not the one in `Route[]` a few
    // characters earlier — which is what an indexOf('[') from the declaration
    // finds, and which closes immediately.
    const body = stripComments(balanced(surfaceSource, start + decl.length - 1, '[', ']'));
    const routes = new Set();
    for (const entry of entries(body)) {
      // Both, out of ONE entry and at that entry's own depth. An entry carrying
      // only half of the pair is not a route, and must borrow the other half
      // neither from its neighbour nor from a literal nested in it.
      const method = topLevelField(entry, 'method');
      const pattern = topLevelField(entry, 'pattern');
      if (method && pattern) routes.add(`${method} ${pattern}`);
    }
    if (!routes.size)
      throw new Error(`parsed ${name} but found no routes — has its shape changed?`);
    return routes;
  }

  const platformRoutes = routeTable('V1_ROUTES');

  const mirrorSource = readFileSync(join(repo, 'test/allowlist.ts'), 'utf8');

  /** The text of one `export const NAME` declaration in the mirror. */
  function mirrorSection(name, until) {
    const from = mirrorSource.indexOf(`export const ${name}`);
    if (from === -1) throw new Error(`${name} not found in test/allowlist.ts`);
    const to = mirrorSource.indexOf(`export const ${until}`, from);
    return stripComments(mirrorSource.slice(from, to === -1 ? undefined : to));
  }

  const mirrorRoutes = new Set(
    [...mirrorSection('V1_ROUTES', 'key').matchAll(/r\('([A-Z]+)',\s*'([^']+)'\)/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    ),
  );

  // --- parameters -----------------------------------------------------------

  const docSource = readFileSync(join(platform, 'web/lib/apidoc.ts'), 'utf8');
  // Every scan below reads this rather than the raw file. A declaration or a
  // route key quoted in a comment — which is how apidoc.ts explains itself, and
  // its comment above ALLOW_PARTIAL spells out the very shape this file matches
  // on — is source to a regex and prose to a reader, and the regex wins.
  // Length-preserving by construction: comments are blanked, not deleted, so
  // every offset here indexes the same character in either text.
  const docClean = stripComments(docSource);

  /**
   * Module-level `const NAME: Query = {...}` entries.
   *
   * A route's `query` or `headers` array can reference one of these by
   * identifier instead of spelling it out — ALLOW_PARTIAL is shared by two
   * routes — so the identifier has to resolve to a parameter name or those
   * routes read as taking none. `Query` is the type of both lists over there
   * (`headers?: Query[]`), so what these name is a parameter of whichever list
   * cites it rather than a query parameter by construction.
   *
   * `export` and indentation are both allowed for, because neither changes what
   * the declaration means and a reader that insists on today's spelling reports
   * every route citing a re-spelled constant as taking no parameters at all.
   * Allowing indentation is also why this reads `docClean`: a superseded copy of
   * a declaration quoted in a block comment is indented under its `*`, so the
   * relaxed pattern reaches it, and the later copy wins the Map. Every route
   * citing the identifier then reports one missing and one extra parameter,
   * both naming the name nobody serves.
   */
  const sharedParams = new Map();
  for (const m of docClean.matchAll(/^\s*(?:export\s+)?const ([A-Z_]+):\s*Query\s*=\s*\{/gm)) {
    const named = balanced(docClean, m.index + m[0].length - 1, '{', '}').match(
      /name:\s*'([^']+)'/,
    );
    if (named) sharedParams.set(m[1], named[1]);
  }

  /** Every query, header and body field the platform documents, by route. */
  function platformParameters() {
    const decl = 'export const DOCS: Record<string, Doc> = {';
    const start = docClean.indexOf(decl);
    if (start === -1) throw new Error('DOCS not found in web/lib/apidoc.ts');
    // Located AND sliced out of the stripped copy, the way `routeTable` strips
    // before it splits. This file quotes the shapes being matched in its own
    // comments, and everything here is run over text rather than over a parse —
    // so a commented `'GET x': {` is an entry as far as it can tell, and a
    // comment quoting this very declaration is where the table starts. The
    // invented route is the lesser half: `lastIndex` then moves past a
    // `balanced()` walk that began at a brace inside the comment, which can
    // carry it over the genuine entry, and that route reads as taking no
    // parameters at all.
    const docs = balanced(docClean, start + decl.length - 1, '{', '}');

    const table = new Map();
    const entry = /'([A-Z]+) ([^']+)':\s*\{/g;
    for (let m = entry.exec(docs); m; m = entry.exec(docs)) {
      const body = balanced(docs, m.index + m[0].length - 1, '{', '}');
      // Past this entry rather than into it: a nested `'GET x': {` inside a
      // description would otherwise be read as a route of its own.
      entry.lastIndex = m.index + m[0].length + body.length;
      const params = new Set();

      for (const [key, kind] of [
        ['query', 'query'],
        ['headers', 'header'],
      ]) {
        // At the entry's own depth, and located rather than spelled — the two
        // failures are different and this has to avoid both.
        //
        // A description or a response example can nest a `query: [` of its own,
        // and an `indexOf` takes the first at ANY depth: a parameter list read
        // out of prose is a set the platform never documented, reported against
        // the mirror as if it had, while the route's real list further down goes
        // unread. And the one space after the colon is a spelling, not a shape:
        // a list the formatter wrapped — `query:\n  [{ name: 'limit' }]` — is
        // the same list, but a reader insisting on today's spelling skips the
        // route's parameters entirely and says nothing. With a full table the
        // guard for a scan that counted nothing does not fire either, because
        // the other routes counted, so the route's real parameters surface as
        // ones the mirror invented — which sends the operator to the wrong file.
        const at = topLevelValueAt(body, key);
        if (at === -1 || body[at] !== '[') continue;
        const list = balanced(body, at, '[', ']');
        for (const n of list.matchAll(/name:\s*'([^']+)'/g)) params.add(`${kind}:${n[1]}`);
        // `$` as well as a separator, and it is not decoration: `query:
        // [ALLOW_PARTIAL]` on one line is the whole list with nothing after the
        // identifier, so a lookahead demanding a trailing comma or bracket found
        // nothing and GET computers read as taking no parameters at all.
        //
        // An identifier that resolves to nothing cannot be an error here: this
        // same scan reads the ordinary capitalised words of a description — RFC,
        // UTC — out of the prose each parameter carries.
        for (const id of list.matchAll(/(?:^|[[,\s])([A-Z_]{2,})(?=[,\s\]]|$)/g)) {
          if (sharedParams.has(id[1])) params.add(`${kind}:${sharedParams.get(id[1])}`);
        }
      }

      // Only the `object(...)` bodies have named fields. A raw one — the file
      // upload's and the template document's `{ type: 'string', format:
      // 'binary' }` — has none to name. Anything else spelled where a body goes
      // is a shape this cannot read, and reading it as no fields would say the
      // route documents no body at all: the mirror lists none for such a route
      // either, so the two agree about nothing.
      //
      // All three cases are decided at the entry's own depth. Asking the whole
      // entry text whether it holds a readable body lets a nested one answer:
      // a `body: { … }` inside a response example vouches for the entry's own
      // `body: SHARED_BODY`, the throw is skipped, and the route reports no
      // fields — which matches a mirror that lists none. That is the vacuous
      // all-clear this guard exists to refuse, arriving through the guard.
      const bodyAt = topLevelValueAt(body, 'body');
      if (bodyAt !== -1) {
        const object = /^object\s*\(/.exec(body.slice(bodyAt));
        const args = object && balanced(body, bodyAt + object[0].length - 1, '(', ')');
        // An `object(SHARED_FIELDS)` is as unreadable as a bare identifier is,
        // and it belongs in the message that names the route: fed to `balanced`
        // unchecked, its missing `{` came back as an offset assertion naming
        // neither the route nor the file it is in.
        const brace = args === null ? -1 : args.indexOf('{');
        if (brace !== -1) {
          for (const k of topLevelKeys(balanced(args, brace, '{', '}'))) params.add(`body:${k}`);
        } else if (body[bodyAt] !== '{') {
          throw new Error(
            `'${m[1]} ${m[2]}' documents a body in a form this reader does not know — ` +
              'neither object(...) nor a raw schema literal.',
          );
        }
      }
      table.set(`${m[1]} ${m[2]}`, params);
    }
    return table;
  }

  /** The same, read out of the mirror's PARAMETERS map. */
  function mirrorParameters() {
    const section = mirrorSection('PARAMETERS', 'UNIMPLEMENTED_PARAMETERS');
    const table = new Map();
    const entry = /\[\s*'([A-Z]+ [^']+)'\s*,\s*\[/g;
    for (let m = entry.exec(section); m; m = entry.exec(section)) {
      const list = balanced(section, m.index + m[0].length - 1, '[', ']');
      table.set(m[1], new Set([...list.matchAll(/'([^']+)'/g)].map((p) => p[1])));
    }
    return table;
  }

  // --- the comparison -------------------------------------------------------

  const problems = [];

  const missingRoutes = [...platformRoutes].filter((r) => !mirrorRoutes.has(r)).sort();
  const extraRoutes = [...mirrorRoutes].filter((r) => !platformRoutes.has(r)).sort();

  if (missingRoutes.length) {
    problems.push(
      'routes the platform exposes that the mirror does not list:\n' +
        missingRoutes.map((r) => `  + ${r}`).join('\n') +
        '\n\n  Add each to V1_ROUTES in test/allowlist.ts, and either write a tool for it\n' +
        '  or pin it in UNIMPLEMENTED, so the gap stays a line somebody has to edit.',
    );
  }
  if (extraRoutes.length) {
    problems.push(
      'routes the mirror lists that the platform does not expose:\n' +
        extraRoutes.map((r) => `  - ${r}`).join('\n') +
        '\n\n  Either the platform dropped these, or the mirror invented them. A tool\n' +
        "  calling one of these 404s in a user's hands.",
    );
  }

  const platformParams = platformParameters();
  const mirrorParams = mirrorParameters();

  // Only over the routes both tables agree exist. A route missing from the
  // mirror is already reported above, and reporting each of its parameters again
  // buries the one line that says what to do about it.
  const shared = [...platformRoutes].filter((r) => mirrorRoutes.has(r)).sort();
  const missingParams = [];
  const extraParams = [];
  let counted = 0;

  for (const route of shared) {
    const theirs = platformParams.get(route) ?? new Set();
    const ours = mirrorParams.get(route) ?? new Set();
    counted += theirs.size;
    for (const p of [...theirs].sort()) if (!ours.has(p)) missingParams.push(`${route}  ${p}`);
    for (const p of [...ours].sort()) if (!theirs.has(p)) extraParams.push(`${route}  ${p}`);
  }

  if (!platformParams.size) {
    problems.push(
      'no parameters could be read out of web/lib/apidoc.ts.\n\n' +
        '  The DOCS table moved or changed shape. This check is silently vacuous until\n' +
        '  the reader above is fixed — which is worse than it failing, so it fails.',
    );
  }
  // The number the success line prints is also the one thing that says the
  // comparison happened at all. Every route the platform documents carries at
  // least one parameter or field today, so a run that agrees about every route
  // and compared none of them read the DOCS keys in a shape that no longer
  // matches the mirror's — a green line over an empty loop.
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
        '\n\n  Add each to PARAMETERS in test/allowlist.ts. If this server does not send it,\n' +
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

  if (!problems.length) {
    console.log(
      `check:surface — the mirror matches the platform (${mirrorRoutes.size} routes, ` +
        `${counted} parameters, from ${platform}).`,
    );
    return;
  }

  for (const p of problems) console.error(`\ncheck:surface — ${p}`);
  console.error(`\n  Platform: ${join(platform, 'web/lib')}`);
  // Set rather than exited on. stdout and stderr are asynchronous when they are
  // a pipe, which is what CI gives them, and `process.exit` abandons whatever is
  // still queued — on the one path whose whole output is the report that says
  // what to fix. Returning lets node drain them and leave with this status.
  process.exitCode = 1;
}
