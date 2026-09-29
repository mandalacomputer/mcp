import { afterEach, expect, it, vi } from 'vitest';
import { main, maxSessionsPerAccount, maxSessionsPerToken } from '../src/cli.js';
import * as hosted from '../src/http.js';

// OPL-5449: the per-token session cap had no knob, so a self-hosted `--http`
// server (and the hosted deploy, which runs this CLI) could not raise the 16,
// and a 17th agent on one key evicted another's session.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('reads a whole number from 1 to the session pool', () => {
  expect(maxSessionsPerToken('40')).toBe(40);
  expect(maxSessionsPerToken(' 1 ')).toBe(1);
  expect(maxSessionsPerToken(String(hosted.DEFAULT_MAX_SESSIONS))).toBe(
    hosted.DEFAULT_MAX_SESSIONS,
  );
});

it('leaves an unset or empty variable to the default', () => {
  expect(maxSessionsPerToken(undefined)).toBeUndefined();
  expect(maxSessionsPerToken('')).toBeUndefined();
  expect(maxSessionsPerToken('   ')).toBeUndefined();
});

it('refuses anything else at startup, naming the variable', () => {
  for (const bad of [
    '0',
    '-3',
    '1.5',
    '1e3',
    '0x10',
    'sixteen',
    'Infinity',
    String(hosted.DEFAULT_MAX_SESSIONS + 1),
  ]) {
    expect(() => maxSessionsPerToken(bad), bad).toThrow(
      /MANDALA_MCP_MAX_SESSIONS_PER_TOKEN=.* is not a session count/,
    );
  }
});

it('passes the variable to the HTTP server, and nothing when it is unset', async () => {
  const seen: Array<Parameters<typeof hosted.runHttp>[0]> = [];
  vi.spyOn(hosted, 'runHttp').mockImplementation(async (cfg) => {
    seen.push(cfg);
    return undefined as never;
  });
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_TOKEN', '40');
  await main(['--http', '--port', '0']);
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_TOKEN', undefined);
  await main(['--http', '--port', '0']);
  expect(seen.map((cfg) => cfg.maxSessionsPerBearer)).toEqual([40, undefined]);
});

it('never starts the HTTP server on a value it refuses', async () => {
  const run = vi.spyOn(hosted, 'runHttp').mockImplementation(async () => undefined as never);
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_TOKEN', '16x');
  await expect(main(['--http', '--port', '0'])).rejects.toThrow(
    'MANDALA_MCP_MAX_SESSIONS_PER_TOKEN=16x is not a session count',
  );
  expect(run).not.toHaveBeenCalled();
});

// OPL-5447: the account ceiling's knob, read exactly as the per-token one.
it('reads MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT by the same rules', () => {
  expect(maxSessionsPerAccount('40')).toBe(40);
  expect(maxSessionsPerAccount(String(hosted.DEFAULT_MAX_SESSIONS))).toBe(
    hosted.DEFAULT_MAX_SESSIONS,
  );
  expect(maxSessionsPerAccount(undefined)).toBeUndefined();
  expect(maxSessionsPerAccount('  ')).toBeUndefined();
  for (const bad of ['0', '1.5', '1e3', 'half', String(hosted.DEFAULT_MAX_SESSIONS + 1)]) {
    expect(() => maxSessionsPerAccount(bad), bad).toThrow(
      /MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT=.* is not a session count/,
    );
  }
});

it('passes the account ceiling to the HTTP server, and refuses a bad one before starting it', async () => {
  const seen: Array<Parameters<typeof hosted.runHttp>[0]> = [];
  const run = vi.spyOn(hosted, 'runHttp').mockImplementation(async (cfg) => {
    seen.push(cfg);
    return undefined as never;
  });
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT', '64');
  await main(['--http', '--port', '0']);
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT', undefined);
  await main(['--http', '--port', '0']);
  expect(seen.map((cfg) => cfg.maxSessionsPerAccount)).toEqual([64, undefined]);

  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT', '300');
  await expect(main(['--http', '--port', '0'])).rejects.toThrow(
    'MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT=300 is not a session count',
  );
  expect(run).toHaveBeenCalledTimes(2);
});
