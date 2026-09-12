import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BUFFERED } from '../src/events.js';
import { connect, FakeSocket, fakeEvents, installFakePlatform } from './harness.js';

const textOf = (result: CallToolResult) =>
  result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

const dataOf = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(textOf(result).split('\n\n').slice(1).join('\n\n'));

async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error('the expected socket did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('event recovery answers', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('does not describe a disconnected empty stream as open', async () => {
    const events = fakeEvents({ ready: false });
    const session = await connect({ webSocket: events.factory });
    try {
      await session.call('poll_events');
      events.last().close();
      const result = textOf(await session.call('poll_events'));
      expect(result).toContain('reconnecting');
      expect(result).not.toContain('The stream is open and buffering');
    } finally {
      await session.close();
    }
  });

  it('does not promise continuous listening when a wait ends during an outage', async () => {
    const events = fakeEvents({ ready: false });
    let first = true;
    const session = await connect({
      webSocket: (url) => {
        if (first) {
          first = false;
          return events.factory(url);
        }
        return new FakeSocket(url);
      },
    });
    try {
      await session.call('poll_events');
      events.last().close();
      const result = textOf(await session.call('wait_for_event', { timeout_s: 1 }));
      expect(result).toContain('reconnecting');
      expect(result).not.toContain('kept listening the whole time');
      expect(result).not.toContain('nothing was missed');
    } finally {
      await session.close();
    }
  });

  it('remembers an interruption even when the socket reopens before timeout', async () => {
    const events = fakeEvents({ ready: false });
    const session = await connect({ webSocket: events.factory });
    try {
      await session.call('poll_events');
      const waiting = session.call('wait_for_event', { timeout_s: 1 });
      const disconnect = setTimeout(() => events.last().close(), 20);
      const result = textOf(await waiting);
      clearTimeout(disconnect);
      expect(events.sockets).toHaveLength(2);
      expect(result).toContain('interrupted');
      expect(result).not.toContain('kept listening the whole time');
    } finally {
      await session.close();
    }
  });

  it('still delivers replayed events in order after reconnecting', async () => {
    const events = fakeEvents({ ready: false });
    const session = await connect({ webSocket: events.factory });
    try {
      await session.call('poll_events');
      events.last().close();
      const waiting = session.call('wait_for_event', { timeout_s: 2 });
      await until(() => events.sockets.length === 2 && events.last().greeted);
      for (const cursor of ['cur-1', 'cur-2']) {
        events.last().send({ type: 'window.opened', cursor, data: { id: cursor } });
      }
      const first = textOf(await waiting);
      const second = textOf(await session.call('poll_events'));
      expect(first).toContain('cur-1');
      expect(second).toContain('cur-2');
      expect(events.last().since).toBe('cur-0');
    } finally {
      await session.close();
    }
  });

  it('reports a file wait interrupted by an outage even after reopening', async () => {
    const events = fakeEvents({ ready: false });
    const session = await connect({ webSocket: events.factory });
    try {
      await session.call('poll_events');
      const first = session.call('wait_for_file_change', { path: '/a', timeout_s: 2 });
      await until(() => events.last().greeted && events.last().watches.includes('/a'));
      events.last().send({
        type: 'file.changed',
        cursor: 'cur-1',
        data: { watch: '/a', path: '/a/output', kind: 'create' },
      });
      await first;
      const waiting = session.call('wait_for_file_change', { path: '/a', timeout_s: 1 });
      const disconnect = setTimeout(() => events.last().close(), 20);
      const result = textOf(await waiting);
      clearTimeout(disconnect);
      expect(events.sockets).toHaveLength(3);
      expect(result).toContain('interrupted');
      expect(result).not.toContain('watched for the whole of that');
      expect(result).not.toContain('Nothing changed under');
    } finally {
      await session.close();
    }
  });

  it('bounds polling reconciliation even when a fetch ignores cancellation', async () => {
    const events = fakeEvents({ ready: false });
    const session = await connect({ webSocket: events.factory });
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      await session.call('poll_events');
      events.last().send({ type: 'gap', cursor: 'cur-gap', data: {} });
      events.last().send({ type: 'window.opened', cursor: 'cur-event', data: {} });
      const normal = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (!String(input).endsWith('/windows')) return normal(input, init);
        return new Promise<Response>((resolve) => {
          release = setTimeout(() => resolve(new Response('{"windows":[]}')), 3000);
        });
      };
      const started = Date.now();
      const result = textOf(await session.call('poll_events'));
      expect(Date.now() - started).toBeLessThan(2500);
      expect(result).toContain('cur-event');
      expect(result).toContain('"lost"');
      expect(result).toContain('"computer_now"');
      expect(result).toContain('list_windows');
    } finally {
      clearTimeout(release);
      await session.close();
    }
  });

  for (const [tool, stalled] of [
    ['wait_for_event', 'headers'],
    ['wait_for_event', 'body'],
    ['wait_for_file_change', 'headers'],
  ] as const) {
    it(`bounds ${tool} reconciliation with stalled ${stalled}`, async () => {
      const events = fakeEvents({ ready: false });
      const session = await connect({ webSocket: events.factory });
      let release: ReturnType<typeof setTimeout> | undefined;
      try {
        await session.call('poll_events');
        if (tool === 'wait_for_file_change') {
          const arm = session.call(tool, { path: '/a', timeout_s: 2 });
          await until(() => events.last().greeted && events.last().watches.includes('/a'));
          events.last().send({
            type: 'file.changed',
            cursor: 'cur-arm',
            data: { watch: '/a', path: '/a/first', kind: 'create' },
          });
          await arm;
        }
        events.last().send({ type: 'gap', cursor: 'cur-gap', data: {} });
        events.last().send({
          type: tool === 'wait_for_file_change' ? 'file.changed' : 'window.opened',
          cursor: 'cur-event',
          data: { watch: '/a', path: '/a/output', kind: 'create' },
        });
        const normal = globalThis.fetch;
        let signal: AbortSignal | null | undefined;
        globalThis.fetch = async (input, init) => {
          if (!String(input).endsWith('/windows')) return normal(input, init);
          signal = init?.signal;
          if (stalled === 'headers') {
            return new Promise<Response>((resolve, reject) => {
              release = setTimeout(() => resolve(new Response('{"windows":[]}')), 1800);
              signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
            });
          }
          return new Response(
            new ReadableStream({
              start(controller) {
                release = setTimeout(() => {
                  controller.enqueue(new TextEncoder().encode('{"windows":[]}'));
                  controller.close();
                }, 1800);
                signal?.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(release);
                    controller.error(signal?.reason);
                  },
                  { once: true },
                );
              },
            }),
          );
        };
        const started = Date.now();
        const pending = session.call(tool, {
          timeout_s: 1,
          ...(tool === 'wait_for_file_change' ? { path: '/a' } : {}),
        });
        await until(() => signal !== undefined);
        const concurrent = session.call('wait_for_event', {
          types: ['process.exited'],
          timeout_s: 3,
        });
        const result = textOf(await pending);
        expect(Date.now() - started).toBeLessThan(1500);
        expect(signal?.aborted).toBe(true);
        expect(result).toContain('cur-event');
        expect(result).toContain('"lost"');
        expect(result).toContain('"computer_now"');
        expect(result).not.toContain('"windows_now"');
        expect(result).toContain('list_windows');
        events.last().send({ type: 'process.exited', cursor: 'cur-after', data: { pid: 7 } });
        expect(textOf(await concurrent)).toContain('cur-after');
        expect(events.last().closed).toBe(false);
      } finally {
        clearTimeout(release);
        await session.close();
      }
    });
  }

  it('does not start auxiliary reads after the wait budget expires', async () => {
    const events = fakeEvents({ ready: false });
    const session = await connect({ webSocket: events.factory });
    try {
      await session.call('poll_events');
      events.last().send({ type: 'gap', cursor: 'cur-gap', data: {} });
      const readsBefore = platform.calls.length;
      const result = textOf(await session.call('wait_for_event', { timeout_s: 1 }));
      expect(platform.calls).toHaveLength(readsBefore);
      expect(result).toContain('"lost"');
      expect(result).toContain('list_windows');
      expect(result).not.toContain('nothing was missed');
    } finally {
      await session.close();
    }
  });

  for (const tool of ['poll_events', 'wait_for_event'] as const) {
    it(`leaves ${tool} delivery and loss unread when reconciliation is cancelled`, async () => {
      const events = fakeEvents({ ready: false });
      const session = await connect({ webSocket: events.factory });
      const normal = globalThis.fetch;
      let reconciling: AbortSignal | null | undefined;
      try {
        await session.call('poll_events');
        events.last().send({ type: 'gap', cursor: 'cur-gap', data: {} });
        events.last().send({ type: 'window.opened', cursor: 'cur-event', data: { id: '0x1' } });
        globalThis.fetch = (async (input, init) => {
          if (!String(input).endsWith('/windows')) return normal(input, init);
          reconciling = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            reconciling?.addEventListener('abort', () => reject(reconciling?.reason), {
              once: true,
            });
          });
        }) as typeof fetch;

        const controller = new AbortController();
        const cancelled = session.client.callTool(
          { name: tool, arguments: { timeout_s: 5 } },
          undefined,
          { signal: controller.signal },
        );
        await until(() => reconciling !== undefined);
        controller.abort();
        await expect(cancelled).rejects.toThrow();
        await until(() => reconciling?.aborted === true);
        globalThis.fetch = normal;

        const next = textOf(await session.call('poll_events'));
        expect(next).toContain('cur-event');
        expect(next).toContain('"lost"');
      } finally {
        globalThis.fetch = normal;
        await session.close();
      }
    });
  }

  it('keeps an eviction cursor behind survivors when a reconnect gaps during reconciliation', async () => {
    const hello = { ready: false };
    const events = fakeEvents(hello);
    const session = await connect({ webSocket: events.factory });
    const normal = globalThis.fetch;
    let release: (() => void) | undefined;
    try {
      await session.call('poll_events');
      globalThis.fetch = (async (input, init) => {
        if (!String(input).endsWith('/windows')) return normal(input, init);
        return new Promise<Response>((resolve) => {
          release = () => resolve(new Response('{"windows":[]}'));
        });
      }) as typeof fetch;

      const waiting = session.call('wait_for_event', {
        types: ['process.exited'],
        timeout_s: 5,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.last().send({ type: 'process.exited', cursor: 'cur-match', data: { pid: 7 } });
      queueMicrotask(() => {
        for (let i = 0; i < MAX_BUFFERED + 1; i++) {
          events.last().send({ type: 'window.opened', cursor: `cur-survivor-${i}`, data: {} });
        }
      });
      await until(() => release !== undefined);

      hello.ready = true;
      events.last().close();
      await until(() => events.sockets.length === 2 && events.last().greeted);
      events.last().send({ type: 'gap', cursor: 'cur-gap', data: {} });
      release?.();

      const first = dataOf(await waiting);
      globalThis.fetch = normal;
      expect(first.events).toEqual([]);
      expect(first.more_waiting).toBe(MAX_BUFFERED);
      const next = dataOf(
        await session.call('poll_events', { since: first.cursor as string, limit: 500 }),
      );
      expect((next.events as Record<string, unknown>[])[0]).toMatchObject({
        cursor: 'cur-survivor-2',
      });
      expect(next.more_waiting).toBe(MAX_BUFFERED - 500);
    } finally {
      globalThis.fetch = normal;
      await session.close();
    }
  });
});
