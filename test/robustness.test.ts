import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api, filenameFrom } from '../src/api.js';
import { BASE } from './harness.js';

/**
 * The transport's edge cases.
 *
 * Each of these is a shape the platform is allowed to send and this client used
 * to mishandle — a stream framed the other legal way, a filename with a stray
 * percent in it. None of them are hypothetical: they are what a proxy or a
 * guest filesystem produces without anybody deciding to.
 */
describe('the SSE reader', () => {
  let real: typeof globalThis.fetch;
  beforeEach(() => {
    real = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  const streaming = (body: string) => {
    globalThis.fetch = (async () =>
      new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  };

  const collect = async () => {
    const api = new Api('com_test', BASE);
    const events = [];
    for await (const e of api.sse('POST', 'computers/vm-1/agent')) events.push(e);
    return events;
  };

  it('frames a CRLF stream, which the spec allows and proxies emit', async () => {
    // Splitting on "\n\n" alone finds no boundary in "\r\n\r\n", so the whole
    // run used to arrive as one blob, fail to parse, and be reported as a run
    // that ended without a result — having in fact succeeded.
    streaming(
      'event: step\r\ndata: {"n":1}\r\n\r\nevent: done\r\ndata: {"stop":"end_turn"}\r\n\r\n',
    );
    const events = await collect();
    expect(events).toEqual([
      { event: 'step', data: { n: 1 } },
      { event: 'done', data: { stop: 'end_turn' } },
    ]);
  });

  it('still frames the ordinary LF stream', async () => {
    streaming('event: step\ndata: {"n":1}\n\nevent: done\ndata: {"stop":"end_turn"}\n\n');
    const events = await collect();
    expect(events.map((e) => e.event)).toEqual(['step', 'done']);
  });
});

describe('the filename off a download', () => {
  it('reads the encoded form', () => {
    expect(filenameFrom("attachment; filename*=UTF-8''hello%20world.txt")).toBe('hello world.txt');
  });

  it('survives a percent that is not an escape', () => {
    // `100%.txt` is a legal name on a Linux guest. decodeURIComponent throws on
    // it, and that throw used to escape a download whose bytes had already
    // arrived intact — a completed read reported as a failure, over its label.
    expect(() => filenameFrom("attachment; filename*=UTF-8''100%.txt")).not.toThrow();
    expect(filenameFrom("attachment; filename*=UTF-8''%E0%A4%A")).toBe('%E0%A4%A');
  });

  it('falls back to the plain form and to nothing at all', () => {
    expect(filenameFrom('attachment; filename="a.txt"')).toBe('a.txt');
    expect(filenameFrom(null)).toBeUndefined();
  });
});
