import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  balanced,
  entries,
  stripComments,
  topLevelField,
  topLevelKeys,
} from '../scripts/surface-text.mjs';

/**
 * The scanner behind check:surface, which has no other test.
 *
 * scripts/surface-text.mjs is a copy of the same file in the TypeScript SDK,
 * kept byte-identical on purpose: a parser bug found in one is owed to the
 * other, and this is the third such trade. These tests are that copy's, for the
 * same reason.
 */
describe('the surface source scanner', () => {
  it('ignores brackets in quoted strings and comments', () => {
    const source = `[{
      description: 'a ] inside prose',
      other: "another ] inside prose",
      template: \`another ]\`,
      // ] in a comment
      nested: [1, 2],
      /* and one more ] */
    }] after`;
    expect(balanced(source, 0, '[', ']')).toContain('nested: [1, 2]');
  });

  it('does not invent top-level keys from descriptions', () => {
    expect(
      topLevelKeys(`name: 'real', description: "fake: value", nested: { inner: true }`),
    ).toEqual(['name', 'description', 'nested']);
  });

  it('reads a colon as a key only where a key can be', () => {
    // A key is at the start of the object or just after a comma. The colon of a
    // ternary is neither, in both of the shapes that reach one: the quoted
    // branch reads the consequent of `flag ? 'a' : 'b'` and the identifier
    // branch reads the consequent of `flag ? a : b`. Either way the caller is
    // handed a field the object does not have, and a body field nobody sends is
    // a parameter the mirror is told to grow.
    expect(topLevelKeys(`name: flag ? 'a' : 'b', size: 1`)).toEqual(['name', 'size']);
    expect(topLevelKeys('name: flag ? a : b, size: 1')).toEqual(['name', 'size']);
    expect(topLevelKeys(`'quoted': 1, plain: 2`)).toEqual(['quoted', 'plain']);
  });

  it('strips real comments without truncating comment markers inside strings', () => {
    const source = `
      const docs = { url: 'https://example.com/a//b' }; // remove this
      const template = \`https://example.com/${'path'}\`;
      /* remove this too */ const kept = "// still text";
    `;
    const clean = stripComments(source);
    expect(clean).toHaveLength(source.length);
    expect(clean).toContain("'https://example.com/a//b'");
    expect(clean).toContain('`https://example.com/path`');
    expect(clean).toContain('"// still text"');
    expect(clean).not.toContain('remove this');
  });

  it('does not treat the escaped delimiter at the end of a regex as a comment', () => {
    const source = String.raw`
      const route = /https:\/\//; // remove this
      const divided = total / count; // and this
    `;
    const clean = stripComments(source);
    expect(clean).toHaveLength(source.length);
    expect(clean).toContain(String.raw`/https:\/\//`);
    expect(clean).toContain('total / count');
    expect(clean).not.toContain('remove this');
    expect(clean).not.toContain('and this');
  });

  it('ignores brackets inside regex literals while balancing source', () => {
    const source = String.raw`[{ route: /[}\]]+/, nested: [1, 2] }] after`;
    expect(balanced(source, 0, '[', ']')).toContain('nested: [1, 2]');
  });

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

  it('refuses a list element that is not an object literal', () => {
    // A spread carries entries this walk cannot see. Emitting the ones around
    // it hands back a table short by however many it held, and those surface as
    // routes the mirror invented — the wrong file, and a number nobody can act
    // on, where the parse simply did not read the list whole.
    expect(() => entries(' {a:1}, ...SHARED, {b:2} ')).toThrow(/not an object literal/);
    expect(() => entries(' {a:1}, buildEntry(x), {b:2} ')).toThrow(/not an object literal/);
    expect(() => entries(" {a:1}, 'GET x', {b:2} ")).toThrow(/not an object literal/);
    expect(entries(' {a:1}, {b:2}, ')).toEqual(['a:1', 'b:2']);
  });

  it('reads a quoted key as the key it names', () => {
    // Skipped, the object reads as having no fields at all — which the caller
    // reports as a route documenting no body, against a mirror that lists none
    // for it either. The two then agree about nothing and the gate says so.
    expect(topLevelKeys(`'name': str('x'), age: 1`)).toEqual(['name', 'age']);
    expect(topLevelKeys(`"name": 1, \`size\`: 2`)).toEqual(['name', 'size']);
    expect(topLevelKeys(`'a\\'b': 1`)).toEqual(["a'b"]);
    // A quoted value is still a value: only a literal a colon follows is a key.
    expect(topLevelKeys(`name: 'real', other: "fake: value"`)).toEqual(['name', 'other']);
  });

  it('refuses a body whose delimiters close more than they opened', () => {
    // Silent truncation is the failure this gate exists to refuse: the depth
    // never climbs back, so every key after the stray closer is dropped and the
    // caller is told the object has no more fields rather than that it could
    // not be read.
    expect(() => topLevelKeys(' a: 1 ) b: 2 ')).toThrow(/unbalanced/);
    expect(() => topLevelField(" x: 1 ) method: 'GET' ", 'method')).toThrow(/unbalanced/);
  });

  it('refuses to balance from an offset that is not the opening delimiter', () => {
    // What a caller's `indexOf` hands over for a delimiter that is not there is
    // -1, and -1 is a legal place to start counting from: the text from offset 0
    // to whatever closer turned up first came back looking like an answer.
    expect(() => balanced('xxxx { a: 1 } yyy', -1, '{', '}')).toThrow(/not a \{/);
    expect(() => balanced('abc { d } e', 0, '{', '}')).toThrow(/not a \{/);
  });

  it('reads a regex that follows the head of a statement, not a division', () => {
    // The `)` was read as the end of a value, so the slash divided, and the
    // first quote inside the character class opened a literal that ran on past
    // the comment and into the code after it.
    const source = `if (ok) /['"]/.test(p); // remove this\nreal: 'value'`;
    const clean = stripComments(source);
    expect(clean).toHaveLength(source.length);
    expect(clean).toContain(`/['"]/`);
    expect(clean).toContain("real: 'value'");
    expect(clean).not.toContain('remove this');
  });

  it('still reads a slash after an ordinary parenthesis as division', () => {
    const source = 'const x = (a + b) / c; // remove this\nconst y = f(a) / d; // and this\n';
    const clean = stripComments(source);
    expect(clean).toContain('(a + b) / c');
    expect(clean).toContain('f(a) / d');
    expect(clean).not.toContain('remove this');
    expect(clean).not.toContain('and this');
  });

  it('reads a regex that follows a keyword', () => {
    for (const word of ['typeof', 'in', 'of', 'instanceof', 'new', 'void', 'delete', 'else']) {
      const source = `x = a ${word} /b['c]/; // remove this\n`;
      expect(stripComments(source)).not.toContain('remove this');
    }
  });

  it('reads a slash after a subscript as division, which is the residual case', () => {
    // `]` closes an index or an array literal and no statement head ends in one,
    // so dividing is the right answer for everything either file scanned here
    // writes. A regex placed directly against a subscript — `parts[0] /re/` — is
    // read as division, and nothing local distinguishes the two; this pins which
    // way the ambiguity is resolved rather than claiming it is not there.
    expect(stripComments('const n = parts[0] / 2; // remove this\n')).not.toContain('remove this');
    const missed = stripComments(`const m = parts[0] /['x]/.test(s); // kept, wrongly\n`);
    expect(missed).toContain('kept, wrongly');
  });

  it('measures a template literal past its interpolations', () => {
    // A backtick inside `${…}` closes nothing: the literal ends where its own
    // quote does. Ending it at the first quote the interpolation happens to
    // contain puts every character after it in the wrong mode, and the comment
    // that follows is read as part of a string.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the spelling is the subject
    const source = "const t = `a${x('`')}b`; // remove this\nconst k = 2;";
    const clean = stripComments(source);
    expect(clean).toHaveLength(source.length);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the spelling is the subject
    expect(clean).toContain("`a${x('`')}b`");
    expect(clean).not.toContain('remove this');
  });

  it('refuses an escape whose digits are not hex', () => {
    // `String.fromCharCode(NaN)` is NUL — an invisible character in the middle
    // of a route pattern — and `String.fromCodePoint(NaN)` throws a RangeError
    // naming neither the file nor the literal. Both mean the same thing: the
    // scanner was wrong about where the literal was.
    expect(() => topLevelField(String.raw`pattern: 'a\xZZb'`, 'pattern')).toThrow(/malformed/);
    expect(() => topLevelField(String.raw`pattern: 'a\uZZZZb'`, 'pattern')).toThrow(/malformed/);
    expect(() => topLevelField(String.raw`pattern: 'a\u{ZZ}b'`, 'pattern')).toThrow(/malformed/);
    expect(() => topLevelField(String.raw`pattern: 'a\u{FFFFFF}b'`, 'pattern')).toThrow(/range/);
    expect(topLevelField(String.raw`pattern: 'a\x41B\u{43}'`, 'pattern')).toBe('aABC');
  });

  it('reads back to the start of a word rather than over the whole prefix', () => {
    // Every slash outside a literal was answered by copying the file up to it
    // and scanning that copy for a trailing identifier — quadratic in the file,
    // for a word that is never more than a few characters back. A table of a few
    // hundred kilobytes is ordinary; this one is 190 KB and took seconds.
    const source = `const x = ${Array.from({ length: 12_000 }, (_, i) => `a${i} / b${i}`).join(' + ')};\n// remove this\n`;
    const started = Date.now();
    expect(stripComments(source)).not.toContain('remove this');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/**
 * The route reader, over a platform table it does not control.
 *
 * `routeTable` is not importable — check-surface.mjs reads the platform repo at
 * module scope and exits when it is not there — so the fixture is a platform
 * repo and the assertion is on what the script says it found. The script's own
 * `!routes.size` guard cannot stand in for this: a mispaired parse finds plenty.
 */
describe('the route table reader', () => {
  // Spawned, not spawnSync'd. Each scan is a whole node process, and the
  // synchronous call held this worker's event loop for the length of it —
  // long enough, in the TypeScript SDK, to push a sibling worker's 20ms timeout
  // assertion past its deadline. The real-time waits in http.test.ts are the
  // same hazard here. Awaiting the child gives the loop back while the process
  // runs, and the timing tests stop depending on which files vitest happened
  // to schedule alongside them.
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

  /** A directory shaped like a platform checkout, with either half omittable. */
  const fixture = (surface: string | null, apidoc: string | null = '', under = tmpdir()) => {
    mkdirSync(under, { recursive: true });
    const dir = mkdtempSync(join(under, 'surface-fixture-'));
    mkdirSync(join(dir, 'web/lib'), { recursive: true });
    if (surface !== null) writeFileSync(join(dir, 'web/lib/surface.ts'), surface);
    if (apidoc !== null) {
      writeFileSync(
        join(dir, 'web/lib/apidoc.ts'),
        apidoc || 'export const DOCS: Record<string, Doc> = {};\n',
      );
    }
    return dir;
  };

  const scanTable = async (table: string) => {
    const dir = fixture(`export const V1_ROUTES: Route[] = [${table}];\n`);
    try {
      // Exits 1: a two-route fixture matches none of the real mirror. The `+`
      // lines are the routes it read out of the fixture, which is the subject.
      const { said } = await runCheck(dir);
      return [...said.matchAll(/^ {2}\+ ([A-Z]+ \S+)$/gm)].map((m) => m[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /**
   * The parameter reader, over an apidoc.ts it does not control.
   *
   * `GET sizes` because the mirror lists it with no parameters at all: whatever
   * the fixture documents for it comes back as a `+` line naming the parameter,
   * which is the reader's answer written down.
   */
  const scanParams = async (apidoc: string) => {
    const dir = fixture(
      `export const V1_ROUTES: Route[] = [{ method: 'GET', pattern: 'sizes' }];\n`,
      apidoc,
    );
    try {
      const { said } = await runCheck(dir);
      return [...said.matchAll(/^ {2}\+ GET sizes {2}(\S+)$/gm)].map((m) => m[1]).sort();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** The same fixture, for the apidocs whose answer is a refusal rather than a list. */
  const refuseParams = async (apidoc: string) => {
    const dir = fixture(
      `export const V1_ROUTES: Route[] = [{ method: 'GET', pattern: 'sizes' }];\n`,
      apidoc,
    );
    try {
      return await runCheck(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('resolves a shared parameter constant however it is declared', async () => {
    // `export` and a leading indent change nothing about what the declaration
    // means, and a reader that insists on today's spelling reports every route
    // citing it as taking no parameters — a mirror that lists it then reads as
    // one that invented it, pointing at the wrong file.
    expect(
      await scanParams(`
        export const PARTIAL: Query = { name: 'allow_partial', description: 'x' };
        export const DOCS: Record<string, Doc> = {
          'GET sizes': { query: [PARTIAL] },
        };
      `),
    ).toEqual(['query:allow_partial']);
  });

  it('records a shared constant under the list that cites it', async () => {
    // `Query` is the type of both lists over there — `headers?: Query[]` — so a
    // shared constant in a `headers` list is a header. Recorded as a query it is
    // one missing parameter and one extra, both naming the same thing, and
    // neither of them true.
    expect(
      await scanParams(`
        const X_KEY: Query = { name: 'X-Model-Key', description: 'x' };
        export const DOCS: Record<string, Doc> = {
          'GET sizes': { headers: [X_KEY] },
        };
      `),
    ).toEqual(['header:X-Model-Key']);
  });

  it('reads a body whose object call is spelled with different whitespace', async () => {
    // The exact `body: object(` this replaced is a spelling, not a shape: a
    // formatter that puts the call on the next line yields no body fields at
    // all, silently, for a route that documents several.
    expect(
      await scanParams(`
        export const DOCS: Record<string, Doc> = {
          'GET sizes': {
            body:
              object({ name: str('Name'), size: str('Size') }, { title: 'Sizes' }),
          },
        };
      `),
    ).toEqual(['body:name', 'body:size']);
  });

  it('refuses a body in a shape it cannot read rather than reporting none', async () => {
    // Reported as no fields, the route reads as documenting no body at all —
    // and the mirror lists none for a route it cannot see either, so the two
    // agree over a body neither of them looked at.
    const { said, code } = await refuseParams(
      `export const DOCS: Record<string, Doc> = { 'GET sizes': { body: SHARED_BODY } };\n`,
    );
    expect(code).toBe(1);
    expect(said).toContain('documents a body in a form this reader does not know');
  });

  it('does not let a nested body literal vouch for the entry’s own', async () => {
    // The `{` was looked for anywhere in the entry while the key it belongs to
    // was found at the top level, so a `body: {` in a response example answered
    // for a `body:` the reader cannot read. The refusal is skipped, the route
    // reports no fields, and it matches a mirror that lists none — the vacuous
    // all-clear this guard was added to refuse, arriving through the guard.
    const { said, code } = await refuseParams(`
      export const DOCS: Record<string, Doc> = {
        'GET sizes': { responses: { 200: { body: { ok: true } } }, body: SHARED_BODY },
      };
    `);
    expect(code).toBe(1);
    expect(said).toContain("'GET sizes' documents a body in a form this reader does not know");
  });

  it('names the route when an object body is spelled with an identifier', async () => {
    // `object(SHARED_FIELDS)` has no literal for the field walk to start at, and
    // the unchecked search for one handed `balanced` a -1 that came back as
    // `started at offset -1, which is not a {` — an assertion naming neither the
    // route nor the file it is in. It is the same unreadable shape as the case
    // beside it and belongs in the same sentence.
    const { said, code } = await refuseParams(
      `export const DOCS: Record<string, Doc> = { 'GET sizes': { body: object(SHARED_FIELDS) } };\n`,
    );
    expect(code).toBe(1);
    expect(said).toContain("'GET sizes' documents a body in a form this reader does not know");
    expect(said).not.toContain('offset -1');
  });

  it('reads a query list whose bracket the formatter wrapped', async () => {
    // The one space after the colon is a spelling, not a shape. Missed, the
    // route's query and header parameters go unread with nothing said: a full
    // table still counts parameters elsewhere, so the guard for a scan that
    // found none stays quiet and the route's real parameters surface as ones the
    // mirror invented.
    expect(
      await scanParams(`
        export const DOCS: Record<string, Doc> = {
          'GET sizes': {
            query:
              [{ name: 'limit', description: 'x' }],
          },
        };
      `),
    ).toEqual(['query:limit']);
  });

  it('does not resolve a shared constant to a copy of it quoted in a comment', async () => {
    // Allowing an indent is what put the scan inside block comments, where a
    // superseded declaration is indented under its `*`. The quoted copy comes
    // last and wins the map, so every route citing the identifier reports one
    // missing parameter and one extra, both naming a name nobody serves.
    expect(
      await scanParams(`
        const PARTIAL: Query = { name: 'allow_partial', description: 'x' };
        /* Superseded, kept for the reader:
          const PARTIAL: Query = { name: 'stale_old_name', description: 'x' };
        */
        export const DOCS: Record<string, Doc> = {
          'GET sizes': { query: [PARTIAL] },
        };
      `),
    ).toEqual(['query:allow_partial']);
  });

  it('does not read a ternary’s consequent as a body field', async () => {
    // `flag ? 'a' : 'b'` is a string in front of a colon and names nothing. Read
    // as a key it becomes a body field the mirror is missing, and the operator
    // is told to add a parameter that does not exist.
    expect(
      await scanParams(`
        export const DOCS: Record<string, Doc> = {
          'GET sizes': { body: object({ name: str('x'), tag: flag ? 'a' : 'b' }) },
        };
      `),
    ).toEqual(['body:name', 'body:tag']);
  });

  it('finds the DOCS table itself outside the comments, not inside one', async () => {
    // Where the table STARTS is located in the stripped copy too. This file's
    // comments quote that declaration like every other shape in it, and a
    // commented copy carrying its own braces is parsed in place of the real
    // table: every route then reads as documenting nothing, and a comment
    // quoting a real entry would give the opposite — a false all-clear, which
    // is the failure this whole script exists not to give.
    expect(
      await scanParams(
        "/* export const DOCS: Record<string, Doc> = { 'GET sizes': { query: [{ name: 'ghost' }] } }; */\n" +
          "export const DOCS: Record<string, Doc> = { 'GET sizes': { query: [{ name: 'real' }] } };\n",
      ),
    ).toEqual(['query:real']);
  });

  it('does not read a second entry out of a comment quoting the shape of one', async () => {
    // The commented copy comes after the real entry on purpose: these land in a
    // Map by key, so a phantom in front of the real one is overwritten by it and
    // proves nothing. Only the one arriving second replaces a route's real
    // parameters with invented ones.
    expect(
      await scanParams(`
        export const DOCS: Record<string, Doc> = {
          'GET sizes': { query: [{ name: 'real' }] },
          // The shape, for reference: 'GET sizes': { query: [{ name: 'ghost' }] }
        };
      `),
    ).toEqual(['query:real']);
  });

  it('reads the entry’s own query list, not one nested in its prose', async () => {
    // The list is found at the entry's own depth. Taken by an `indexOf` or an
    // unanchored regex, the first `query: [` at any depth wins — so a response
    // example supplies the parameters, the route's real list further down is
    // never read, and a set the platform never documented is compared against
    // the mirror as if it had been.
    expect(
      await scanParams(`
        export const DOCS: Record<string, Doc> = {
          'GET sizes': {
            responses: { 200: { example: { query: [{ name: 'ghost' }] } } },
            query: [{ name: 'real' }],
          },
        };
      `),
    ).toEqual(['query:real']);
  });

  it('does not let a comment quoting a route key stand in for the route', async () => {
    // The entry key is captured by a regex, and apidoc.ts explains itself by
    // quoting the keys it documents. A comment read as an entry is an empty
    // parameter set that `table.set` puts where the real one belongs, and the
    // route is then compared against nothing.
    expect(
      await scanParams(`
        export const DOCS: Record<string, Doc> = {
          'GET sizes': { query: [{ name: 'limit', description: 'x' }] },
          // Superseded: 'GET sizes': { query: [] },
        };
      `),
    ).toEqual(['query:limit']);
  });

  it('reads a route whose entry writes pattern before method', async () => {
    // The lazy `/method:[\s\S]*?pattern:/` skipped this entry looking for a
    // `method:`, found the next one's, and paired it with the pattern after
    // that: `GET beta`, a route in neither table and so reported by neither.
    expect(
      await scanTable(`
        { role: 'viewer', pattern: 'alpha', method: 'GET' },
        { method: 'POST', pattern: 'beta' },
      `),
    ).toEqual(['GET alpha', 'POST beta']);
  });

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

  it('refuses a MANDALA_PLATFORM_REPO that does not hold the platform', async () => {
    // The variable is an assertion, and the machine that sets it is the one
    // machine where this gate is enforced — for three SDKs at once. Read as a
    // guess, a checkout that moved is indistinguishable from no platform at all:
    // three green no-ops over three mirrors nobody compared.
    const dir = fixture(null, null);
    try {
      const { said, code } = await runCheck(dir);
      expect(code).toBe(1);
      expect(said).toContain('does not hold web/lib/surface.ts');
      expect(said).not.toContain('skipping');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an identified checkout whose apidoc.ts has moved', async () => {
    // Detection asks for one marker so that a file which moved fails as a file
    // that moved. Asking for both took the ROUTE half down too, over a file the
    // route half never opens, and said "not checked out" about a repo that was.
    const dir = fixture('export const V1_ROUTES: Route[] = [];\n', null);
    try {
      const { said, code } = await runCheck(dir);
      expect(code).toBe(1);
      expect(said).toContain('missing web/lib/apidoc.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a relative MANDALA_PLATFORM_REPO against this repo', async () => {
    // Left raw, the same value named two different directories depending on
    // where npm was invoked from, while the two guesses beside it in the
    // diagnostic were absolute.
    const root = resolve(__dirname, '..');
    // Under the repo rather than in the temp directory, and named by a path with
    // no `..` in it: a relative path back out of the temp directory would have
    // enough of them to clamp at `/` and land on the same place from either
    // starting point, which is a value that cannot tell the two apart.
    const dir = fixture(
      `export const V1_ROUTES: Route[] = [{ method: 'GET', pattern: 'alpha' }];\n`,
      '',
      join(root, 'node_modules/.cache'),
    );
    try {
      const { said } = await runCheck(relative(root, dir), tmpdir());
      expect(said).toContain('+ GET alpha');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says so when the routes agreed and no parameter was compared', async () => {
    // The count in the success line is also the only evidence the parameter half
    // ran. Both sides empty is not a match, it is a comparison that did not
    // happen — the vacuous all-clear the route half is walked by hand to avoid.
    const dir = fixture(
      `export const V1_ROUTES: Route[] = [{ method: 'GET', pattern: 'templates' }];\n`,
    );
    try {
      const { said, code } = await runCheck(dir);
      expect(code).toBe(1);
      expect(said).toContain('compared zero parameters across 1 shared routes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
