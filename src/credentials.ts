import fs from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BASE_URL } from './api.js';

const MAX_BYTES = 65_536;
const RESERVED = new Set([
  '__proto__',
  'prototype',
  'constructor',
  '__defineGetter__',
  '__defineSetter__',
  'hasOwnProperty',
  '__lookupGetter__',
  '__lookupSetter__',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);
function credentialWhitespace(code: number): boolean {
  return (
    (code >= 9 && code <= 13) ||
    code === 32 ||
    code === 133 ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  );
}

/** Fixed credential whitespace, shared with the other local clients. */
export function trimCredentialWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && credentialWhitespace(value.charCodeAt(start))) start++;
  while (end > start && credentialWhitespace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

/** Local diagnostics never include file contents, keys, paths or supplied values. */
export class CredentialsError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${detail} Run mandala login with the TypeScript CLI, or set MANDALA_API_KEY.`);
    this.name = 'CredentialsError';
  }
}

function fail(code: string, detail = 'Invalid saved credentials.'): never {
  throw new CredentialsError(code, detail);
}

function profileName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    !/[A-Za-z0-9]/.test(value[0]) ||
    /[^A-Za-z0-9._-]/.test(value) ||
    RESERVED.has(value)
  ) {
    fail(
      'invalid_profile',
      'Invalid profile name; use 1–64 ASCII letters, digits, dots, underscores or hyphens.',
    );
  }
}

/** Strict file-bound URL syntax; explicit-key transport behavior is separate. */
export function canonicalizeBaseUrl(value: unknown): string {
  const bad = (): never => fail('invalid_base_url', 'Invalid saved-credential base URL.');
  if (typeof value !== 'string') return bad();
  const raw = trimCredentialWhitespace(value);
  if (!raw || raw.length > 2048 || /[^\x21-\x7e]|[\\%?#]/.test(raw)) return bad();
  const schemeMatch = /^(https?):\/\//i.exec(raw);
  if (!schemeMatch) return bad();
  const scheme = schemeMatch[1].toLowerCase();
  const rest = raw.slice(schemeMatch[0].length);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const pathname = slash < 0 ? '' : rest.slice(slash);
  if (!authority || authority.includes('@')) return bad();
  let host: string;
  let port: string | undefined;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return bad();
    const address = authority.slice(1, close);
    if (isIP(address) !== 6) return bad();
    const suffix = authority.slice(close + 1);
    if (suffix && !suffix.startsWith(':')) return bad();
    port = suffix ? suffix.slice(1) : undefined;
    // Only IPv6 reaches the URL parser, after strict address validation. It
    // serializes the first longest zero run and any dotted IPv4 tail.
    host = new URL(`https://[${address}]`).hostname;
  } else {
    const parts = authority.split(':');
    if (parts.length > 2) return bad();
    host = parts[0].toLowerCase();
    port = parts[1];
    if (!host || host.length > 253) return bad();
    const labels = host.split('.');
    if (
      labels.some(
        (label) =>
          !label ||
          label.length > 63 ||
          /[^a-z0-9-]/.test(label) ||
          !/[a-z0-9]/.test(label[0]) ||
          !/[a-z0-9]/.test(label[label.length - 1]),
      )
    )
      return bad();
    const last = labels[labels.length - 1];
    if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(last) && isIP(host) !== 4) return bad();
  }
  let portSuffix = '';
  if (port !== undefined) {
    if (!port || /[^0-9]/.test(port)) return bad();
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return bad();
    if (!(scheme === 'https' && n === 443) && !(scheme === 'http' && n === 80))
      portSuffix = `:${n}`;
  }
  if (
    scheme === 'http' &&
    host !== 'localhost' &&
    host !== '[::1]' &&
    !(isIP(host) === 4 && host.startsWith('127.'))
  )
    return bad();
  if (
    /[^A-Za-z0-9\-._~!$&'()*+,;=:@/]/.test(pathname) ||
    pathname.split('/').some((part) => part === '.' || part === '..')
  )
    return bad();
  return `${scheme}://${host}${portSuffix}${pathname.replace(/\/+$/, '')}`;
}

type Obj = Record<string, unknown>;
function object(value: unknown): asserts value is Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_schema');
}
function closed(value: unknown, keys: string[]): asserts value is Obj {
  object(value);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    fail('invalid_schema');
}
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length) fail('invalid_schema');
}
function stringsWellFormed(value: unknown): void {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      for (let i = 0; i < current.length; i++) {
        const code = current.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = current.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) fail('invalid_schema');
        } else if (code >= 0xdc00 && code <= 0xdfff) fail('invalid_schema');
      }
    } else if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) pending.push(key, child);
    }
  }
}

type Entry = { api_key: string; base_url: string };
type Document = { default_profile: string; profiles: Record<string, Entry> };

export function parseCredentials(bytes: Uint8Array): Document {
  if (bytes.byteLength > MAX_BYTES)
    fail('file_too_large', 'Saved credentials exceed 65,536 bytes.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('invalid_utf8', 'Saved credentials must be valid UTF-8.');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return fail('invalid_json', 'Saved credentials are not valid JSON.');
  }
  stringsWellFormed(doc);
  object(doc);
  if (
    typeof doc.version !== 'number' ||
    !Number.isFinite(doc.version) ||
    !Number.isInteger(doc.version)
  )
    fail('invalid_schema');
  if (doc.version !== 1) fail('unsupported_version', 'Unsupported saved-credentials version.');
  if (!Object.hasOwn(doc, 'default_profile'))
    fail('missing_default_profile', 'Saved credentials have no default profile.');
  closed(doc, ['version', 'default_profile', 'profiles']);
  if (typeof doc.default_profile !== 'string') fail('invalid_schema');
  profileName(doc.default_profile);
  object(doc.profiles);
  const names = Object.keys(doc.profiles);
  if (!names.length) fail('invalid_schema');
  if (names.length > 100)
    fail('too_many_profiles', 'Saved credentials contain more than 100 profiles.');
  for (const name of names) {
    profileName(name);
    const entry = doc.profiles[name];
    closed(entry, ['api_key', 'base_url', 'key_id', 'account', 'scope']);
    nonempty(entry.api_key);
    if (!trimCredentialWhitespace(entry.api_key)) fail('invalid_schema');
    if (canonicalizeBaseUrl(entry.base_url) !== entry.base_url)
      fail('invalid_base_url', 'Stored base URLs must be canonical.');
    nonempty(entry.key_id);
    closed(entry.account, ['id', 'name']);
    nonempty(entry.account.id);
    if (entry.account.name !== null && typeof entry.account.name !== 'string')
      fail('invalid_schema');
    object(entry.scope);
    if (entry.scope.type === 'account') closed(entry.scope, ['type']);
    else if (entry.scope.type === 'workspace') {
      closed(entry.scope, ['type', 'workspace_id', 'workspace_name']);
      nonempty(entry.scope.workspace_id);
      nonempty(entry.scope.workspace_name);
    } else fail('invalid_schema');
  }
  if (!Object.hasOwn(doc.profiles, doc.default_profile))
    fail('missing_default_profile', 'The saved default profile is missing.');
  return doc as Document;
}

const sameObject = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;

/**
 * Opened descriptors are checked against pre/post named directory AND file
 * identities. Node has no portable openat: these checks reject observed
 * substitutions rather than claiming an atomic directory-relative open.
 */
function readStore(): Uint8Array {
  if (
    process.platform === 'win32' ||
    typeof process.getuid !== 'function' ||
    !fs.constants.O_NOFOLLOW ||
    !fs.constants.O_DIRECTORY
  ) {
    fail(
      'unsupported_file_protection',
      'Saved credentials require verified POSIX file protection.',
    );
  }
  const deadline = performance.now() + 5000;
  const checkTime = () => {
    if (performance.now() >= deadline)
      fail('credential_read_timeout', 'Reading saved credentials timed out.');
  };
  const uid = process.getuid();
  const checkDir = (st: fs.Stats) => {
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o7777) !== 0o700)
      fail('unsafe_directory', 'The credentials directory must be owned by you with mode 0700.');
  };
  const checkFile = (st: fs.Stats) => {
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o7777) !== 0o600 || st.nlink !== 1)
      fail(
        'unsafe_file',
        'The credentials file must be a private, owned regular file with mode 0600 and one link.',
      );
    if (st.size > MAX_BYTES) fail('file_too_large', 'Saved credentials exceed 65,536 bytes.');
  };
  let dirFd: number | undefined;
  let fileFd: number | undefined;
  try {
    const home = os.homedir();
    if (!home || !path.isAbsolute(home))
      fail('missing_credentials', 'Cannot discover your home directory.');
    const directory = path.join(home, '.mandala');
    const filename = path.join(directory, 'credentials.json');
    const namedDir = fs.lstatSync(directory);
    checkDir(namedDir);
    dirFd = fs.openSync(
      directory,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
    );
    const openedDir = fs.fstatSync(dirFd);
    checkDir(openedDir);
    if (!sameObject(namedDir, openedDir)) fail('unsafe_directory');
    const namedFile = fs.lstatSync(filename);
    checkFile(namedFile);
    const beforeDir = fs.lstatSync(directory);
    checkDir(beforeDir);
    if (!sameObject(openedDir, beforeDir)) fail('unsafe_directory');
    checkTime();
    fileFd = fs.openSync(
      filename,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const openedFile = fs.fstatSync(fileFd);
    checkFile(openedFile);
    if (!sameObject(namedFile, openedFile)) fail('unsafe_file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    for (;;) {
      checkTime();
      const n = fs.readSync(fileFd, buffer, size, Math.min(8192, buffer.length - size), null);
      size += n;
      if (size > MAX_BYTES) fail('file_too_large', 'Saved credentials exceed 65,536 bytes.');
      if (!n) break;
    }
    const finalFile = fs.fstatSync(fileFd);
    checkFile(finalFile);
    if (
      !sameObject(openedFile, finalFile) ||
      size !== finalFile.size ||
      openedFile.size !== finalFile.size ||
      openedFile.mtimeMs !== finalFile.mtimeMs ||
      openedFile.ctimeMs !== finalFile.ctimeMs
    )
      fail('unsafe_file');
    const finalNamedFile = fs.lstatSync(filename);
    checkFile(finalNamedFile);
    if (!sameObject(openedFile, finalNamedFile)) fail('unsafe_file');
    const finalDir = fs.fstatSync(dirFd);
    const finalNamedDir = fs.lstatSync(directory);
    checkDir(finalDir);
    checkDir(finalNamedDir);
    if (!sameObject(openedDir, finalDir) || !sameObject(openedDir, finalNamedDir))
      fail('unsafe_directory');
    checkTime();
    return buffer.subarray(0, size);
  } catch (error) {
    if (error instanceof CredentialsError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') fail('missing_credentials', 'No API key or saved credentials found.');
    return fail(
      'unsafe_file',
      'Cannot safely read saved credentials; check the directory and file protection.',
    );
  } finally {
    if (fileFd !== undefined) fs.closeSync(fileFd);
    if (dirFd !== undefined) fs.closeSync(dirFd);
  }
}

export type LocalCredentialOptions = { apiKey?: string; profile?: string; baseUrl?: string };
export type ResolvedCredentials = {
  apiKey: string;
  baseUrl: string;
  source: 'explicit' | 'environment' | 'file';
  profile?: string;
};

/** Resolve once at local startup, before constructing an explicit ServerConfig. */
export function resolveCredentials(options: LocalCredentialOptions = {}): ResolvedCredentials {
  const explicit = options.apiKey;
  const legacyBase = () =>
    (options.baseUrl ?? process.env.MANDALA_BASE_URL?.trim()) || DEFAULT_BASE_URL;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !trimCredentialWhitespace(explicit))
      fail('invalid_explicit_key', 'The supplied API key must be a nonempty string.');
    return {
      apiKey: trimCredentialWhitespace(explicit),
      baseUrl: legacyBase(),
      source: 'explicit',
    };
  }
  const environment = trimCredentialWhitespace(process.env.MANDALA_API_KEY ?? '');
  if (environment) return { apiKey: environment, baseUrl: legacyBase(), source: 'environment' };
  // null is supplied in JavaScript, and must not fall through to the environment.
  const profile =
    options.profile !== undefined
      ? options.profile
      : trimCredentialWhitespace(process.env.MANDALA_PROFILE ?? '') || undefined;
  if (profile !== undefined) profileName(profile);
  const doc = parseCredentials(readStore());
  const name = profile ?? doc.default_profile;
  if (!Object.hasOwn(doc.profiles, name))
    fail('missing_selected_profile', 'The selected credential profile is missing.');
  const entry = doc.profiles[name];
  const override =
    options.baseUrl !== undefined
      ? options.baseUrl
      : trimCredentialWhitespace(process.env.MANDALA_BASE_URL ?? '') || undefined;
  if (override !== undefined && canonicalizeBaseUrl(override) !== entry.base_url)
    fail('base_binding_mismatch', 'The base URL does not match the selected credential profile.');
  return {
    apiKey: trimCredentialWhitespace(entry.api_key),
    baseUrl: entry.base_url,
    source: 'file',
    profile: name,
  };
}
