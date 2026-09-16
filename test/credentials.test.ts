import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../src/api.js';
import {
  CredentialsError,
  canonicalizeBaseUrl,
  type LocalCredentialOptions,
  resolveCredentials,
} from '../src/credentials.js';

type Expected = {
  outcome: string;
  rule?: string;
  key?: string;
  base_url?: string;
  source?: string;
  profile?: string;
  credential_file_io?: string;
  value?: string;
};
type Patch = { op: string; path: string; value?: unknown };
type FileSpec = string | { base: string; patch: Patch[] };
type Vector = {
  id: string;
  expected: Expected;
  file?: FileSpec;
  input?: {
    options?: { api_key?: unknown; base_url?: unknown; profile?: unknown };
    env?: Record<string, string>;
    file?: FileSpec;
    platform?: string;
    home_discovery?: string;
  };
  bytes_utf8?: string;
  bytes_hex?: string;
  recipe?: {
    pad_json_trailing_ascii_spaces_to_bytes?: number;
    profile_count?: number;
    profile_template?: unknown;
    default_profile?: string;
  };
};
const fixtureBytes = fs.readFileSync(new URL('./fixtures/credentials-v1.json', import.meta.url));
const corpus = JSON.parse(fixtureBytes.toString()) as {
  base_document: {
    version: number;
    default_profile: string;
    profiles: Record<
      string,
      {
        api_key: string;
        base_url: string;
        key_id: string;
        account: { id: string; name: string | null };
        scope: unknown;
      }
    >;
  };
  resolution_cases: Vector[];
  schema_cases: Vector[];
  payload_cases: Vector[];
  canonical_base_cases: { id: string; input: string; expected: Expected }[];
  native_file_cases: {
    id: string;
    setup: string;
    expected: { result: string; completion_deadline_ms: number };
  }[];
};
let home: string;
let directory: string;
let filename: string;
let platform: PropertyDescriptor;
const originalPlatform = process.platform;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-credentials-'));
  directory = path.join(home, '.mandala');
  filename = path.join(directory, 'credentials.json');
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const key of ['MANDALA_API_KEY', 'MANDALA_PROFILE', 'MANDALA_BASE_URL'])
    vi.stubEnv(key, undefined);
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', platform);
  fs.rmSync(home, { recursive: true, force: true });
});

function document(spec: FileSpec = 'base'): unknown {
  const doc = structuredClone(corpus.base_document);
  if (typeof spec === 'object') {
    for (const patch of spec.patch) {
      const parts = patch.path
        .slice(1)
        .split('/')
        .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
      let target = doc as unknown as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) {
        expect(Object.hasOwn(target, part)).toBe(true);
        target = target[part] as Record<string, unknown>;
      }
      const key = parts[parts.length - 1];
      if (patch.op === 'remove') delete target[key];
      else
        Object.defineProperty(target, key, {
          value: patch.value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    }
  }
  return doc;
}
function save(spec: FileSpec = 'base'): void {
  if (spec === 'missing') return;
  fs.writeFileSync(filename, spec === 'malformed-json' ? '{' : JSON.stringify(document(spec)), {
    mode: 0o600,
  });
  if (spec === 'symlink-file') {
    fs.renameSync(filename, `${filename}.original`);
    fs.symlinkSync(`${filename}.original`, filename);
  }
}
function assertResult(run: () => ReturnType<typeof resolveCredentials>, expected: Expected): void {
  if (expected.outcome === 'credential') {
    const result = run();
    expect(result).toMatchObject({
      apiKey: expected.key,
      baseUrl: expected.base_url,
      source: expected.source,
    });
    expect(result.profile).toBe(expected.profile);
  } else {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialsError);
    expect((caught as CredentialsError).code).toBe(expected.rule);
    expect(String(caught)).not.toMatch(/com_public_fixture_|public_fixture_password/);
  }
}
function measuredHome(throwIfCalled = false) {
  return vi.spyOn(os, 'homedir').mockImplementation(() => {
    if (throwIfCalled) throw new Error('poison home accessed');
    return home;
  });
}

describe('portable credential corpus', () => {
  it('preserves the pinned common corpus bytes', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
      '6af4cb6dbc8479602c6c7e637772593cb1f27a638d1e1c1bef0f4475223da076',
    );
  });
  for (const vector of corpus.resolution_cases)
    it(vector.id, () => {
      const input = vector.input!;
      save(input.file);
      for (const [key, value] of Object.entries(input.env ?? {})) vi.stubEnv(key, value);
      if (input.platform === 'unsupported-file-protection')
        Object.defineProperty(process, 'platform', { value: 'win32' });
      const homeLookup = measuredHome(input.home_discovery === 'throw_if_called');
      const io = [
        vi.spyOn(fs, 'lstatSync'),
        vi.spyOn(fs, 'openSync'),
        vi.spyOn(fs, 'fstatSync'),
        vi.spyOn(fs, 'readSync'),
        vi.spyOn(JSON, 'parse'),
      ];
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
      const options = input.options ?? {};
      assertResult(
        () =>
          resolveCredentials({
            apiKey: options.api_key,
            baseUrl: options.base_url,
            profile: options.profile,
          } as LocalCredentialOptions),
        vector.expected,
      );
      expect(fetch).not.toHaveBeenCalled();
      if (vector.expected.credential_file_io === 'zero') {
        expect(homeLookup).not.toHaveBeenCalled();
        for (const spy of io) expect(spy).not.toHaveBeenCalled();
      } else expect(homeLookup).toHaveBeenCalledOnce();
    });
  for (const vector of corpus.schema_cases)
    it(vector.id, () => {
      save(vector.file);
      measuredHome();
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
      assertResult(() => resolveCredentials(), vector.expected);
      expect(fetch).not.toHaveBeenCalled();
    });
  for (const vector of corpus.payload_cases)
    it(vector.id, () => {
      let bytes: Buffer;
      if (vector.bytes_hex !== undefined) bytes = Buffer.from(vector.bytes_hex, 'hex');
      else if (vector.bytes_utf8 !== undefined) bytes = Buffer.from(vector.bytes_utf8, 'utf8');
      else if (vector.recipe?.profile_count) {
        const profiles = Object.fromEntries(
          Array.from({ length: vector.recipe.profile_count }, (_, i) => [
            `p${String(i).padStart(3, '0')}`,
            vector.recipe!.profile_template,
          ]),
        );
        bytes = Buffer.from(
          JSON.stringify({ version: 1, default_profile: vector.recipe.default_profile, profiles }),
        );
      } else {
        const raw = Buffer.from(JSON.stringify(corpus.base_document));
        bytes = Buffer.concat([
          raw,
          Buffer.alloc(vector.recipe!.pad_json_trailing_ascii_spaces_to_bytes! - raw.length, ' '),
        ]);
        expect(bytes.length).toBe(vector.recipe!.pad_json_trailing_ascii_spaces_to_bytes);
      }
      fs.writeFileSync(filename, bytes, { mode: 0o600 });
      measuredHome();
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP'));
      assertResult(() => resolveCredentials(), vector.expected);
      expect(fetch).not.toHaveBeenCalled();
    });
  for (const vector of corpus.canonical_base_cases)
    it(vector.id, async () => {
      if (vector.expected.outcome === 'local_error') {
        expect(() => canonicalizeBaseUrl(vector.input)).toThrow(CredentialsError);
        try {
          canonicalizeBaseUrl(vector.input);
        } catch (error) {
          expect((error as CredentialsError).code).toBe(vector.expected.rule);
        }
      } else {
        const base = canonicalizeBaseUrl(vector.input);
        expect(base).toBe(vector.expected.value);
        expect(canonicalizeBaseUrl(base)).toBe(base);
        const requests: string[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
          requests.push(String(input));
          return Response.json([]);
        });
        const api = new Api('fixture-only', base);
        await api.json('GET', '/computers');
        expect(requests).toEqual([`${base}/computers`]);
      }
    });
  it('distinguishes native null from absent undefined without store IO', () => {
    const lookup = measuredHome(true);
    for (const options of [{ apiKey: null }, { profile: null }])
      expect(() => resolveCredentials(options as unknown as LocalCredentialOptions)).toThrow(
        CredentialsError,
      );
    vi.stubEnv('MANDALA_API_KEY', 'fixture-only');
    expect(
      resolveCredentials({ apiKey: undefined, profile: null } as unknown as LocalCredentialOptions)
        .apiKey,
    ).toBe('fixture-only');
    expect(lookup).not.toHaveBeenCalled();
  });
  it('keeps explicit-key empty base and legacy URL behavior separate', () => {
    vi.stubEnv('MANDALA_BASE_URL', 'https://environment.test/api/v1');
    expect(resolveCredentials({ apiKey: 'fixture-only', baseUrl: '' }).baseUrl).toBe(
      'https://app.mandala.computer/api/v1',
    );
    expect(
      resolveCredentials({ apiKey: 'fixture-only', baseUrl: 'http://legacy.test/api/v1?x=1' })
        .baseUrl,
    ).toBe('http://legacy.test/api/v1?x=1');
  });
});

describe('native credential corpus', () => {
  it('F13-file-ABA-between-validation-and-open', () => {
    save();
    measuredHome();
    const replacement = structuredClone(corpus.base_document);
    replacement.default_profile = 'Work';
    fs.writeFileSync(`${filename}.next`, JSON.stringify(replacement), { mode: 0o600 });
    const originalOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (String(args[0]) !== filename) return originalOpen(...args);
      // Restore the original pathname before the post-check. A directory-only
      // identity check would miss that the opened file is the replacement.
      fs.renameSync(filename, `${filename}.original`);
      fs.renameSync(`${filename}.next`, filename);
      const fd = originalOpen(...args);
      fs.renameSync(filename, `${filename}.replacement`);
      fs.renameSync(`${filename}.original`, filename);
      return fd;
    });
    expect(() => resolveCredentials()).toThrow(CredentialsError);
  });
  for (const vector of corpus.native_file_cases)
    it(vector.id, async (context) => {
      if (originalPlatform === 'win32') return context.skip();
      save();
      measuredHome();
      let socket: net.Server | undefined;
      let restoreOwner: (() => void) | undefined;
      const setup = vector.setup;
      if (setup.includes('other-owner')) {
        // These cases need the coordinator's privileged native run. Never fake ownership.
        if (process.getuid?.() !== 0) return context.skip();
        const target = setup === 'file-other-owner' ? filename : directory;
        fs.chownSync(target, 65534, process.getgid!());
        restoreOwner = () => fs.chownSync(target, process.getuid!(), process.getgid!());
      } else if (setup === 'file-mode-0644') fs.chmodSync(filename, 0o644);
      else if (setup === 'directory-mode-0755') fs.chmodSync(directory, 0o755);
      else if (setup === 'file-mode-0400') fs.chmodSync(filename, 0o400);
      else if (setup === 'directory-mode-0500') fs.chmodSync(directory, 0o500);
      else if (setup === 'file-symlink-to-valid') {
        fs.renameSync(filename, `${filename}.original`);
        fs.symlinkSync(`${filename}.original`, filename);
      } else if (setup === 'directory-symlink-to-valid') {
        fs.renameSync(directory, `${directory}.original`);
        fs.symlinkSync(`${directory}.original`, directory);
      } else if (setup === 'file-link-count-2') fs.linkSync(filename, `${filename}.link`);
      else if (setup === 'named-pipe-with-no-writer') {
        fs.unlinkSync(filename);
        execFileSync('mkfifo', ['-m', '600', filename]);
      } else if (setup === 'directory-at-file-path') {
        fs.unlinkSync(filename);
        fs.mkdirSync(filename, { mode: 0o600 });
      } else if (setup === 'socket-at-file-path') {
        fs.unlinkSync(filename);
        socket = net.createServer();
        await new Promise<void>((resolve, reject) =>
          socket!.once('error', reject).listen(filename, resolve),
        );
      } else if (setup === 'grow-file-past-65536-after-fstat') {
        const fstat = fs.fstatSync;
        let grown = false;
        vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
          const stat = fstat(fd);
          if (stat.isFile() && !grown) {
            grown = true;
            fs.appendFileSync(filename, Buffer.alloc(65_537));
          }
          return stat;
        }) as typeof fs.fstatSync);
      } else if (setup === 'replace-file-after-open-with-other-profile') {
        const open = fs.openSync;
        vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
          const fd = open(...args);
          if (String(args[0]) === filename) {
            const replacement = structuredClone(corpus.base_document);
            replacement.default_profile = 'Work';
            fs.writeFileSync(`${filename}.next`, JSON.stringify(replacement), { mode: 0o600 });
            fs.renameSync(`${filename}.next`, filename);
          }
          return fd;
        });
      } else if (setup === 'replace-directory-after-validation-before-open') {
        const open = fs.openSync;
        vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
          if (String(args[0]) === directory) {
            fs.renameSync(directory, `${directory}.original`);
            fs.mkdirSync(directory, { mode: 0o700 });
            const replacement = structuredClone(corpus.base_document);
            replacement.default_profile = 'Work';
            fs.writeFileSync(filename, JSON.stringify(replacement), { mode: 0o600 });
          }
          return open(...args);
        });
      }
      const started = performance.now();
      try {
        let result: ReturnType<typeof resolveCredentials> | undefined;
        let error: unknown;
        try {
          result = resolveCredentials();
        } catch (caught) {
          error = caught;
        }
        expect(performance.now() - started).toBeLessThan(vector.expected.completion_deadline_ms);
        if (vector.expected.result === 'credential')
          expect(result).toMatchObject({
            apiKey: corpus.base_document.profiles.default.api_key,
            baseUrl: corpus.base_document.profiles.default.base_url,
          });
        else if (vector.expected.result.startsWith('validated_')) {
          if (result)
            expect(result).toMatchObject({
              apiKey: corpus.base_document.profiles.default.api_key,
              baseUrl: corpus.base_document.profiles.default.base_url,
              profile: 'default',
            });
          else expect(error).toBeInstanceOf(CredentialsError);
        } else expect(error).toMatchObject({ code: vector.expected.result });
        if (error) expect(String(error)).not.toContain('com_public_fixture_');
      } finally {
        restoreOwner?.();
        if (socket) await new Promise<void>((resolve) => socket!.close(() => resolve()));
        // Let recursive fixture cleanup traverse the intentionally unreadable modes.
        if (!fs.lstatSync(directory).isSymbolicLink()) fs.chmodSync(directory, 0o700);
      }
    }, 5000);
});
