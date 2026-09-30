import { afterEach, expect, it, vi } from 'vitest';
import {
  main,
  maxSessionsPerAccount,
  maxSessionsPerToken,
  maxSessionsPerWorkspace,
} from '../src/cli.js';
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

// OPL-5447: the per-account ceiling's variable, read by the same rules.
it('reads the per-account variable by the same rules, naming it', () => {
  expect(maxSessionsPerAccount('40')).toBe(40);
  expect(maxSessionsPerAccount(String(hosted.DEFAULT_MAX_SESSIONS))).toBe(
    hosted.DEFAULT_MAX_SESSIONS,
  );
  expect(maxSessionsPerAccount(undefined)).toBeUndefined();
  expect(maxSessionsPerAccount('  ')).toBeUndefined();
  for (const bad of ['0', '-1', '2.5', '1e2', 'many', String(hosted.DEFAULT_MAX_SESSIONS + 1)]) {
    expect(() => maxSessionsPerAccount(bad), bad).toThrow(
      `MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT=${bad} is not a session count. Use a whole number from 1 to ${hosted.DEFAULT_MAX_SESSIONS}, or leave it unset for ${hosted.DEFAULT_MAX_SESSIONS / 4}.`,
    );
  }
});

it('passes the per-account variable to the HTTP server, and nothing when it is unset', async () => {
  const seen: Array<Parameters<typeof hosted.runHttp>[0]> = [];
  vi.spyOn(hosted, 'runHttp').mockImplementation(async (cfg) => {
    seen.push(cfg);
    return undefined as never;
  });
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT', '64');
  await main(['--http', '--port', '0']);
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT', undefined);
  await main(['--http', '--port', '0']);
  expect(seen.map((cfg) => cfg.maxSessionsPerAccount)).toEqual([64, undefined]);
});

it('never starts the HTTP server on a per-account value it refuses', async () => {
  const run = vi.spyOn(hosted, 'runHttp').mockImplementation(async () => undefined as never);
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT', '0');
  await expect(main(['--http', '--port', '0'])).rejects.toThrow(
    'MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT=0 is not a session count',
  );
  expect(run).not.toHaveBeenCalled();
});

// OPL-5453: the per-workspace sub-ceiling's variable, read by the same rules.
it('reads the per-workspace variable by the same rules, naming it', () => {
  expect(maxSessionsPerWorkspace('4')).toBe(4);
  expect(maxSessionsPerWorkspace(String(hosted.DEFAULT_MAX_SESSIONS))).toBe(
    hosted.DEFAULT_MAX_SESSIONS,
  );
  expect(maxSessionsPerWorkspace(undefined)).toBeUndefined();
  expect(maxSessionsPerWorkspace('  ')).toBeUndefined();
  for (const bad of ['0', '-1', '2.5', '1e2', 'many', String(hosted.DEFAULT_MAX_SESSIONS + 1)]) {
    expect(() => maxSessionsPerWorkspace(bad), bad).toThrow(
      `MANDALA_MCP_MAX_SESSIONS_PER_WORKSPACE=${bad} is not a session count. Use a whole number from 1 to ${hosted.DEFAULT_MAX_SESSIONS}, or leave it unset for a quarter of the per-account maximum.`,
    );
  }
});

it('passes the per-workspace variable to the HTTP server, and nothing when it is unset', async () => {
  const seen: Array<Parameters<typeof hosted.runHttp>[0]> = [];
  vi.spyOn(hosted, 'runHttp').mockImplementation(async (cfg) => {
    seen.push(cfg);
    return undefined as never;
  });
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_WORKSPACE', '8');
  await main(['--http', '--port', '0']);
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_WORKSPACE', undefined);
  await main(['--http', '--port', '0']);
  expect(seen.map((cfg) => cfg.maxSessionsPerWorkspace)).toEqual([8, undefined]);
});

it('never starts the HTTP server on a per-workspace value it refuses', async () => {
  const run = vi.spyOn(hosted, 'runHttp').mockImplementation(async () => undefined as never);
  vi.stubEnv('MANDALA_MCP_MAX_SESSIONS_PER_WORKSPACE', '300');
  await expect(main(['--http', '--port', '0'])).rejects.toThrow(
    'MANDALA_MCP_MAX_SESSIONS_PER_WORKSPACE=300 is not a session count',
  );
  expect(run).not.toHaveBeenCalled();
});
