/**
 * The surface check's discovery and failure boundaries.
 *
 * Every test here asks the same question a different way: when
 * `scripts/check-surface.mjs` cannot read the platform's inventory, does it
 * FAIL, or does it print a number and exit 0?
 *
 * That question is the whole of OPL-4851. The reader this replaced scanned the
 * platform's TypeScript as text, and across eleven review rounds it produced at
 * least a dozen distinct fail-opens — runs that announced "the mirror matches
 * the platform" without having read it. Reading a generated JSON file removes
 * the grammar, but it does not by itself remove the failure mode: a missing key
 * read as an empty table, or an unknown version read as best-effort, is the
 * same green run over nothing.
 *
 * So the shape checks below are not defensive programming around a file we
 * control. They are the point.
 *
 * The script is spawned rather than imported, the way check-internals.test.ts
 * spawns its own: what is under test is the command the platform's CI runs,
 * exit code included.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The two paths come FROM the script rather than being spelled again here: one
// of them names a platform module, and check-internals refuses those in this
// repo's published tree. Importing the script does not run it — see its
// `isMain`, which exists for this.
import { MANIFEST, MARKER } from '../scripts/check-surface.mjs';
import { ALLOWED, LIMITS, PARAMETERS } from './allowlist.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '..', 'scripts', 'check-surface.mjs');

/**
 * A manifest that agrees with this SDK's mirror on all three tables.
 *
 * Built FROM the mirror, so these tests exercise the reader without also
 * re-pinning the surface — the comparison against the real platform is the
 * script run against a real checkout, and a second copy of 56 routes here would
 * be a third mirror to keep in step.
 */
function validManifest(): Record<string, unknown> {
  const parameters: Record<string, string[]> = {};
  for (const [route, names] of PARAMETERS) {
    // The platform omits a route that documents none, and the reader fills
    // those back in. Omitting them here is what makes that behaviour
    // load-bearing in these fixtures rather than incidental.
    if (names.length) parameters[route] = [...names];
  }
  return {
    version: 1,
    routes: [...ALLOWED].sort(),
    parameters,
    // More than the mirror holds — the manifest is the platform's whole
    // inventory rather than our subset, and a limit this server does not refuse
    // against must be ignored, not refused.
    limits: {
      'agent.maxSteps': 100,
      'exec.maxTimeoutSeconds': 600,
      'exec.maxEnvEntries': 64,
      'exec.maxEnvEntryBytes': 4096,
      'webhook.replayWindowSeconds': 300,
      ...Object.fromEntries(LIMITS),
    },
  };
}

/** A synthetic platform checkout, recognized by its marker file. */
function platformWith(body: unknown, { raw }: { raw?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-'));
  mkdirSync(dirname(join(dir, MARKER)), { recursive: true });
  writeFileSync(join(dir, MARKER), '// synthesized platform source\n');
  if (raw !== undefined) writeFileSync(join(dir, MANIFEST), raw);
  else if (body !== null) writeFileSync(join(dir, MANIFEST), JSON.stringify(body));
  return dir;
}

function run(platform: string | undefined) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(platform === undefined ? {} : { MANDALA_PLATFORM_REPO: platform }),
    },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/**
 * Whether the `node` running these tests strips TypeScript types on its own.
 *
 * The checker reads `test/allowlist.ts` with a plain `import`, which Node
 * enables by default only from 22.18. This repository's CI matrix still has a
 * Node 20 leg — deliberately, because the package declares that floor and a
 * server people install with `npx` needs its range to be true — and there is no
 * type stripping there at all.
 *
 * So these tests are SKIPPED rather than failed below that line, and
 * `devEngines` in package.json declares 22.18 as the tooling floor. What runs
 * on Node 20 is the server itself, which is what that matrix leg is for; the
 * surface check is a maintainer's tool and the platform's CI runs it on a
 * runtime it chooses. The checker's own skip path — no platform checkout — is
 * reached before the import, so `npm test` on Node 20 still passes.
 */
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const STRIPS_TYPES = major > 22 || (major === 22 && minor >= 18);
const whenStripping = describe.skipIf(!STRIPS_TYPES);

whenStripping('the green path', () => {
  it('passes and prints all three counts', () => {
    const { code, out } = run(platformWith(validManifest()));
    expect(code).toBe(0);
    expect(out).toContain(`${ALLOWED.size} routes`);
    expect(out).toContain(`${LIMITS.size} limits`);
  });

  it('does not report a route documenting no parameters as drift', () => {
    // The manifest omits them; the mirror lists them as empty arrays. Read
    // literally that is 27 routes "no longer documented upstream" on a mirror
    // that is exactly right — enough noise to make the check worth ignoring,
    // which is the failure one step past a false green.
    const body = validManifest();
    const documented = Object.keys(body.parameters as object);
    expect(documented.length).toBeLessThan(ALLOWED.size);
    expect(run(platformWith(body)).code).toBe(0);
  });

  it('ignores a published limit this server does not mirror', () => {
    const body = validManifest();
    (body.limits as Record<string, number>)['something.weDoNotHold'] = 7;
    expect(run(platformWith(body)).code).toBe(0);
  });
});

whenStripping('discovery', () => {
  it('fails when a named directory is not a platform checkout', () => {
    // The one machine where this gate is enforced sets this variable for three
    // SDKs at once. A path that moves, or a variable that fails to expand, is
    // otherwise indistinguishable from "no platform here" — three green no-ops
    // on the only run that compares them.
    const empty = mkdtempSync(join(tmpdir(), 'not-platform-'));
    const { code, out } = run(empty);
    expect(code).toBe(1);
    expect(out).toContain('does not hold');
  });

  it('fails loudly when a real checkout has no manifest, rather than skipping', () => {
    // The tidying that would quietly reopen the original fail-open: make the
    // manifest the MARKER too, and a checkout that lost it stops being the
    // platform at all — so this exit 1 becomes "not found, skipping" at exit 0.
    const { code, out } = run(platformWith(null));
    expect(code).toBe(1);
    expect(out).toContain(`no ${MANIFEST}`);
  });
});

/** The first route the fixture documents parameters for. */
function firstDocumented(body: { parameters: Record<string, unknown> }): string {
  const [route] = Object.keys(body.parameters);
  if (route === undefined) throw new Error('fixture documents no parameters');
  return route;
}

/** The mirror's first limit, as the pair the drift cases mutate. */
function firstLimit(): [string, number] {
  const pair = [...LIMITS][0];
  if (pair === undefined) throw new Error('the mirror holds no limits');
  return pair;
}

/** One defect apiece, each applied to an OTHERWISE VALID manifest. */
const MALFORMED: ReadonlyArray<readonly [string, (b: any) => void, string]> = [
  ['no version', (b) => delete b.version, "has no integer 'version'"],
  ['version is a string', (b) => (b.version = '1'), "has no integer 'version'"],
  // The sharpest of them: a future layout that moved `parameters` under a new
  // key reads, leniently, as a platform that documents no parameters at all.
  ['a version from the future', (b) => (b.version = 2), 'this reader knows 1'],
  ['no routes', (b) => delete b.routes, "has no 'routes'"],
  ['no parameters', (b) => delete b.parameters, "has no 'parameters'"],
  ['no limits', (b) => delete b.limits, "has no 'limits'"],
  // A NON-EMPTY object, keyed by the routes that were there. `{}` is refused by
  // the emptiness half of the same guard, so it pins nothing about the type
  // half — and a compound guard whose halves are never exercised separately is
  // a test that passes with one of them deleted. Found by an adversarial review
  // of the Python SDK's copy of this table.
  [
    'routes is a non-empty object',
    (b) => (b.routes = Object.fromEntries(b.routes.map((r: string) => [r, null]))),
    "'routes' is not a non-empty array",
  ],
  ['routes is empty', (b) => (b.routes = []), "'routes' is not a non-empty array"],
  ['a route is a number', (b) => b.routes.push(7), "'routes' holds a non-string entry"],
  // A LEADING space, so the method is empty and the pattern is not. Spelled
  // 'widgets' it trips the empty-method, empty-pattern and case predicates at
  // once, so the case pins none of them.
  ['a route has no method', (b) => b.routes.push(' widgets'), "is not 'METHOD pattern'"],
  ['a route method is lowercase', (b) => b.routes.push('get widgets'), "is not 'METHOD pattern'"],
  ['a route has no pattern', (b) => b.routes.push('GET '), "is not 'METHOD pattern'"],
  ['a route pattern has a space', (b) => b.routes.push('GET wid gets'), "is not 'METHOD pattern'"],
  ['a route is listed twice', (b) => b.routes.push(b.routes[0]), 'twice'],
  ['parameters is an array', (b) => (b.parameters = []), "'parameters' is not an object"],
  // `null` and a scalar separate the three predicates of that one guard, each of
  // which is otherwise answered by whichever sibling fires first.
  ['parameters is null', (b) => (b.parameters = null), "'parameters' is not an object"],
  ['parameters is a number', (b) => (b.parameters = 7), "'parameters' is not an object"],
  [
    'parameters documents an unknown route',
    (b) => (b.parameters['GET widgets'] = ['query:w']),
    "which is not in 'routes'",
  ],
  [
    'a parameter list is a string',
    (b) => (b.parameters[firstDocumented(b)] = 'query:w'),
    'is not an array',
  ],
  [
    'a parameter is a number',
    (b) => (b.parameters[firstDocumented(b)] = [7]),
    'holds a non-string',
  ],
  [
    'a parameter names no kind',
    (b) => (b.parameters[firstDocumented(b)] = ['w']),
    'names no query:, header: or body: field',
  ],
  ['limits is an array', (b) => (b.limits = []), "'limits' is not an object"],
  ['limits is null', (b) => (b.limits = null), "'limits' is not an object"],
  ['limits is a number', (b) => (b.limits = 7), "'limits' is not an object"],
  ['a limit is a string', (b) => (b.limits['agent.maxSteps'] = '100'), 'which is not an integer'],
  ['a limit is a float', (b) => (b.limits['agent.maxSteps'] = 1.5), 'which is not an integer'],
];

whenStripping('a manifest this reader cannot understand', () => {
  // Each case starts from something that PASSES and breaks exactly one thing,
  // then asserts the diagnostic that names the thing broken. Written as
  // hand-made stubs instead, a case meant to pin the version check is satisfied
  // by its own empty `routes` list — so the guard could be deleted with the
  // test still green, which is a test that cannot regress.
  it.each(MALFORMED)('fails on %s', (_name, breakIt, expected) => {
    const body = validManifest();
    breakIt(body);
    const { code, out } = run(platformWith(body));
    expect(code).toBe(1);
    expect(out).toContain('compares nothing it cannot read');
    expect(out).toContain(expected);
  });

  it.each([
    ['truncated mid-object', '{"version": 1, "routes": ['],
    ['an empty file', ''],
    ['HTML from a proxy', '<!doctype html><title>404</title>'],
    ['a JSON array', '[]'],
    ['a JSON string', '"surface"'],
  ])('fails on %s', (_name, raw) => {
    const { code, out } = run(platformWith(null, { raw }));
    expect(code).toBe(1);
    expect(out).toContain('compares nothing it cannot read');
  });
});

whenStripping('drift the check exists to catch', () => {
  it('reports a route the platform added and the mirror lacks', () => {
    const body = validManifest();
    (body.routes as string[]).push('POST widgets');
    const { code, out } = run(platformWith(body));
    expect(code).toBe(1);
    expect(out).toContain('+ POST widgets');
  });

  it('reports a parameter added to a route the mirror already lists', () => {
    // The reason the parameter half exists. `Range` on
    // `GET computers/:id/files` is the only way a file larger than one request
    // comes off a computer at all, and it landed on a route the mirror already
    // had. A route table cannot see it.
    const body = validManifest();
    const params = body.parameters as Record<string, string[]>;
    params['GET computers/:id/files'] = [
      ...(params['GET computers/:id/files'] ?? []),
      'header:X-New-Thing',
    ];
    const { code, out } = run(platformWith(body));
    expect(code).toBe(1);
    expect(out).toContain('header:X-New-Thing');
  });

  it('reports a limit that has drifted', () => {
    const body = validManifest();
    const [key, value] = firstLimit();
    (body.limits as Record<string, number>)[key] = value + 1;
    const { code, out } = run(platformWith(body));
    expect(code).toBe(1);
    expect(out).toContain(`${key} is ${value} in this server, but ${value + 1} upstream`);
  });

  it('reports a limit the server refuses against that the platform withdrew', () => {
    // The quietest of the three drifts: the server goes on turning callers away
    // on a ceiling nobody upstream is asserting, and the request that would have
    // proved it is the one never sent.
    const body = validManifest();
    const [key] = firstLimit();
    delete (body.limits as Record<string, number>)[key];
    const { code, out } = run(platformWith(body));
    expect(code).toBe(1);
    expect(out).toContain(key);
    expect(out).toContain('no longer publishes');
  });
});

whenStripping('a manifest that names a key twice', () => {
  // `JSON.parse` keeps the LAST occurrence and says nothing, and a reviver
  // cannot see it — the object is already built by the time the reviver runs.
  // Found by an adversarial review of the Python SDK's copy of this check.
  it.each([
    [
      'two routes tables',
      '{"version": 1, "routes": ["GET widgets"], "routes": ["GET sizes"], ' +
        '"parameters": {}, "limits": {}}',
      'routes',
    ],
    [
      'one route documented twice',
      '{"version": 1, "routes": ["GET sizes"], "parameters": ' +
        '{"GET sizes": ["query:a"], "GET sizes": ["query:b"]}, "limits": {}}',
      'GET sizes',
    ],
    [
      'one limit written twice',
      '{"version": 1, "routes": ["GET sizes"], "parameters": {}, ' +
        '"limits": {"agent.maxSteps": 100, "agent.maxSteps": 999}}',
      'agent.maxSteps',
    ],
    [
      // Reported as a HIGH bypass: `"routes"` and `"\u0072outes"` are two
      // spellings of ONE key to JSON.parse, so the escaped table silently
      // replaced the conflicting one and a raw comparison saw no duplicate.
      // This manifest is otherwise complete, and printed the success line.
      'a duplicate key spelled with a unicode escape',
      `{"version": 1, "routes": ["POST hidden"], "\\u0072outes": ` +
        `${JSON.stringify([...ALLOWED].sort())}, "parameters": {}, "limits": {}}`,
      'routes',
    ],
    [
      // The other HIGH bypass: a repeated EMPTY key made `duplicateKey` return
      // `''`, which a truthiness test read as "no duplicate" — disabling the
      // rest of the scan, so the conflicting `routes` table behind it went
      // unnoticed.
      'a repeated empty key ahead of a conflicting table',
      `{"": 0, "": 1, "version": 1, "routes": ["POST hidden"], "routes": ` +
        `${JSON.stringify([...ALLOWED].sort())}, "parameters": {}, "limits": {}}`,
      '',
    ],
    [
      'a key hidden after a brace inside a string',
      '{"version": 1, "routes": ["GET sizes"], "parameters": {"GET sizes": ["query:{a}"]}, ' +
        '"limits": {}, "limits": {}}',
      'limits',
    ],
  ])('fails on %s', (_name, raw, named) => {
    const { code, out } = run(platformWith(null, { raw }));
    expect(code).toBe(1);
    expect(out).toContain(`names "${named}" twice`);
  });

  it('does not mistake repeated keys in sibling objects for a duplicate', () => {
    // `[{"a":1},{"a":2}]` is two objects. A scanner that tracked one key set
    // for the whole document would refuse every real manifest, since each
    // route's parameter list is an object of its own.
    expect(run(platformWith(validManifest())).code).toBe(0);
  });
});
