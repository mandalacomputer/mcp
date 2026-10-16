import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform } from './harness.js';

let platform: ReturnType<typeof installFakePlatform>;
let conn: Awaited<ReturnType<typeof connect>>;
const path = '/tmp/é & file';
const upload_id = 'a'.repeat(32);
let responseBody: unknown;
let responseStatus: number;
beforeEach(async () => {
  responseBody = { path, upload_id, offset: 3, size: 3, complete: true };
  responseStatus = 200;
  platform = installFakePlatform();
  const record = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await record(...args);
    const call = platform.calls.at(-1)!;
    return new Response(
      JSON.stringify(
        call.method === 'DELETE' && responseStatus === 200 ? { ok: true } : responseBody,
      ),
      { status: responseStatus, headers: { 'Content-Type': 'application/json' } },
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

it('reports partial staging and refuses malformed or unconfirmed publication replies', async () => {
  const args = { path, upload_id, content_base64: 'YWJj', offset: 0, size: 6 };
  responseBody = { path, upload_id, offset: 3, size: 6, complete: false };
  const partial = await conn.call('write_file_chunk', args);
  expect(partial.isError).not.toBe(true);
  expect(JSON.stringify(partial)).toContain('Bytes staged only');
  for (const bad of [
    null,
    { path: '/wrong', upload_id, offset: 3, size: 6, complete: false },
    { path, upload_id, offset: 3, size: 6, complete: true },
    { path, upload_id, offset: 3, size: 3, complete: false },
  ]) {
    responseBody = bad;
    expect((await conn.call('write_file_chunk', args)).isError).toBe(true);
  }
});
it('publishes empty files and accepts normally wrapped maximum chunks', async () => {
  responseBody = { path, upload_id, offset: 0, size: 0, complete: true };
  expect(
    (
      await conn.call('write_file_chunk', {
        path,
        upload_id,
        content_base64: '',
        offset: 0,
        size: 0,
      })
    ).isError,
  ).not.toBe(true);
  const size = 256 * 1024;
  responseBody = { path, upload_id, offset: size, size, complete: true };
  const encoded = Buffer.alloc(size)
    .toString('base64')
    .match(/.{1,76}/g)!
    .join('\n');
  expect(
    (
      await conn.call('write_file_chunk', {
        path,
        upload_id,
        content_base64: encoded,
        offset: 0,
        size,
      })
    ).isError,
  ).not.toBe(true);
});
it('keeps conflicts final and distinguishes no-wake from offset conflicts', async () => {
  responseStatus = 409;
  for (const reason of ['exists', undefined]) {
    responseBody = { error: 'conflict', reason };
    const reply = await conn.call('write_file_chunk', {
      path,
      upload_id,
      content_base64: 'YWJj',
      offset: 0,
      size: 3,
      overwrite: false,
      no_wake: true,
    });
    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply)).toContain('Read get_file_upload');
    expect(JSON.stringify(reply)).not.toContain('was not resumed');
  }
  responseBody = { error: 'not running', reason: 'unavailable' };
  for (const name of ['get_file_upload', 'cancel_file_upload', 'write_file_chunk']) {
    const reply = await conn.call(name, {
      path,
      upload_id,
      no_wake: true,
      ...(name === 'write_file_chunk' ? { content_base64: 'YWJj', offset: 0, size: 3 } : {}),
    });
    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply)).toContain('was not resumed');
  }
});
it('advertises safe status retries and idempotent destructive cleanup', async () => {
  const tools = (await conn.client.listTools()).tools;
  expect(tools.find((t) => t.name === 'get_file_upload')?.annotations).toMatchObject({
    destructiveHint: false,
    idempotentHint: true,
  });
  expect(tools.find((t) => t.name === 'cancel_file_upload')?.annotations).toMatchObject({
    destructiveHint: true,
    idempotentHint: true,
  });
});
