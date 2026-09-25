import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorForStatus, isTransient, UnavailableError } from '../src/errors.js';
import { describe as describeComputer, failed } from '../src/format.js';
import { connect, installFakePlatform } from './harness.js';

// OPL-5026: the MCP server audited against the corrected API docs (OPL-5025).
// One test per behaviour the audit changed, each against what the docs say.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** Answer every platform request with one status and body while `fn` runs. */
async function answering<T>(
  status: number,
  body: unknown,
  fn: () => Promise<T>,
  seen: { method: string; url: string }[] = [],
): Promise<T> {
  const restore = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ method: (init?.method ?? 'GET').toUpperCase(), url: String(input) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = restore;
  }
}

async function once(tool: string, args: Record<string, unknown>) {
  const c = await connect();
  try {
    return await c.call(tool, args);
  } finally {
    await c.close();
  }
}

describe('a 503: a read can be sent again, a change may have happened', () => {
  it('tells a model not to replay a POST blind, and lets a GET be asked again', async () => {
    const post = await answering(503, { error: 'a hypervisor could not be reached' }, () =>
      once('create_secret', { name: 'A_TOKEN', value: 'value-long-enough' }),
    );
    expect(post.isError).toBe(true);
    expect(textOf(post)).toContain('THIS CHANGE MAY OR MAY NOT HAVE HAPPENED');

    const get = await answering(503, { error: 'a hypervisor could not be reached' }, () =>
      once('list_secrets', {}),
    );
    expect(textOf(get)).toContain('the same request can be sent again shortly');
    expect(textOf(get)).not.toContain('MAY OR MAY NOT');
  });

  it('carries the method from the request onto the error the Api raises', () => {
    const post = errorForStatus(503, 'x', undefined, undefined, { method: 'post' });
    expect(post).toBeInstanceOf(UnavailableError);
    expect(post.method).toBe('POST');
    expect(isTransient(post)).toBe(false);
    expect(textOf(failed(post))).toContain('MAY OR MAY NOT HAVE HAPPENED');
    // Even a reason saying "clears" does not outrank an unknown outcome.
    const worded = errorForStatus(503, 'x', { reason: 'contention' }, undefined, {
      method: 'POST',
    });
    expect(textOf(failed(worded))).toContain('MAY OR MAY NOT HAVE HAPPENED');
  });
});

describe('a 503 decided before the reason word', () => {
  // The Codex review (OPL-5026): a `contention` or `starting` on a change's 503
  // made isTransient say yes while failed() said the change may have happened.
  // Only a GET or HEAD is transient on a 503, and the two answers agree.
  const changes = ['POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', undefined];
  const bodies = [undefined, { reason: 'contention' }, { reason: 'starting' }];
  it.each(changes.map((m) => [String(m), m] as const))('a %s is not replayed', (_n, method) => {
    for (const body of bodies) {
      const err = errorForStatus(503, 'x', body, undefined, { method });
      expect(isTransient(err), JSON.stringify(body)).toBe(false);
      expect(textOf(failed(err))).toContain('MAY OR MAY NOT HAVE HAPPENED');
    }
  });
  it.each([['GET'], ['HEAD']])('a %s can be sent again', (method) => {
    for (const body of bodies) {
      const err = errorForStatus(503, 'x', body, undefined, { method });
      expect(isTransient(err)).toBe(true);
      expect(textOf(failed(err))).toContain('can be sent again shortly');
    }
  });
});

describe('the boot window and after it', () => {
  it('says starting clears and names the 502 that follows the window', () => {
    const starting = errorForStatus(409, 'guest agent not answering yet', {
      error: 'guest agent not answering yet',
      reason: 'starting',
    });
    expect(isTransient(starting)).toBe(true);
    expect(textOf(failed(starting))).toContain('two minutes');
    expect(textOf(failed(starting))).toContain('502');
    // A word this version has never heard of is no classification at all.
    const unknown = errorForStatus(409, 'x', { error: 'x', reason: 'some-new-word' });
    expect(unknown.reason).toBe('some-new-word');
    expect(isTransient(unknown)).toBe(true);
  });
});

describe('type_text', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('reports how the text was typed, and that sending is not acceptance', async () => {
    const res = await answering(200, { ok: true, mechanism: 'mixed' }, () =>
      once('type_text', { text: 'héllo' }),
    );
    expect(textOf(res)).toContain('Typed 5 character(s) in order');
    expect(textOf(res)).toContain('not that the application accepted');
    const unknown = await answering(200, { ok: true, mechanism: 'toString' }, () =>
      once('type_text', { text: 'hi' }),
    );
    expect(textOf(unknown)).toContain('Typed 2 character(s).');
  });

  it('refuses empty and over-long text before sending anything', async () => {
    const c = await connect();
    for (const text of ['', 'x'.repeat(401)]) {
      const before = platform.calls.length;
      let res: CallToolResult | undefined;
      try {
        res = await c.call('type_text', { text });
      } catch {
        res = undefined;
      }
      if (res) expect(res.isError).toBe(true);
      expect(platform.calls.slice(before)).toEqual([]);
    }
    // 400 emoji are 800 UTF-16 units and still 400 characters.
    const ok = await c.call('type_text', { text: '😀'.repeat(400) });
    expect(ok.isError).toBeFalsy();
    await c.close();
  });
});

describe('no_wake on a file transfer', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('sends no_wake=1 only when asked', async () => {
    const c = await connect();
    await c.call('read_file', { path: '/tmp/a' });
    expect(platform.calls.at(-1)?.query.has('no_wake')).toBe(false);
    await c.call('read_file', { path: '/tmp/a', no_wake: true });
    expect(platform.calls.at(-1)?.query.get('no_wake')).toBe('1');
    await c.call('write_file', { path: '/tmp/a', content: 'x', no_wake: true });
    expect(platform.calls.at(-1)?.query.get('no_wake')).toBe('1');
    await c.close();
  });

  it('reads the not-running 409 the same with no reason and with unavailable', async () => {
    for (const body of [
      { error: 'the computer is not running' },
      { error: 'the computer is not running', reason: 'unavailable' },
    ]) {
      const read = await answering(409, body, () =>
        once('read_file', { path: '/tmp/a', no_wake: true }),
      );
      expect(read.isError).toBe(true);
      expect(textOf(read)).toContain('was not resumed, because no_wake was set');
      expect(textOf(read)).toContain('nothing was read from /tmp/a');
      const write = await answering(409, body, () =>
        once('write_file', { path: '/tmp/a', content: 'x', no_wake: true }),
      );
      expect(textOf(write)).toContain('nothing was written to /tmp/a');
    }
    // A create-only upload with no_wake: a reasonless 409 is the create-only
    // conflict, claiming nothing about the path or the computer's state.
    const both = await answering(409, { error: 'conflict' }, () =>
      once('write_file', { path: '/tmp/a', content: 'x', no_wake: true, overwrite: false }),
    );
    expect(textOf(both)).toContain('reason unknown');
    expect(textOf(both)).not.toContain('no_wake was set');
    expect(textOf(both)).not.toMatch(/not running|suspended or stopped/);
    // Another word is left to the ordinary refusal.
    const busy = await answering(409, { error: 'busy', reason: 'contention' }, () =>
      once('read_file', { path: '/tmp/a', no_wake: true }),
    );
    expect(textOf(busy)).not.toContain('no_wake was set');
  });
});

describe('a computer’s secrets state, in the one-line description', () => {
  const base = { id: 'vm-1', name: 'box', status: 'running' };
  it('says pending, unknown, and a failed delivery; false and absent say nothing', () => {
    expect(describeComputer({ ...base, secrets_pending: true })).toContain(
      'pending until it restarts',
    );
    expect(describeComputer({ ...base, secrets_pending: null })).toContain('unknown');
    expect(describeComputer({ ...base, secrets_pending: false })).toBe(describeComputer(base));
    expect(
      describeComputer({ ...base, secrets_error: 'The secrets could not be delivered.' }),
    ).toContain('secrets not delivered: The secrets could not be delivered.');
  });
});

describe('a memory clone that came across as a disk', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('names each documented reason, and shows one it does not know', async () => {
    const computer = { id: 'vm-9', name: 'copy', status: 'stopped' };
    const clone = (reason: string) =>
      answering(201, { ...computer, memory_dropped: true, memory_dropped_reason: reason }, () =>
        once('clone_snapshot', { snapshot_id: 'snap-1' }),
      );
    expect(textOf(await clone('capture unrecorded'))).toContain(
      'before the platform recorded which capture each snapshot is',
    );
    expect(textOf(await clone('a future reason'))).toContain('reason given: "a future reason"');
  });
});

describe('window_action', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('refuses a resize with only one dimension before sending it', async () => {
    const c = await connect();
    const before = platform.calls.length;
    const res = await c.call('window_action', {
      window_id: '0x2600003',
      action: 'resize',
      width: 640,
    });
    expect(res.isError).toBe(true);
    expect(platform.calls.slice(before)).toEqual([]);
    await c.close();
  });
});
