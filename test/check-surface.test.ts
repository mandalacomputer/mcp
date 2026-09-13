import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../src/limits.js';
import { ALLOWED, PARAMETERS } from './allowlist.js';

/**
 * The surface check, end to end, over a platform checkout it does not control.
 *
 * The script reads the platform's manifest and imports this repo's own mirror,
 * so the fixture is a platform directory and the assertion is on what the
 * script says. The cases that matter most are the ones where it must NOT say
 * "matches": the recurring defect in the scanner this replaced was a false
 * all-clear, and a manifest diff can print one too if it silently reads nothing.
 */
/**
 * Whether this Node strips types itself (22.18 and later), which the script
 * needs to import the mirror. Below that the script refuses, naming the version
 * it needs — asserted below — and the cases that need a real comparison are
 * skipped rather than failed: the repository supports older Node for the
 * package, and the platform's own CI, where the comparison is enforced, runs a
 * Node that strips.
 */
const strips = (() => {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
})();

describe('check:surface', () => {
  // Spawned, not spawnSync'd: a synchronous child holds this worker's event loop
  // for the length of the run, and a timing assertion in a sibling worker missed
  // its deadline because of it.
  const runCheck = async (platformRepo: string | undefined, cwd = resolve(__dirname, '..')) =>
    new Promise<{ said: string; code: number | null }>((done, fail) => {
      const env = { ...process.env };
      if (platformRepo === undefined) delete env.MANDALA_PLATFORM_REPO;
      else env.MANDALA_PLATFORM_REPO = platformRepo;
      const child = spawn(process.execPath, [resolve(__dirname, '../scripts/check-surface.mjs')], {
        cwd,
        env,
      });
      let said = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        said += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        said += chunk;
      });
      child.on('error', fail);
      child.on('close', (code) => done({ said, code }));
    });

  /** A manifest exactly in step with this repo's mirror: every drift case starts here. */
  const inStep = () => ({
    version: 1,
    routes: [...ALLOWED].sort(),
    parameters: Object.fromEntries([...PARAMETERS].filter(([, names]) => names.length)),
    limits: { 'agent.maxSteps': 100, ...LIMITS } as Record<string, number>,
  });

  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /**
   * A directory shaped like a platform checkout — the identity files, never
   * read — holding `manifest`, or no manifest at all.
   */
  const fixture = (manifest: unknown | null, under = tmpdir(), identity = true) => {
    mkdirSync(under, { recursive: true });
    const dir = mkdtempSync(join(under, 'surface-fixture-'));
    made.push(dir);
    if (identity) {
      mkdirSync(join(dir, 'web/lib'), { recursive: true });
      writeFileSync(join(dir, 'web/lib/surface.ts'), '// synthesized\n');
      writeFileSync(join(dir, 'web/lib/apidoc.ts'), '// synthesized\n');
    }
    if (manifest !== null) {
      writeFileSync(
        join(dir, 'surface-manifest.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
      );
    }
    return dir;
  };

  it.skipIf(!strips)('says the mirror matches, with the counts, when it does', async () => {
    const { said, code } = await runCheck(fixture(inStep()));
    const counted = [...PARAMETERS.values()].reduce((n, names) => n + names.length, 0);
    expect(said).toContain(
      `the mirror matches the platform (${ALLOWED.size} routes, ${counted} parameters, ${Object.keys(LIMITS).length} limits`,
    );
    expect(code).toBe(0);
  });

  it.skipIf(!strips)('names a route that moved in either direction', async () => {
    const manifest = inStep();
    manifest.routes = manifest.routes.filter((r) => r !== 'GET sizes').concat('POST widgets');
    const { said, code } = await runCheck(fixture(manifest));
    expect(said).toContain('+ POST widgets');
    expect(said).toContain('- GET sizes');
    expect(said).not.toContain('matches');
    expect(code).toBe(1);
  });

  it.skipIf(!strips)(
    'names a limit that moved, or one the platform stopped publishing',
    async () => {
      // Compared here, in the script the platform's own CI runs, rather than in a
      // test that skips without a checkout — where none of these could drift.
      // Whichever limits this repo mirrors: the first moved, the last withdrawn.
      const keys = Object.keys(LIMITS) as [keyof typeof LIMITS, ...(keyof typeof LIMITS)[]];
      const moved = keys[0];
      const gone = keys.at(-1) ?? moved;
      const manifest = inStep();
      manifest.limits[moved] = LIMITS[moved] + 1;
      delete manifest.limits[gone];
      const { said, code } = await runCheck(fixture(manifest));
      expect(said).toContain(
        `! ${moved} is ${LIMITS[moved]} here, but the platform's is ${LIMITS[moved] + 1}`,
      );
      expect(said).toContain(
        `! ${gone} is ${LIMITS[gone]} here, and the platform does not publish it`,
      );
      expect(said).not.toContain('matches');
      expect(code).toBe(1);
    },
  );

  it.skipIf(!strips)('names a parameter that moved in either direction', async () => {
    const manifest = inStep();
    manifest.parameters['GET sizes'] = ['query:fresh'];
    manifest.parameters['DELETE computers/:id'] = ['query:expect'];
    const { said, code } = await runCheck(fixture(manifest));
    expect(said).toContain('+ GET sizes  query:fresh');
    expect(said).toContain('- DELETE computers/:id  query:snapshots');
    expect(code).toBe(1);
  });

  it.each([
    ['not json {', 'cannot be read'],
    ['[]', 'not a JSON object'],
    [{ version: 2, routes: ['GET x'], parameters: {} }, 'version 2'],
    [{ version: 1, routes: [], parameters: {} }, 'lists no routes'],
    [{ version: 1, parameters: {} }, 'lists no routes'],
    [{ version: 1, routes: ['sizes'], parameters: {} }, "not 'METHOD pattern'"],
    [{ version: 1, routes: ['FETCH sizes'], parameters: {} }, "not 'METHOD pattern'"],
    [{ version: 1, routes: ['GET sizes'] }, 'no parameters table'],
    [
      { version: 1, routes: ['GET sizes'], parameters: { 'GET gone': [] } },
      'route it does not list',
    ],
    [{ version: 1, routes: ['GET sizes'], parameters: { 'GET sizes': ['fresh'] } }, 'cannot read'],
  ])(
    'refuses a manifest it cannot read rather than comparing nothing: %j',
    async (broken, says) => {
      // The false all-clear, made into a failure that names itself.
      const { said, code } = await runCheck(fixture(broken));
      expect(said).toContain(says);
      expect(said).not.toContain('matches');
      expect(code).toBe(1);
    },
  );

  it.skipIf(!strips)('says so when the routes agreed and no parameter was compared', async () => {
    // The count in the success line is also the only evidence the parameter half
    // ran. Both sides empty is not a match, it is a comparison that did not happen.
    const { said, code } = await runCheck(
      fixture({ version: 1, routes: ['GET templates'], parameters: {} }),
    );
    expect(said).toContain('compared zero parameters across 1 shared routes');
    expect(code).toBe(1);
  });

  it.runIf(!strips)(
    'refuses, naming the Node it needs, where the mirror cannot be imported',
    async () => {
      // Older than 22.18: no type stripping, so the mirror cannot be imported and
      // the comparison cannot be made. Loud, and a failure — never a skip.
      const { said, code } = await runCheck(fixture(inStep()));
      expect(said).toContain('could not be imported');
      expect(said).toContain('22.18');
      expect(said).not.toContain('matches');
      expect(code).toBe(1);
    },
  );

  it('skips, and says so, when no platform is checked out', async () => {
    const { said, code } = await runCheck(undefined, fixture(null));
    // Only when nothing next door answers either; a sibling checkout on this
    // machine is a real comparison, which is also fine.
    if (said.includes('skipping')) expect(code).toBe(0);
    else expect(said).toMatch(/matches|drifted/);
  });

  it('refuses a MANDALA_PLATFORM_REPO that does not hold the platform', async () => {
    // The variable is an assertion, and the machine that sets it is the one
    // machine where this gate is enforced — for three SDKs at once. Read as a
    // guess, a checkout that moved is indistinguishable from no platform at all.
    const { said, code } = await runCheck(fixture(null, tmpdir(), false));
    expect(code).toBe(1);
    expect(said).toContain('does not hold');
    expect(said).not.toContain('skipping');
  });

  it('fails, naming the file, on a platform checkout that has no manifest', async () => {
    // Identity is not the manifest: a copy that lost it, or predates it, is still
    // the platform, and the comparison that cannot be made is a failure rather
    // than a skip (review of the Python client's adoption).
    const { said, code } = await runCheck(fixture(null));
    expect(code).toBe(1);
    expect(said).toContain('surface-manifest.json is not there');
    expect(said).not.toContain('skipping');
  });

  it.skipIf(!strips)(
    'refuses a key that appears twice rather than reading the last one',
    async () => {
      // `JSON.parse` keeps the last of two equal keys and says nothing.
      const manifest = JSON.stringify(inStep());
      const twiceRoute = manifest.replace(
        '"parameters":{',
        '"parameters":{"DELETE computers/:id":["query:new_required"],',
      );
      const twiceLimit = manifest.replace('"limits":{', '"limits":{"agent.maxSteps":1,');
      expect(twiceRoute).not.toBe(manifest);
      expect(twiceLimit).not.toBe(manifest);
      for (const text of [twiceRoute, twiceLimit]) {
        const { said, code } = await runCheck(fixture(text));
        expect(said).toContain('appears twice');
        expect(said).not.toContain('matches');
        expect(code).toBe(1);
      }
      // Decoded before comparing: an escaped spelling of a key already present is
      // the same key to the parser, and was two to a walk over the raw text.
      const escaped = manifest.replace(
        '"parameters":{',
        '"parameters":{"\\u0044ELETE computers/:id":["query:new_required"],',
      );
      expect(escaped).not.toBe(manifest);
      const asEscaped = await runCheck(fixture(escaped));
      expect(asEscaped.said).toContain('appears twice');
      expect(asEscaped.code).toBe(1);
      // The empty string is a legal key, and a repeated one is still a repeat.
      const empty = manifest.replace('"parameters":{', '"parameters":{"":[],"":[],');
      const asEmpty = await runCheck(fixture(empty));
      expect(asEmpty.said).toContain('appears twice');
      // And a value that merely repeats a KEY'S spelling is not a repeated key: two
      // routes with the same parameter name, a string holding a brace.
      const fine = inStep();
      fine.parameters['GET sizes'] = ['query:expect'];
      fine.routes.push('GET brace/{x}');
      const { said } = await runCheck(fixture(fine));
      expect(said).not.toContain('appears twice');
    },
  );

  it.skipIf(!strips)('resolves a relative MANDALA_PLATFORM_REPO against this repo', async () => {
    const root = resolve(__dirname, '..');
    const manifest = inStep();
    manifest.routes.push('GET alpha');
    const dir = fixture(manifest, join(root, 'node_modules/.cache'));
    const { said } = await runCheck(relative(root, dir), tmpdir());
    expect(said).toContain('+ GET alpha');
  });
});
