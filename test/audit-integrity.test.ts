import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../src/api.js';
import { BASE, connect } from './harness.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const textOf = (result: CallToolResult) =>
  result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');

/** Accepted work followed by inventories; unexpected extra polls fail the test. */
function snapshots(listings: unknown[][]) {
  const requests: string[] = [];
  let polls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method} ${url.pathname}`);
    if (init?.method !== 'GET') {
      return Response.json({ id: 'snap-7', state: 'capturing' }, { status: 202 });
    }
    if (polls >= listings.length) throw new Error('Unexpected snapshot poll');
    return Response.json(listings[polls++]);
  }) as typeof fetch;
  return { requests, polls: () => polls };
}

describe('asynchronous result identity and inventory integrity', () => {
  it('waits for a padded snapshot id to actually disappear', async () => {
    const platform = snapshots([[{ id: 'snap-7', state: 'deleting' }], []]);
    const { call, close } = await connect();
    try {
      const result = await call('delete_snapshot', {
        snapshot_id: ' snap-7 ',
        confirm: true,
        timeout_s: 5,
      });
      expect(result.isError).toBeFalsy();
      expect(platform.polls()).toBe(2);
      expect(platform.requests[0]).toBe('DELETE /api/v1/snapshots/snap-7');
      expect(textOf(result)).toContain('Deleted snapshot snap-7.');
    } finally {
      await close();
    }
  });

  it('accepts canonical terminal build events for a padded build id', async () => {
    globalThis.fetch = (async () =>
      new Response('event: done\ndata: {"id":"bld-1","status":"succeeded","done":true}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch;
    const { call, close } = await connect();
    try {
      const result = await call('watch_build', { build_id: ' bld-1 ' });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Build bld-1 succeeded.');
    } finally {
      await close();
    }
  });

  it.each(['create_snapshot', 'delete_snapshot'])('%s waits past unreadable rows', async (tool) => {
    const terminal = tool === 'create_snapshot' ? [{ id: 'snap-7', state: 'durable' }] : [];
    const platform = snapshots([[null, {}, { id: 7 }, { id: '' }, { id: '   ' }], terminal]);
    const { call, close } = await connect();
    try {
      const result = await call(tool, {
        computer_id: 'vm-1',
        snapshot_id: 'snap-7',
        confirm: true,
        timeout_s: 5,
      });
      expect(platform.polls()).toBe(2);
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).not.toContain('FAILED');
    } finally {
      await close();
    }
  });

  it('uses an identifiable target even when unrelated rows are malformed', async () => {
    const platform = snapshots([[null, {}, { id: 'snap-7', state: 'durable' }]]);
    const { call, close } = await connect();
    try {
      const result = await call('create_snapshot', { computer_id: 'vm-1', timeout_s: 5 });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('The capture landed');
      expect(platform.polls()).toBe(1);
    } finally {
      await close();
    }
  });

  it.each(['', '   ', '..', 'bad/id'])(
    'keeps invalid snapshot/build ids refused: %j',
    async (id) => {
      const fetch = vi.fn();
      globalThis.fetch = fetch;
      const { call, close } = await connect();
      try {
        expect((await call('delete_snapshot', { snapshot_id: id, confirm: true })).isError).toBe(
          true,
        );
        expect((await call('watch_build', { build_id: id })).isError).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    },
  );
});

describe('file bytes at EOF', () => {
  it.each(['c2', 'e282', 'f09f98', '00', 'ff'])(
    'preserves invalid/binary suffix %s as base64',
    async (hex) => {
      const bytes = Buffer.concat([Buffer.from('hello'), Buffer.from(hex, 'hex')]);
      globalThis.fetch = (async () =>
        new Response(bytes, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(bytes.length),
          },
        })) as typeof fetch;
      const { call, close } = await connect();
      try {
        const result = await call('read_file', { path: '/tmp/bytes.bin' });
        expect(textOf(result)).toContain(`Base64:\n\n${bytes.toString('base64')}`);
        expect(textOf(result)).not.toContain('\ufffd');
      } finally {
        await close();
      }
    },
  );

  it('keeps a literal replacement character as valid text', async () => {
    globalThis.fetch = (async () => new Response('hello\ufffd')) as typeof fetch;
    const { call, close } = await connect();
    try {
      const result = await call('read_file', { path: '/tmp/text.txt' });
      expect(textOf(result)).toContain('hello\ufffd');
      expect(textOf(result)).not.toContain('Base64:');
    } finally {
      await close();
    }
  });

  it('preserves and advances a tiny page containing only part of one character', async () => {
    globalThis.fetch = (async () =>
      new Response(Buffer.from([0xe2]), {
        status: 206,
        headers: { 'Content-Type': 'text/plain', 'Content-Range': 'bytes 0-0/3' },
      })) as typeof fetch;
    const { call, close } = await connect();
    try {
      const result = await call('read_file', { path: '/tmp/text.txt' });
      expect(textOf(result)).toContain('Base64:\n\n4g==');
      expect(textOf(result)).toContain('read_file again with offset: 1');
    } finally {
      await close();
    }
  });
});

describe('rejected SSE response cleanup', () => {
  it.each([false, true])(
    'cancels the body without masking the error (cancel rejects: %s)',
    async (reject) => {
      const cancel = vi.fn(() => (reject ? Promise.reject(new Error('cancel failed')) : undefined));
      const body = new ReadableStream<Uint8Array>({ cancel });
      globalThis.fetch = (async () =>
        new Response(body, { headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
      const stream = new Api('com_test', BASE).sse('GET', 'builds/bld-1/events');
      await expect(stream.next()).rejects.toThrow('expected text/event-stream');
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    },
  );
});
