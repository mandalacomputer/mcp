import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';
import {
  APIError,
  errorForStatus,
  isTransient,
  isTransientForPoll,
  OriginResponseError,
  OriginTLSError,
  OriginUnreachableError,
  platformSaid,
  reasonAdvice,
  reasonKind,
} from '../src/errors.js';
import * as P from '../src/paths.js';
import { DOCUMENTED_REASONS } from '../src/secret-store.js';
import { BASE, connect, installFakePlatform } from './harness.js';

// Where this server answered differently from both SDKs, found by the
// pre-release parity audit (OPL-5522). Each case here is one of those answers,
// pinned to the SDKs' side of it.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answer every request to the platform with one status and raw body. */
function answering(status: number, body: string): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

describe('the paste shortcut on the wire', () => {
  it('sends ctrl+shift+v as keys, the array spelling both SDKs send', () => {
    const body = P.pasteBody('hi', 'ctrl+shift+v') as Record<string, unknown>;
    expect(body).toEqual({ action: 'paste', text: 'hi', keys: ['ctrl', 'shift', 'v'] });
    expect(body).not.toHaveProperty('key');
    // ctrl+v is the platform's default, so naming it sends nothing extra.
    expect(P.pasteBody('hi', 'ctrl+v')).toEqual({ action: 'paste', text: 'hi' });
    expect(P.pasteBody('hi')).toEqual({ action: 'paste', text: 'hi' });
  });
});

describe('an RFC 9457 error body', () => {
  const PROBLEM = JSON.stringify({
    type: 'about:blank',
    title: 'Forbidden',
    status: 403,
    detail: 'The request was blocked by a security rule at the edge.',
  });

  it('puts detail in the message, not the serialized body', async () => {
    answering(403, PROBLEM);
    const err = await new Api('com_synthetic', BASE)
      .json('GET', 'computers')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).message).toBe(
      'The request was blocked by a security rule at the edge.',
    );
    // Read for the message only: it does not count as the platform naming it.
    expect(platformSaid((err as APIError).body)).toBeUndefined();
  });

  it('falls back to title when there is no detail', async () => {
    answering(403, JSON.stringify({ title: 'Forbidden', status: 403 }));
    const err = await new Api('com_synthetic', BASE)
      .json('GET', 'computers')
      .catch((e: unknown) => e);
    expect((err as APIError).message).toBe('Forbidden');
  });

  it("shows a tool caller the edge's sentence, not raw JSON", async () => {
    answering(403, PROBLEM);
    const { call, close } = await connect();
    const res = await call('list_computers', {});
    await close();
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('The request was blocked by a security rule at the edge.');
    expect(textOf(res)).not.toContain('"title"');
  });

  it("still gives this server's wording on a status it has some for", async () => {
    answering(504, JSON.stringify({ title: 'Gateway Timeout', detail: 'The origin timed out.' }));
    const err = await new Api('com_synthetic', BASE)
      .json('GET', 'computers')
      .catch((e: unknown) => e);
    expect((err as APIError).message).toMatch(/gave up waiting/);
  });
});

describe('the status to class mapping, as the SDKs have it', () => {
  it('makes a 502 a bare APIError, still polled through and not published', () => {
    const err = errorForStatus(502, 'HTTP 502');
    expect(err.constructor).toBe(APIError);
    expect(err).not.toBeInstanceOf(OriginResponseError);
    expect(err.status).toBe(502);
    // Not the bare status: the model is told what a 502 can and cannot mean.
    expect(err.message).toMatch(/unknown/);
    expect(isTransientForPoll(err)).toBe(true);
    expect(isTransient(err)).toBe(false);
    // A 520 keeps its own class.
    expect(errorForStatus(520, 'HTTP 520')).toBeInstanceOf(OriginResponseError);
  });

  it.each([521, 522, 523])('always gives HTTP %i the unreachable wording', (status) => {
    const body = { error: 'backend pool empty; scale the worker group' };
    const err = errorForStatus(status, body.error, body);
    expect(err).toBeInstanceOf(OriginUnreachableError);
    expect(err.message).toMatch(/could not reach it/);
    expect(err.message).not.toContain('backend pool');
  });

  it.each([525, 526])('always gives HTTP %i the TLS wording', (status) => {
    const body = { error: 'handshake failed' };
    const err = errorForStatus(status, body.error, body);
    expect(err).toBeInstanceOf(OriginTLSError);
    expect(err.message).toMatch(/TLS handshake/);
  });
});

describe('the byte count after an upload', () => {
  it('says no count came back rather than claiming every byte landed', async () => {
    const fake = installFakePlatform();
    const underlying = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (init?.method === 'PUT' && url.pathname.endsWith('/files'))
        return new Response(JSON.stringify({ path: '/tmp/a.txt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      return underlying(input as never, init);
    }) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call('write_file', {
        path: '/tmp/a.txt',
        content: 'hello',
        encoding: 'utf8',
      });
      await close();
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).not.toMatch(/Wrote 5 bytes/);
      expect(textOf(res)).toMatch(/without a byte count/);
      expect(textOf(res)).toContain('"bytes": null');
    } finally {
      fake.restore();
    }
  });

  it("reports the platform's count when it gives one", async () => {
    const fake = installFakePlatform();
    try {
      const { call, close } = await connect();
      const res = await call('write_file', {
        path: '/tmp/a.txt',
        content: 'hello',
        encoding: 'utf8',
      });
      await close();
      expect(textOf(res)).toContain('Wrote 5 bytes to /home/user/a.txt.');
    } finally {
      fake.restore();
    }
  });
});

describe('a secret name, trimmed before it is counted', () => {
  it('takes a padded name that is 60 characters once trimmed, and sends it trimmed', async () => {
    const fake = installFakePlatform();
    try {
      const { call, close } = await connect();
      const name = 'A'.repeat(60);
      const res = await call('create_secret', { name: ` ${name} `, value: 'v' });
      expect(res.isError, textOf(res)).toBeFalsy();
      const sent = fake.calls.find((c) => c.method === 'POST' && c.path === '/secrets');
      expect(sent?.body).toMatchObject({ name });
      // Counted in code points, as the platform counts them.
      const emoji = await call('create_secret', { name: '\u{1F600}'.repeat(60), value: 'v' });
      expect(emoji.isError, textOf(emoji)).toBeFalsy();
      await close();
    } finally {
      fake.restore();
    }
  });

  it('refuses 61 characters after the trim, before sending anything', async () => {
    const fake = installFakePlatform();
    try {
      const { call, close } = await connect();
      const before = fake.calls.length;
      let res: CallToolResult | undefined;
      try {
        res = await call('create_secret', { name: ` ${'A'.repeat(61)} `, value: 'v' });
      } catch {
        res = undefined;
      }
      if (res) expect(res.isError).toBe(true);
      expect(fake.calls.slice(before)).toEqual([]);
      await close();
    } finally {
      fake.restore();
    }
  });
});

describe("the secret store's two conflict words", () => {
  it.each([
    ['name_taken', /already exists in this scope; this does not clear by waiting/],
    [
      'stale_revision',
      /changed since you read it; read it again and retry with its current revision/,
    ],
  ] as const)('treats %s as permanent, shows it, and says what to do', async (reason, advice) => {
    expect(reasonKind(reason)).toBe('permanent');
    expect(isTransient(errorForStatus(409, 'conflict', { error: 'conflict', reason }))).toBe(false);
    expect(DOCUMENTED_REASONS.has(reason)).toBe(true);
    expect(reasonAdvice(reason)).toMatch(advice);

    answering(409, JSON.stringify({ error: 'A secret with this name already exists.', reason }));
    const { call, close } = await connect();
    const res =
      reason === 'name_taken'
        ? await call('create_secret', { name: 'A_TOKEN', value: 'value-long-enough' })
        : await call('replace_secret', {
            secret_id: 'csec-0123456789abcdef',
            value: 'value-long-enough',
            revision_id: 'csr-0123456789abcdef01234567',
          });
    await close();
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`reason "${reason}"`);
    expect(textOf(res)).toMatch(advice);
  });
});
