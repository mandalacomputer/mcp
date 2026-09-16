import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIError } from '../src/errors.js';
import { errorMetadata } from '../src/format.js';
import { connect, RETAINED_ID, RETAINED_MANIFEST } from './harness.js';

const originalFetch = globalThis.fetch;
const clients: Awaited<ReturnType<typeof connect>>[] = [];
const prose = (result: CallToolResult) =>
  result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
const blocks = (result: CallToolResult) =>
  result.content.flatMap((item) => {
    if (item.type !== 'text' || !item.text.startsWith('Response metadata:')) return [];
    return [JSON.parse(item.text.split('\n\n')[1])];
  });
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  globalThis.fetch = originalFetch;
});
async function setup(
  body: unknown,
  status = 401,
  headers: ConstructorParameters<typeof Headers>[0] = {},
) {
  globalThis.fetch = vi.fn(async () => Response.json(body, { status, headers }));
  const client = await connect({
    apiKey: 'com_account_sentinel',
    modelKey: 'model-secret-sentinel',
  });
  clients.push(client);
  return client;
}

const paths = [
  {
    tool: 'read_file',
    args: { path: '/tmp/missing' },
    status: 404,
    warning: 'no such file in the guest',
  },
  {
    tool: 'list_directory',
    args: { path: '/tmp' },
    status: 401,
    warning: 'account key or model key',
  },
  { tool: 'get_account', args: {}, status: 401, warning: 'account key or model key' },
  {
    tool: 'get_result',
    args: { result_id: RETAINED_ID },
    status: 401,
    warning: 'No fallback or command replay was attempted',
  },
  {
    tool: 'retain_execution_output',
    args: {
      execution_id: RETAINED_MANIFEST.execution_id,
      max_bytes_per_stream: 8,
      retention_seconds: 86400,
    },
    status: 403,
    warning: 'may have committed',
  },
  {
    tool: 'delete_result',
    args: { result_id: RETAINED_ID },
    status: 403,
    warning: 'may have committed',
  },
  {
    tool: 'get_execution',
    args: { execution_id: RETAINED_MANIFEST.execution_id },
    status: 404,
    warning: 'do not substitute a PID or start the command again',
  },
  {
    tool: 'read_execution_output',
    args: { execution_id: RETAINED_MANIFEST.execution_id, stdout_offset: 0, stderr_offset: 0 },
    status: 401,
    warning: 'No command was replayed',
  },
  {
    tool: 'read_file',
    args: { path: '/tmp/missing', offset: 512 },
    status: 416,
    warning: 'past the end',
  },
  {
    tool: 'window_action',
    args: { window_id: '0x1', action: 'close' },
    status: 504,
    warning: 'Do not send this call again',
  },
];

describe('metadata through registered MCP tools', () => {
  it.each(paths)(
    '$tool preserves diagnostics on HTTP $status and its own safety wording',
    async ({ tool, args, status, warning }) => {
      const client = await setup(
        {
          error: 'no such file in the guest',
          request_id: 'body-id',
          reason: 'future-classification',
          Authorization: 'DO-NOT-ECHO',
          unknown: 'DO-NOT-ECHO',
        },
        status,
        {
          'X-Request-ID': `header-${tool}`,
          Allow: 'GET, HEAD, OPTIONS',
          'WWW-Authenticate': 'Bearer',
          'Retry-After': '2',
          'Content-Range': 'bytes */77',
          'X-Unknown': 'DO-NOT-ECHO',
        },
      );
      const result = await client.call(tool, args);
      expect(result.isError).toBe(true);
      expect(prose(result)).toContain(warning);
      expect(blocks(result)).toContainEqual({
        status,
        reason: 'future-classification',
        request_id: `header-${tool}`,
        allow: 'GET, HEAD, OPTIONS',
        www_authenticate: 'Bearer',
        retry_after_ms: 2000,
      });
      expect(prose(result)).not.toContain('body-id');
      expect(prose(result)).not.toContain('DO-NOT-ECHO');
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    },
  );
  it.each(['GET, HEAD, OPTIONS', 'GET, HEAD, POST, OPTIONS'])(
    'reports the actual Allow through a generic tool: %s',
    async (allow) => {
      const client = await setup({ error: 'method not allowed' }, 405, {
        Allow: allow,
        'X-Request-ID': 'method-id',
      });
      const result = await client.call('read_file', { path: '/tmp/file' });
      expect(result.isError).toBe(true);
      expect(prose(result)).toContain('Do not automatically switch methods');
      expect(blocks(result)[0]).toMatchObject({ status: 405, allow, request_id: 'method-id' });
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    },
  );
  it('keeps an unclassified guest permission failure at HTTP 400', async () => {
    const client = await setup({ error: 'guest permission denied' }, 400, {
      'X-Request-ID': 'permission-id',
    });
    const result = await client.call('read_file', { path: '/tmp/file' });
    expect(prose(result)).toContain('guest permission denied (HTTP 400)');
    expect(prose(result)).not.toContain('no such file');
  });
  it.each(['missing', 'invalid', 'revoked', undefined, 'future-reason'])(
    'uses classified authentication guidance: %s',
    async (reason) => {
      const client = await setup({ error: 'credential refused', reason, request_id: 'auth-id' });
      const result = await client.call('read_file', { path: '/tmp/file' });
      const phrase =
        reason === 'missing'
          ? 'was not supplied'
          : reason === 'invalid'
            ? 'was not accepted'
            : reason === 'revoked'
              ? 'authority was revoked'
              : 'account key or model key';
      expect(prose(result)).toContain(phrase);
      expect(prose(result)).toContain('Do not replay this request unchanged');
      if (reason === 'invalid') expect(prose(result)).not.toContain('revoked');
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    },
  );
  it.each(['preparing', 'copying', 'ready', 'failed', 'unknown'])(
    'retains explicit template continuation rules with diagnostics: %s',
    async (state) => {
      const client = await setup(
        {
          error: 'Image unavailable',
          code: 'template_image_preparing',
          template_transfer: 'opaque-token',
          preparation: { state },
          request_id: 'body-template-id',
        },
        409,
        { 'Retry-After': '7', 'X-Request-ID': 'template-id' },
      );
      const result = await client.call('create_computer', {
        template: 'example/image',
        start: false,
      });
      expect(result.isError).toBe(true);
      expect(prose(result)).toContain(
        'Never automatically replay after a lost or ambiguous response',
      );
      expect(blocks(result)[0]).toMatchObject({ request_id: 'template-id', retry_after_ms: 7000 });
      if (['preparing', 'copying', 'ready'].includes(state))
        expect(prose(result)).toContain('all original identical arguments');
      else expect(prose(result)).toContain('do not automatically wait or retry');
      expect(prose(result)).toContain('opaque-token');
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    },
  );
});

describe('bounded diagnostics and native stream failures', () => {
  it('omits oversized fields rather than publishing a partial method list or challenge', async () => {
    const client = await setup(
      { error: 'refused', reason: 'r'.repeat(129), request_id: 'i'.repeat(257) },
      405,
      { Allow: 'A'.repeat(513), 'WWW-Authenticate': 'B'.repeat(513), 'X-Unknown': 'DO-NOT-ECHO' },
    );
    const result = await client.call('list_directory', { path: '/tmp' });
    expect(prose(result)).toContain('Oversized diagnostic metadata was omitted');
    expect(blocks(result)).toEqual([{ status: 405 }]);
    expect(prose(result)).not.toContain('r'.repeat(129));
    expect(prose(result)).not.toContain('i'.repeat(257));
    expect(prose(result)).not.toContain('A'.repeat(513));
    expect(prose(result)).not.toContain('B'.repeat(513));
    expect(prose(result)).not.toContain('DO-NOT-ECHO');
  });
  it('keeps exact field limits, ignores nonscalars and leaves the underlying error intact', () => {
    const error = new APIError(
      'refused',
      401,
      { reason: 'r'.repeat(128), request_id: 'i'.repeat(256) },
      42,
      { allow: 'A'.repeat(512), wwwAuthenticate: 'B'.repeat(512) },
    );
    expect(errorMetadata(error).omitted).toBe(false);
    expect(errorMetadata(error).fields.request_id).toHaveLength(256);
    expect(error.reason).toHaveLength(128);
    expect(
      errorMetadata({
        reason: {},
        request_id: [],
        allow: 5,
        www_authenticate: null,
        status: Number.NaN,
        retry_after_ms: Number.POSITIVE_INFINITY,
      }).fields,
    ).toEqual({});
  });
  it.each(['missing', 'invalid', 'revoked', undefined, 'starting'])(
    'keeps native 401 reason %s without blaming an unclassified account key or replaying',
    async (reason) => {
      const client = await setup({});
      const frame = {
        error: 'credential refused',
        status: 401,
        reason,
        request_id: 'native-id',
        steps: 1,
        usage: { input_tokens: 3 },
        Authorization: 'DO-NOT-ECHO',
      };
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            `event: step\ndata: {"n":1,"detail":"clicked once"}\n\nevent: error\ndata: ${JSON.stringify(frame)}\n\n`,
            {
              headers: {
                'Content-Type': 'text/event-stream',
                'X-Request-ID': 'outer-stream-id',
                'WWW-Authenticate': 'Bearer',
                'Retry-After': '55',
              },
            },
          ),
      );
      const result = await client.call('run_agent', { prompt: 'finish' });
      expect(result.isError).toBe(true);
      expect(prose(result)).toContain('clicked once');
      expect(prose(result)).toContain('input_tokens');
      expect(prose(result)).toContain('Do NOT call run_agent again with the same prompt');
      expect(blocks(result)[0]).toEqual({
        status: 401,
        ...(reason ? { reason } : {}),
        request_id: 'native-id',
      });
      if (!reason || reason === 'starting')
        expect(prose(result)).toContain('account key or model key');
      expect(prose(result)).not.toContain('worth sending again');
      expect(prose(result)).not.toContain('outer-stream-id');
      expect(prose(result)).not.toContain('DO-NOT-ECHO');
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([429, 504, 520])(
    'does not convert an in-band %i into HTTP retry advice',
    async (status) => {
      const client = await setup({});
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            `event: error\ndata: ${JSON.stringify({ status, error: { message: 'partial run stopped', reason: 'starting' }, request_id: 'event-id' })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream', 'Retry-After': '30' } },
          ),
      );
      const result = await client.call('run_agent', { prompt: 'finish' });
      expect(result.isError).toBe(true);
      expect(prose(result)).toContain('partial run stopped');
      expect(blocks(result)[0]).toEqual({ status, reason: 'starting', request_id: 'event-id' });
      expect(prose(result)).not.toMatch(/worth sending again|retry_after_ms|gateway|proxy/);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    },
  );
  it('redacts echoed account and model keys in native diagnostic fields', async () => {
    const client = await setup({});
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          `event: error\ndata: ${JSON.stringify({ error: 'failed', status: 401, reason: 'com_account_sentinel', request_id: 'model-secret-sentinel' })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    );
    const result = await client.call('run_agent', { prompt: 'finish' });
    expect(prose(result)).not.toContain('com_account_sentinel');
    expect(prose(result)).not.toContain('model-secret-sentinel');
    expect(prose(result)).toContain('[redacted]');
  });
});
