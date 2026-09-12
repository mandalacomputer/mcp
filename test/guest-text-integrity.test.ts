import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, download } from './harness.js';

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const bodyOf = (res: CallToolResult) => {
  const text = textOf(res);
  return JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>;
};

const b64 = (bytes: string | number[]) =>
  Buffer.from(typeof bytes === 'string' ? bytes : Uint8Array.from(bytes)).toString('base64');

describe('guest text keeps every valid UTF-8 character', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  const serveFile = (content: string | Uint8Array) => {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) =>
      download(content, new Headers(init?.headers).get('range') ?? undefined)) as typeof fetch;
  };

  it('keeps U+FEFF at the beginning of a complete file', async () => {
    serveFile('\ufeffhello');
    const { call, close } = await connect();
    const result = await call('read_file', { path: '/tmp/text.txt' });
    await close();

    expect(textOf(result)).toContain('\n\n\ufeffhello');
  });

  it('keeps U+FEFF when a file page begins after a nonzero byte offset', async () => {
    serveFile('x\ufeffhello');
    const { call, close } = await connect();
    const result = await call('read_file', { path: '/tmp/text.txt', offset: 1 });
    await close();

    expect(textOf(result)).toContain('\n\n\ufeffhello');
    expect(textOf(result)).toContain('bytes 1-8 of 9');
  });

  it('keeps U+FEFF at the beginning of continued command output', async () => {
    const output = '\ufeffhello';
    globalThis.fetch = (async () =>
      Response.json({
        pid: 4242,
        running: false,
        exited: true,
        exit_code: 0,
        stdout_b64: b64(output),
        stdout_offset: Buffer.byteLength(`x${output}`),
      })) as typeof fetch;
    const { call, close } = await connect();
    const result = await call('exec_poll', { pid: 4242 });
    await close();

    expect(bodyOf(result).stdout).toBe(output);
  });

  it('still preserves invalid UTF-8 and invalid base64 as unread output', async () => {
    const bytes = [0xff, 0x41];
    serveFile(Uint8Array.from(bytes));
    const first = await connect();
    const file = await first.call('read_file', { path: '/tmp/bytes.bin' });
    await first.close();
    expect(textOf(file)).toContain(`Base64:\n\n${b64(bytes)}`);

    globalThis.fetch = (async () =>
      Response.json({ pid: 4242, running: false, stdout_b64: 'not base64 !!!' })) as typeof fetch;
    const second = await connect();
    const output = await second.call('exec_poll', { pid: 4242 });
    await second.close();
    expect(bodyOf(output).stdout_b64).toBe('not base64 !!!');
    expect(textOf(output)).toContain('did not decode as base64');
  });

  it('still marks and names a UTF-8 character cut at a chunk boundary', async () => {
    globalThis.fetch = (async () =>
      Response.json({
        pid: 4242,
        running: true,
        more: true,
        stdout_b64: b64([0x61, 0xf0, 0x9f]),
        stdout_offset: 3,
      })) as typeof fetch;
    const { call, close } = await connect();
    const result = await call('exec_poll', { pid: 4242 });
    await close();

    expect(bodyOf(result).stdout).toBe('a\ufffd');
    expect(textOf(result)).toContain('f0 9f');
  });
});
