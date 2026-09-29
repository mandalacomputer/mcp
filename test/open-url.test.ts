import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as P from '../src/paths.js';
import { connect, installFakePlatform } from './harness.js';

/**
 * OPL-5437 / OPL-3705: open_url named `firefox` and backgrounded it, so the
 * launch exited 0 whatever happened, including on Omarchy, which ships
 * chromium alone. The command is run here for real, in a shell whose PATH holds only
 * the browsers a test puts there.
 */
describe('the open_url command', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A PATH holding `nohup` and a fake of each named browser that records its
   * argv. The record is written to a temporary name and renamed into place, so
   * `opened` never exists half-written: the shell's `>` creates the file
   * before printf fills it, and a poll that saw it in that window read ''.
   */
  function guest(browsers: string[]): { bin: string; opened: string } {
    const bin = mkdtempSync(join(tmpdir(), 'open-url-'));
    dirs.push(bin);
    const opened = join(bin, 'opened');
    symlinkSync('/usr/bin/nohup', join(bin, 'nohup'));
    for (const name of browsers) {
      const path = join(bin, name);
      writeFileSync(
        path,
        `#!/bin/sh\nprintf '%s %s' "${name}" "$1" > '${opened}.tmp' && /bin/mv '${opened}.tmp' '${opened}'\n`,
      );
      chmodSync(path, 0o755);
    }
    return { bin, opened };
  }

  function run(bin: string, url: string) {
    return spawnSync('/bin/sh', ['-c', P.openUrlCommand(url)], {
      env: { PATH: bin },
      encoding: 'utf8',
    });
  }

  async function launched(opened: string): Promise<string> {
    for (let i = 0; i < 100 && !existsSync(opened); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return readFileSync(opened, 'utf8');
  }

  it.each([
    [['firefox-esr', 'chromium'], 'firefox-esr'],
    [['firefox', 'chromium'], 'firefox'],
    [['chromium'], 'chromium'],
  ])('with %j installed opens %s', async (browsers, expected) => {
    const { bin, opened } = guest(browsers);
    const url = "https://example.com/a b?q='x'";
    const res = run(bin, url);
    expect(res.status).toBe(0);
    expect(await launched(opened)).toBe(`${expected} ${url}`);
  });

  it('exits 127 and says so when the image has none of them', () => {
    const { bin, opened } = guest([]);
    const res = run(bin, 'https://example.com');
    expect(res.status).toBe(127);
    expect(res.stderr.trim()).toBe(P.NO_BROWSER);
    expect(existsSync(opened)).toBe(false);
  });

  it('still refuses a leading dash', () => {
    expect(() => P.openUrlCommand('-https://example.com')).toThrow(/must not start with '-'/);
  });
});

describe('the open_url tool', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  afterEach(() => platform.restore());

  function execAnswers(value: Record<string, unknown>) {
    platform = installFakePlatform();
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const res = await previous(input as never, init);
      if (String(input).endsWith('/exec')) {
        return new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return res;
    };
  }

  it('reports an image with no browser as an error, not as opened', async () => {
    execAnswers({
      exit_code: 127,
      stdout_b64: '',
      stderr_b64: Buffer.from(`${P.NO_BROWSER}\n`).toString('base64'),
    });
    const { call, close } = await connect();
    const res = await call('open_url', { url: 'https://example.com' });
    await close();
    const text = JSON.stringify(res.content);
    expect(res.isError).toBe(true);
    expect(text).toContain('Could not open https://example.com');
    expect(text).toContain(P.NO_BROWSER);
    expect(text).not.toContain('Asked the desktop to open');
    const exec = platform.calls.find((c) => c.path.endsWith('/exec'));
    expect(String((exec?.body as { command?: unknown } | undefined)?.command)).toContain(
      'command -v firefox-esr',
    );
  });

  it('reports a launch that exited 0 as asked for', async () => {
    execAnswers({ exit_code: 0, stdout_b64: '', stderr_b64: '' });
    const { call, close } = await connect();
    const res = await call('open_url', { url: 'https://example.com' });
    await close();
    expect(res.isError).not.toBe(true);
    expect(JSON.stringify(res.content)).toContain('Asked the desktop to open https://example.com');
  });
});
