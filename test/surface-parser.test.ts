import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { balanced, entries, topLevelField } from '../scripts/surface-text.mjs';

/**
 * The scanner behind check:surface, which has no other test.
 *
 * scripts/surface-text.mjs is a copy of the same file in the TypeScript SDK,
 * kept byte-identical on purpose: a parser bug found in one is owed to the
 * other, and this is the third such trade. These tests are that copy's, for the
 * same reason.
 */
describe('the surface source scanner', () => {
  it('reads a field at its own depth, not one a nested literal got in first', () => {
    const entry = `method: 'GET', handler: { fallback: { pattern: 'nested' } }, pattern: 'real'`;
    expect(topLevelField(entry, 'pattern')).toBe('real');
    expect(topLevelField(entry, 'method')).toBe('GET');
  });

  it('does not read a field out of the tail of a longer key', () => {
    expect(topLevelField(`submethod: 'wrong', method: 'GET'`, 'method')).toBe('GET');
  });

  it('returns undefined for a field the literal does not have at all', () => {
    expect(topLevelField(`pattern: 'orphan'`, 'method')).toBeUndefined();
    expect(topLevelField(`nested: { method: 'GET' }`, 'method')).toBeUndefined();
  });

  it('does not read a field out of prose that quotes one', () => {
    expect(
      topLevelField(`description: 'takes a method: \\'GET\\' here', method: 'PUT'`, 'method'),
    ).toBe('PUT');
  });

  it('reads a value in any of the three quote styles', () => {
    expect(topLevelField(`pattern: "computers/:id"`, 'pattern')).toBe('computers/:id');
    expect(topLevelField('pattern: `computers/:id`', 'pattern')).toBe('computers/:id');
    expect(topLevelField(`pattern: 'computers/:id'`, 'pattern')).toBe('computers/:id');
  });

  it('reads a value whose quote is escaped inside it', () => {
    // The value alternation this replaced ended at the first `"`, backslash or
    // not, so the value came back as `a\` — a route in neither table, reported
    // as one the platform serves and the mirror forgot.
    expect(topLevelField(`pattern: "a\\"b"`, 'pattern')).toBe('a"b');
    expect(topLevelField(`pattern: 'a\\'b', method: 'GET'`, 'pattern')).toBe("a'b");
    expect(topLevelField('pattern: `a\\`b`', 'pattern')).toBe('a`b');
    expect(topLevelField(`pattern: 'a\\\\b'`, 'pattern')).toBe('a\\b');
  });

  it('declines a template literal with a hole rather than reading it raw', () => {
    // Half of a route is not a route, and the entry is dropped as half-written.
    // Handing back the source text of the interpolation would be a pattern the
    // platform never serves, compared against a mirror as if it did.
    expect(topLevelField(`pattern: \`computers/\${id}\``, 'pattern')).toBeUndefined();
  });

  it('reads an escaped interpolation as the characters it spells', () => {
    // The other half of the same escape blindness: `\${` interpolates nothing,
    // so declining it drops a whole route as half-written and the mirror is
    // told the platform stopped serving it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the spelling is the subject
    expect(topLevelField('pattern: `a\\${b}`', 'pattern')).toBe('a${b}');
  });

  it('takes a key with a regex metacharacter in it literally', () => {
    // `name` goes into a RegExp, so unescaped it was a pattern and not a key:
    // `.` matched any character, so `a.b` read the value out of `axb`, and the
    // `$` of `$ref` anchored the end of the input so it matched nothing at all.
    expect(topLevelField(`axb: 'wrong'`, 'a.b')).toBeUndefined();
    expect(topLevelField(`$ref: 'here'`, '$ref')).toBe('here');
  });

  it('splits entries without counting braces inside literals', () => {
    expect(entries(`{ a: 'one } two' }, { b: /[{]/ }, { c: \`three { four\` }`)).toEqual([
      ` a: 'one } two' `,
      ' b: /[{]/ ',
      ' c: `three { four` ',
    ]);
  });

  it('refuses a list body whose braces do not balance', () => {
    expect(() => entries('{ a: 1 } }')).toThrow(/unbalanced/);
    expect(() => entries('{ a: 1')).toThrow(/unbalanced/);
  });

  it('refuses an offset that is not the opening delimiter', () => {
    // The -1 an indexOf answers for a shape the caller does not handle —
    // `body: object(SHARED_FIELDS)`, a literal named rather than spelled. From
    // there the walk opened nothing, so the first closer it met ended it and
    // the slice came back short: the route read as documenting no fields at
    // all, and the mirror was told it agreed.
    expect(() => balanced('abc { d } e', -1, '{', '}')).toThrow(/not \{/);
    expect(() => balanced('abc { d } e', 0, '{', '}')).toThrow(/not \{/);
    expect(balanced('abc { d } e', 4, '{', '}')).toBe(' d ');
  });
});

/**
 * What the script says about a fixture platform repo.
 *
 * Neither `routeTable` nor `platformParameters` is importable — check-surface.mjs
 * reads the platform repo at module scope and exits when it is not there — so
 * the fixture is a platform repo and the assertion is on what the script says it
 * found. The script's own `!routes.size` and `!platformParams.size` guards
 * cannot stand in for this: a mispaired parse finds plenty.
 *
 * Spawned, not spawnSync'd. Each scan is a whole node process, and the
 * synchronous call held this worker's event loop for the length of it — long
 * enough, in the TypeScript SDK, to push a sibling worker's 20ms timeout
 * assertion past its deadline. The real-time waits in http.test.ts are the same
 * hazard here. Awaiting the child gives the loop back while the process runs.
 */
const scan = async (routes: string, docs: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-fixture-'));
  mkdirSync(join(dir, 'web/lib'), { recursive: true });
  writeFileSync(
    join(dir, 'web/lib/surface.ts'),
    `export const V1_ROUTES: Route[] = [${routes}];\n`,
  );
  writeFileSync(
    join(dir, 'web/lib/apidoc.ts'),
    `export const DOCS: Record<string, Doc> = {${docs}};\n`,
  );
  try {
    // Exits 1: a fixture matches none of the real mirror. The `+` lines are what
    // it read out of the fixture, which is the subject here.
    return await new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, ['scripts/check-surface.mjs'], {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, MANDALA_PLATFORM_REPO: dir },
      });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        out += chunk;
      });
      child.on('error', fail);
      child.on('close', () => done(out));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('the route table reader', () => {
  const scanTable = async (table: string) =>
    [...(await scan(table, '')).matchAll(/^ {2}\+ ([A-Z]+ \S+)$/gm)].map((m) => m[1]);

  it('does not let a nested literal lend its pattern to the entry above', async () => {
    // The regex inside the sliced entry took the first `pattern:` at any depth,
    // so this read as `GET not-a-route` — in neither table, and so reported by
    // neither, while `GET gamma` went missing from upstream.
    expect(
      await scanTable(`
        { method: 'GET', handler: { fallback: { pattern: 'not-a-route' } }, pattern: 'gamma' },
      `),
    ).toEqual(['GET gamma']);
  });

  it('reads a route whose entry writes pattern before method', async () => {
    expect(
      await scanTable(`
        { role: 'viewer', pattern: 'alpha', method: 'GET' },
        { method: 'POST', pattern: 'beta' },
      `),
    ).toEqual(['GET alpha', 'POST beta']);
  });

  it('ignores an entry that carries only half of the pair', async () => {
    expect(await scanTable(`{ pattern: 'orphan' }, { method: 'PUT', pattern: 'delta' },`)).toEqual([
      'PUT delta',
    ]);
  });

  it('keeps reading entries past a brace quoted inside one of them', async () => {
    // The raw brace count this replaced went to -1 on that `}` and never came
    // back to 0, so `from` was never re-armed: the two routes after it were
    // dropped, `routes.size` stayed non-zero so no guard fired, and check
    // reported them as routes the platform no longer serves.
    expect(
      await scanTable(`
        { method: 'GET', pattern: 'alpha' },
        { method: 'GET', pattern: 'beta', note: 'the } closer' },
        { method: 'DELETE', pattern: 'gamma' },
        { method: 'GET', pattern: 'delta' },
      `),
    ).toEqual(['DELETE gamma', 'GET alpha', 'GET beta', 'GET delta']);
  });

  it('reads a route the table spells with double quotes or a backtick', async () => {
    expect(
      await scanTable(`
        { method: "GET", pattern: "alpha" },
        { method: \`POST\`, pattern: \`beta\` },
      `),
    ).toEqual(['GET alpha', 'POST beta']);
  });
});

/**
 * The parameter reader, over a DOCS table it does not control either.
 *
 * `GET computers` because the parameter comparison runs only over routes both
 * tables agree exist, and that one is in the mirror. The `+` lines name what
 * the fixture documents and the mirror does not list, which is where whatever
 * the reader found shows up.
 */
describe('the parameter reader', () => {
  const scanParams = async (docs: string) => {
    const said = await scan(`{ method: 'GET', pattern: 'computers' }`, docs);
    return [...said.matchAll(/^ {2}\+ [A-Z]+ \S+ {2}(\S+)$/gm)].map((m) => m[1]);
  };

  it('does not read an entry out of a comment that quotes the shape of one', async () => {
    // apidoc.ts is heavily commented and several of those comments spell the
    // very shape being matched. Over the raw text the entry regex read this one
    // as a second `'GET computers'` and it replaced the real one — the route
    // then documented a parameter the platform does not, which is the mirror
    // agreeing with the wrong table. routeTable has stripped first all along.
    expect(
      await scanParams(`
        'GET computers': { query: [{ name: 'zzz' }] },
        // The shape, for reference: 'GET computers': { query: [{ name: 'ignored' }] }
      `),
    ).toEqual(['query:zzz']);
  });

  it("reads the route's own list, not one nested in an example", async () => {
    // A plain indexOf takes the first `query: [` at any depth, so an example or
    // an options bag nested in the entry supplied the parameter set and the
    // route's real list, further down, was never read.
    expect(
      await scanParams(`
        'GET computers': {
          example: { query: [{ name: 'nested' }] },
          query: [{ name: 'zzz' }],
        },
      `),
    ).toEqual(['query:zzz']);
  });
});
