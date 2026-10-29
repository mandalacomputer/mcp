import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { describe as describeComputer } from '../src/format.js';
import { createBody } from '../src/paths.js';
import { connect } from './harness.js';

// A computer's end time on create_computer and update_computer, and the
// summary line naming it.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

type Seen = { method: string; path: string; body?: unknown };

async function platform<T>(
  respond: (seen: Seen) => [number, unknown],
  fn: (seen: Seen[]) => Promise<T>,
): Promise<T> {
  const restore = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const call: Seen = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname.replace(/^\/api\/v1/, ''),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(call);
    const [status, body] = respond(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = restore;
  }
}

const ENDS = '2026-11-01T18:00:00Z';
const box = (extra: Record<string, unknown> = {}) => ({
  id: 'vm-1',
  name: 'box',
  status: 'running',
  running_ram_mb: 2048,
  ...extra,
});

describe('createBody with an end time', () => {
  it('sends ends_at or ends_in_hours as given', () => {
    expect(createBody({ template: 'base', ends_at: ENDS })).toEqual({
      template: 'base',
      ends_at: ENDS,
      start: true,
    });
    expect(createBody({ template: 'base', ends_in_hours: 0.5 })).toEqual({
      template: 'base',
      ends_in_hours: 0.5,
      start: true,
    });
  });

  it('refuses both at once', () => {
    expect(() => createBody({ ends_at: ENDS, ends_in_hours: 2 })).toThrow(/not both/);
  });
});

describe('create_computer with an end time', () => {
  it('sends ends_in_hours and reports the end time', async () => {
    const res = await platform(
      () => [201, box({ ends_at: ENDS })],
      async (seen) => {
        const { call, close } = await connect({ computerId: undefined });
        const r = await call('create_computer', { template: 'base', ends_in_hours: 8 });
        await close();
        const post = seen.find((s) => s.method === 'POST' && s.path === '/computers');
        expect(post?.body).toEqual({ template: 'base', ends_in_hours: 8, start: true });
        return r;
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(`stops by itself at ${ENDS}`);
  });

  it.each([
    [{ ends_at: ENDS, ends_in_hours: 2 }],
    [{ ends_at: 'tomorrow' }],
    [{ ends_at: '' }],
    [{ ends_in_hours: 0 }],
    [{ ends_in_hours: -1 }],
  ])('refuses %j before any request', async (args) => {
    await platform(
      () => [201, box()],
      async (seen) => {
        const { call, close } = await connect({ computerId: undefined });
        const r = await call('create_computer', { template: 'base', ...args });
        await close();
        expect(r.isError).toBe(true);
        expect(seen.filter((s) => s.method === 'POST')).toEqual([]);
      },
    );
  });
});

describe('update_computer with an end time', () => {
  it.each([
    [{ ends_at: ENDS }],
    [{ ends_in_hours: 2.5 }],
    [{ ends_at: null }],
    [{ ends_in_hours: null }],
  ])('sends %j alone', async (fields) => {
    await platform(
      () => [200, box()],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', fields);
        await close();
        expect(r.isError).toBeFalsy();
        expect(seen).toEqual([{ method: 'PATCH', path: '/computers/vm-1', body: fields }]);
      },
    );
  });

  it.each([
    [{ ends_at: ENDS, name: 'x' }, 'ends_at must be sent on its own, not beside name'],
    [{ ends_in_hours: 1, idle_suspend_min: 30 }, 'ends_in_hours must be sent on its own'],
    [{ ends_at: null, cpu: 2 }, 'ends_at must be sent on its own'],
    [{ ends_at: ENDS, ends_in_hours: 1 }, 'not both'],
  ])('refuses %j before any request', async (fields, says) => {
    await platform(
      () => [200, box()],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('update_computer', fields);
        await close();
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain(says);
        expect(seen).toEqual([]);
      },
    );
  });
});

describe('the summary line', () => {
  it('names the end time only when there is one', () => {
    expect(describeComputer(box({ ends_at: ENDS }))).toContain(`stops by itself at ${ENDS}`);
    expect(describeComputer(box())).not.toContain('stops by itself');
  });
});
