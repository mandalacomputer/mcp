import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

let platform: ReturnType<typeof installFakePlatform>;
let conn: Awaited<ReturnType<typeof connect>>;
const path = '/tmp/é & file';
const upload_id = 'a'.repeat(32);
beforeEach(async () => {
  platform = installFakePlatform();
  const record = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await record(...args);
    const call = platform.calls.at(-1)!;
    return new Response(
      JSON.stringify(
        call.method === 'DELETE'
          ? { ok: true }
          : { path, upload_id, offset: 3, size: 3, complete: true },
      ),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  conn = await connect({ apiKey: 'com_test' });
});
afterEach(async () => {
  await conn.close();
  platform.restore();
});
describe('resumable upload tools', () => {
  it('sends binary chunks, exposes status and cancels only staging', async () => {
    for (const name of ['write_file_chunk', 'get_file_upload', 'cancel_file_upload']) {
      const result = await conn.call(name, {
        path,
        upload_id,
        no_wake: true,
        ...(name === 'write_file_chunk'
          ? { content_base64: 'AP8B', offset: 0, size: 3, overwrite: false }
          : {}),
      });
      expect(result.isError).not.toBe(true);
      const call = platform.calls.at(-1)!;
      expect(call.path).toBe('/computers/vm-1/files/uploads');
      expect(call.query.get('path')).toBe(path);
      expect(call.query.get('no_wake')).toBe('1');
      if (name === 'write_file_chunk') expect(call.query.get('overwrite')).toBe('false');
    }
    const tools = (await conn.client.listTools()).tools;
    expect(tools.find((t) => t.name === 'get_file_upload')?.annotations?.readOnlyHint).not.toBe(
      true,
    );
  });
  it('refuses corrupt bytes, oversized chunks and invalid ranges before dispatch', async () => {
    for (const args of [
      { content_base64: '%%%' },
      { content_base64: Buffer.alloc(256 * 1024 + 1).toString('base64') },
      { offset: 3 },
    ]) {
      const before = platform.calls.length;
      const result = await conn.call('write_file_chunk', {
        path,
        upload_id,
        content_base64: 'AP8B',
        offset: 0,
        size: 3,
        ...args,
      });
      expect(result.isError).toBe(true);
      expect(platform.calls).toHaveLength(before);
    }
  });
});
