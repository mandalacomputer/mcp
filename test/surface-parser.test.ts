import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { topLevelField } from '../scripts/surface-text.mjs';

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
  const scanTable = (table: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'surface-fixture-'));
    mkdirSync(join(dir, 'web/lib'), { recursive: true });
    writeFileSync(
      join(dir, 'web/lib/surface.ts'),
      `export const V1_ROUTES: Route[] = [${table}];\n`,
    );
    writeFileSync(join(dir, 'web/lib/apidoc.ts'), 'export const DOCS: Record<string, Doc> = {};\n');
    try {
      // Exits 1: a fixture table matches none of the real mirror. The `+` lines
      // are the routes it read out of the fixture, which is the subject here.
      const run = spawnSync(process.execPath, ['scripts/check-surface.mjs'], {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, MANDALA_PLATFORM_REPO: dir },
        encoding: 'utf8',
      });
      const said = `${run.stdout}${run.stderr}`;
      return [...said.matchAll(/^ {2}\+ ([A-Z]+ \S+)$/gm)].map((m) => m[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('does not let a nested literal lend its pattern to the entry above', () => {
    // The regex inside the sliced entry took the first `pattern:` at any depth,
    // so this read as `GET not-a-route` — in neither table, and so reported by
    // neither, while `GET gamma` went missing from upstream.
    expect(
      scanTable(`
        { method: 'GET', handler: { fallback: { pattern: 'not-a-route' } }, pattern: 'gamma' },
      `),
    ).toEqual(['GET gamma']);
  });

  it('reads a route whose entry writes pattern before method', () => {
    expect(
      scanTable(`
        { role: 'viewer', pattern: 'alpha', method: 'GET' },
        { method: 'POST', pattern: 'beta' },
      `),
    ).toEqual(['GET alpha', 'POST beta']);
  });

  it('ignores an entry that carries only half of the pair', () => {
    expect(scanTable(`{ pattern: 'orphan' }, { method: 'PUT', pattern: 'delta' },`)).toEqual([
      'PUT delta',
    ]);
  });
});
