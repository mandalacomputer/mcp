/**
 * The gate that keeps the platform's internals out of this public repo.
 *
 * Its sibling `check-surface.mjs` has had tests since it was written and this
 * one shipped without any — which is how its first cut came to certify the repo
 * clean while a bare Go filename was still going out in `dist/` (/code-review).
 * By its own argument, an unchecked mirror is a comment.
 *
 * What these pin is the SHAPE of what it catches, not a list of what it caught:
 * a scanner that matches only the spellings of the last scrub is the snapshot
 * the hashed, platform-derived name list exists to replace.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scanText } from '../scripts/check-internals.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/check-internals.mjs', import.meta.url));
const DIGESTS = fileURLToPath(new URL('../scripts/internal-names.sha256', import.meta.url));

const digestsFor = (...names: string[]) =>
  new Set(names.map((n) => createHash('sha256').update(n).digest('hex').slice(0, 12)));

const runScript = (script: string, ...args: string[]) => {
  try {
    return {
      status: 0,
      out: execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

const run = (...args: string[]) => runScript(SCRIPT, ...args);

const makeCliFixture = (checkoutName: string, source: string) => {
  const root = join(mkdtempSync(join(tmpdir(), 'check-internals-')), checkoutName);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src'));
  copyFileSync(SCRIPT, join(root, 'scripts', 'check-internals.mjs'));
  copyFileSync(DIGESTS, join(root, 'scripts', 'internal-names.sha256'));
  writeFileSync(join(root, 'src', 'fixture.ts'), source);
  return join(root, 'scripts', 'check-internals.mjs');
};

describe('check-internals', () => {
  it('passes over this repository, which is the check the rest only stand in for', () => {
    expect(run().status).toBe(0);
  });

  it.each([
    '// see the ordering in vm.go',
    '// the switch in fileevents.go decides', // no `server/` prefix — the miss that shipped
    '// server/pkg/nested/thing.go',
    '// webhookSign.go', // capitals
    '// api_v2.go', // digits and underscores
  ])('catches a Go filename however it is spelled: %s', (line) => {
    // This client has no Go, so any .go in it names somebody else's file.
    expect(scanText(line, 'f.ts', new Set())).not.toHaveLength(0);
  });

  it.each([
    '// lib/apidoc says otherwise',
    '// web/lib/projection.ts sets it',
    '// lib/hvproxy forwards the header',
  ])('catches a platform module with or without its extension: %s', (line) => {
    expect(scanText(line, 'f.ts', new Set())).not.toHaveLength(0);
  });

  it('reports an identifier by name even though the list only holds its hash', () => {
    // The point of hashing: the list is not a map, but the message can still
    // name the token, because the token is already in the file being read.
    const found = scanText('// mirrored from snapCtxWidget', 'f.ts', digestsFor('snapCtxWidget'));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('snapCtxWidget');
  });

  it('never fires on short words, which are every client’s own vocabulary', () => {
    expect(
      scanText('// status list start', 'f.ts', digestsFor('status', 'list', 'start')),
    ).toHaveLength(0);
  });

  it('leaves ordinary prose about platform behaviour alone', () => {
    // The comments this repo is FOR. A scanner that eats these is worse than
    // none: it teaches the next author to say less about behaviour.
    const prose = [
      '// A start that has been admitted holds its memory before its process',
      '// exists, so the machine reads as stopped for the whole of that load.',
    ].join('\n');
    expect(scanText(prose, 'f.ts', new Set())).toHaveLength(0);
  });

  it('reports a path that answers to two rules once, not twice', () => {
    expect(scanText('// server/vm.go', 'f.ts', new Set())).toHaveLength(1);
  });

  it('explains an unreadable range instead of throwing a stack trace at it', () => {
    // A stack trace reads as the tool being broken, which is how a CI step gets
    // deleted. The likely cause is a shallow clone, so it says so.
    const { status, out } = run('--messages', 'nosuchref..HEAD');
    expect(status).toBe(2);
    expect(out).not.toContain('at Object');
    expect(out).toContain('fetch-depth');
  });

  it.each([['--messages'], ['--messages=']])(
    'refuses %s with no range rather than scanning nothing and passing',
    (flag) => {
      const { status, out } = run(flag);
      expect(status).toBe(2);
      expect(out).toContain('revision range');
    },
  );

  describe.each(['space checkout', 'reserved # % ? checkout'])(
    'when the checkout path contains encoded characters: %s',
    (checkoutName) => {
      it('runs the real scanner and rejects prohibited content', () => {
        const script = makeCliFixture(checkoutName, '// see the rules in engine.go\n');
        const { status, out } = runScript(script);
        expect(status).toBe(1);
        expect(out).toContain('src/fixture.ts:1: names a platform source file: engine.go');
      });

      it('runs the real scanner and prints success for clean content', () => {
        const script = makeCliFixture(checkoutName, 'export const answer = 42;\n');
        const { status, out } = runScript(script);
        expect(status).toBe(0);
        expect(out).toContain('nothing of the platform');
      });

      it('still reports malformed CLI arguments', () => {
        const script = makeCliFixture(checkoutName, 'export const answer = 42;\n');
        const { status, out } = runScript(script, '--messages');
        expect(status).toBe(2);
        expect(out).toContain('revision range');
      });
    },
  );

  it.each(['absent', 'missing'] as const)(
    'is side-effect free when imported with an %s argv entry path',
    (entryPath) => {
      const script = makeCliFixture('import # % ? checkout', '// see the rules in engine.go\n');
      const href = pathToFileURL(script).href;
      const setEntryPath =
        entryPath === 'absent'
          ? 'process.argv.splice(1);'
          : `process.argv[1] = ${JSON.stringify(`${script}.missing`)};`;
      const out = execFileSync(
        'node',
        ['--input-type=module', '--eval', `${setEntryPath} await import(${JSON.stringify(href)});`],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      expect(out).toBe('');
    },
  );

  it('reads every commit in a range, not just one end of it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ci-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a'), '1');
    git('add', '.');
    git('commit', '-qm', 'first, and clean');
    writeFileSync(join(repo, 'a'), '2');
    git('commit', '-qam', 'second: see server/vm.go');
    const log = execFileSync('git', ['log', '--format=%H%x00%B%x00', 'HEAD~1..HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    });
    const chunks = log.split('\0');
    const found: string[] = [];
    for (let i = 0; i + 1 < chunks.length; i += 2) {
      if (chunks[i]?.trim()) found.push(...scanText(chunks[i + 1] ?? '', 'commit', new Set()));
    }
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('vm.go');
  });
});
