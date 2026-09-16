import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/server.js';
import { connect } from './harness.js';

const ID = 'exec_0123456789abcdef0123456789abcdef';
const metadata = {
  execution_id: ID,
  computer_id: 'vm-1',
  pid: 4242,
  status: 'running',
  started_at: '2026-09-15T12:00:00Z',
  output_source: 'volatile_guest_files',
};
const output = {
  execution_id: ID,
  stdout_b64: 'aGk=',
  stderr_b64: '',
  stdout_offset: 2,
  stderr_offset: 0,
  stdout_more: false,
  stderr_more: false,
  diagnostic_b64: '',
  diagnostic_truncated: false,
};
const OTHER = 'exec_ffffffffffffffffffffffffffffffff';
const zero = { execution_id: ID, stdout_offset: 0, stderr_offset: 0 };
const textOf = (result: CallToolResult) =>
  result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
const bodyOf = (result: CallToolResult): Record<string, unknown> => {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf('{')));
};
const realFetch = globalThis.fetch;
const clients: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  globalThis.fetch = realFetch;
});
const setup = async (body: unknown = metadata, status = 200, cfg: Partial<ServerConfig> = {}) => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return typeof body === 'function'
      ? body(new URL(String(input)), init)
      : Response.json(body, { status });
  }) as typeof fetch;
  const client = await connect(cfg);
  clients.push(client);
  return { ...client, calls };
};

describe('stable execution tools', () => {
  it('registers both non-consuming read tools with explicit annotations', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    for (const name of ['get_execution', 'read_execution_output']) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
    expect(tools.find((tool) => tool.name === 'exec_poll')?.annotations?.readOnlyHint).toBeFalsy();
  });

  it('reads stable output once at explicit independent offsets', async () => {
    const { call, calls } = await setup(output);
    const result = await call('read_execution_output', {
      execution_id: ID,
      stdout_offset: 0,
      stderr_offset: 0,
    });
    expect(result.isError).toBeFalsy();
    expect(bodyOf(result)).toMatchObject({
      execution_id: ID,
      stdout: 'hi',
      stdout_offset: 2,
      stderr_offset: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe(`/api/v1/computers/vm-1/executions/${ID}/output`);
  });

  it('directs an accepted stable command to the new read tools', async () => {
    const { call } = await setup({
      pid: 4242,
      running: true,
      execution_id: ID,
      stdout_b64: '',
      stderr_b64: '',
    });
    const result = await call('exec', { command: 'printf hi', background: true });
    expect(result.isError).toBeFalsy();
    expect(bodyOf(result).execution_id).toBe(ID);
    expect(textOf(result)).toContain('get_execution');
    expect(textOf(result)).toContain('read_execution_output');
  });

  it('does not echo a malformed accepted ID or suggest replaying the command', async () => {
    const secret = 'PRIVATE-MALFORMED-IDENTITY';
    const { call, calls } = await setup({
      pid: 4242,
      running: true,
      execution_id: secret,
      stdout_b64: '',
      stderr_b64: '',
    });
    const result = await call('exec', { command: 'printf hi', background: true });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain(secret);
    expect(bodyOf(result).execution_id).toBeUndefined();
    expect(textOf(result)).toMatch(/accepted|Started/);
    expect(textOf(result)).toMatch(/not (?:rerun|replay)/i);
    expect(calls).toHaveLength(1);
  });
});

describe('finite execution observations', () => {
  it.each(['running', 'lost', 'exited'])(
    'preserves last-observed %s without raw fields',
    async (status) => {
      const ended = { ended_at: '2026-09-15T12:00:01.123456789Z', exit_code: -9 };
      const { call, calls } = await setup({
        ...metadata,
        status,
        ...(status === 'exited' ? ended : {}),
        command: 'PRIVATE-COMMAND',
        error: 'PRIVATE-ERROR',
        extra: { token: 'PRIVATE-TOKEN' },
      });
      const result = await call('get_execution', { execution_id: ID });
      expect(result.isError).toBeFalsy();
      expect(bodyOf(result)).toEqual({
        ...metadata,
        status,
        ...(status === 'exited' ? ended : {}),
      });
      expect(textOf(result)).not.toContain('PRIVATE-');
      expect(calls).toHaveLength(1);
    },
  );

  it('uses explicit computer identity and leaves the selected default unchanged', async () => {
    const { call, calls } = await setup((url: URL) =>
      Response.json({
        ...metadata,
        computer_id: url.pathname.includes('/vm-other/') ? 'vm-other' : 'vm-1',
      }),
    );
    expect(
      (await call('get_execution', { execution_id: ID, computer_id: 'vm-other' })).isError,
    ).toBeFalsy();
    expect((await call('get_execution', { execution_id: ID })).isError).toBeFalsy();
    expect(calls.map((entry) => entry.url.pathname)).toEqual([
      `/api/v1/computers/vm-other/executions/${ID}`,
      `/api/v1/computers/vm-1/executions/${ID}`,
    ]);
  });

  it.each([
    ['identity', { execution_id: OTHER }],
    ['computer', { computer_id: 'PRIVATE-WRONG-COMPUTER' }],
    ['missing ID', { execution_id: undefined }],
    ['pid', { pid: 0 }],
    ['unsafe pid', { pid: 9007199254740992 }],
    ['string pid', { pid: '4242' }],
    ['status', { status: 'PRIVATE-INVALID-STATUS' }],
    ['date', { started_at: 'PRIVATE-BAD-DATE' }],
    ['newline date', { started_at: '2026-09-15T12:00:00Z\n' }],
    ['calendar', { started_at: '2026-02-30T12:00:00Z' }],
    ['time', { started_at: '2026-09-15T24:00:00Z' }],
    ['output source', { output_source: 'retained' }],
    ['missing exit', { status: 'exited' }],
    ['unsigned evidence', { status: 'exited', ended_at: '2026-09-15T12:00:01Z', exit_code: '0' }],
    ['fractional exit', { status: 'exited', ended_at: '2026-09-15T12:00:01Z', exit_code: 1.5 }],
    ['running exit', { exit_code: 0 }],
    ['lost exit', { status: 'lost', ended_at: null }],
  ])('refuses %s evidence without exposing payloads', async (_name, patch) => {
    const { call, calls } = await setup({ ...metadata, ...(patch as object) });
    const result = await call('get_execution', { execution_id: ID });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('PRIVATE-');
    expect(calls).toHaveLength(1);
  });

  it.each([
    undefined,
    null,
    '',
    '42',
    `exec_${'A'.repeat(32)}`,
    `${ID}\n`,
    `${ID}/output`,
    {},
    '..',
  ])('refuses a noncanonical request identity before HTTP', async (execution_id) => {
    const { call, calls } = await setup();
    for (const tool of ['get_execution', 'read_execution_output']) {
      expect((await call(tool, { ...zero, execution_id })).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('does not fetch when no computer is selected or when its identity is unbounded', async () => {
    const { call, calls } = await setup(metadata, 200, { computerId: undefined });
    expect((await call('get_execution', { execution_id: ID })).isError).toBe(true);
    expect(
      (await call('get_execution', { execution_id: ID, computer_id: 'x'.repeat(257) })).isError,
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('lossless bounded output', () => {
  it.each([
    ['text', Buffer.from(' hello\n'), true],
    ['BOM', Buffer.from('\ufeffhello'), true],
    ['NUL', Buffer.from([0, 65]), false],
    ['binary', Buffer.from([255, 65]), false],
    ['split head', Buffer.from([0xe2]), false],
    ['split tail', Buffer.from([0x82, 0xac]), false],
    ['control', Buffer.from([1]), false],
  ] as const)('preserves %s bytes entirely', async (_name, bytes, asText) => {
    const { call } = await setup({
      ...output,
      stdout_b64: bytes.toString('base64'),
      stdout_offset: bytes.length,
    });
    const result = await call('read_execution_output', zero);
    expect(result.isError).toBeFalsy();
    const body = bodyOf(result);
    expect(body.stdout_bytes).toBe(bytes.length);
    expect(body.stdout_offset).toBe(bytes.length);
    if (asText) {
      expect(body.stdout).toBe(bytes.toString('utf8'));
      expect(body.stdout_b64).toBeUndefined();
    } else {
      expect(body.stdout_b64).toBe(bytes.toString('base64'));
      expect(body.stdout).toBeUndefined();
    }
  });

  it('keeps two readers independent of a consuming PID poll and repeated diagnostics', async () => {
    let legacy = false;
    const { call, calls } = await setup((url: URL) => {
      if (url.pathname.endsWith('/exec/4242')) {
        const answer = {
          pid: 4242,
          running: false,
          exit_code: 0,
          execution_id: OTHER,
          stdout_b64: legacy ? '' : 'aGk=',
          stderr_b64: legacy ? '' : 'ZGlhZw==',
        };
        legacy = true;
        return Response.json(answer);
      }
      return Response.json({ ...output, diagnostic_b64: 'ZGlhZw==' });
    });
    const first = bodyOf(await call('read_execution_output', zero));
    const polled = bodyOf(await call('exec_poll', { pid: 4242 }));
    const second = bodyOf(await call('read_execution_output', zero));
    const drained = bodyOf(await call('exec_poll', { pid: 4242 }));
    expect(second).toEqual(first);
    expect(first.stdout).toBe('hi');
    expect(first.diagnostic).toBe('diag');
    expect(polled.stdout).toBe('hi');
    expect(polled.stderr).toBe('diag');
    expect(polled.execution_id).toBeUndefined();
    expect(drained.stdout).toBe('');
    expect(drained.stderr).toBe('');
    expect(calls.map((entry) => entry.url.pathname)).toEqual([
      `/api/v1/computers/vm-1/executions/${ID}/output`,
      '/api/v1/computers/vm-1/exec/4242',
      `/api/v1/computers/vm-1/executions/${ID}/output`,
      '/api/v1/computers/vm-1/exec/4242',
    ]);
    expect(
      calls
        .filter((entry) => entry.url.pathname.endsWith('/output'))
        .map((entry) => Object.fromEntries(entry.url.searchParams)),
    ).toEqual([
      { stdout_offset: '0', stderr_offset: '0', limit: '4096' },
      { stdout_offset: '0', stderr_offset: '0', limit: '4096' },
    ]);
  });

  it('reports current EOF with unchanged nonzero offsets, then accepts later bytes', async () => {
    let later = false;
    const { call } = await setup(() => {
      const answer = {
        ...output,
        stdout_b64: later ? 'YQ==' : '',
        stdout_offset: later ? 101 : 100,
        stderr_offset: 20,
      };
      later = true;
      return Response.json(answer);
    });
    const args = { execution_id: ID, stdout_offset: 100, stderr_offset: 20 };
    expect(bodyOf(await call('read_execution_output', args))).toMatchObject({
      stdout: '',
      stdout_offset: 100,
      stdout_more: false,
    });
    expect(bodyOf(await call('read_execution_output', args))).toMatchObject({
      stdout: 'a',
      stdout_offset: 101,
    });
  });

  it.each([false, true])(
    'reports diagnostic display truncation independently of daemon truncation %s',
    async (remoteTruncated) => {
      const diagnostic = Buffer.concat([Buffer.alloc(4095, 65), Buffer.from('€tail')]);
      const { call } = await setup({
        ...output,
        diagnostic_b64: diagnostic.toString('base64'),
        diagnostic_truncated: remoteTruncated,
      });
      const result = await call('read_execution_output', zero);
      const body = bodyOf(result);
      expect(body.diagnostic).toBeUndefined();
      expect(body.diagnostic_b64).toBe(diagnostic.subarray(0, 4096).toString('base64'));
      expect(body).toMatchObject({
        diagnostic_available_bytes: diagnostic.length,
        diagnostic_displayed_bytes: 4096,
        diagnostic_display_truncated: true,
        diagnostic_truncated: remoteTruncated,
        stdout_offset: 2,
        stderr_offset: 0,
      });
      expect(textOf(result)).toMatch(
        /truncated display is only a prefix of the available diagnostic/,
      );
    },
  );

  it.each(['text', 'binary', 'escaped'])(
    'bounds maximum %s presentation and drops unexpected content',
    async (kind) => {
      const byte = kind === 'text' ? 65 : kind === 'binary' ? 0 : 34;
      const stream = Buffer.alloc(16384, byte);
      const diagnostic = Buffer.alloc(65536, byte);
      const { call } = await setup({
        ...output,
        stdout_b64: stream.toString('base64'),
        stderr_b64: stream.toString('base64'),
        stdout_offset: stream.length,
        stderr_offset: stream.length,
        stdout_more: true,
        stderr_more: true,
        diagnostic_b64: diagnostic.toString('base64'),
        diagnostic_truncated: true,
        secret: 'PRIVATE-UNEXPECTED'.repeat(20000),
      });
      const result = await call('read_execution_output', { ...zero, limit: 16384 });
      expect(result.isError).toBeFalsy();
      const body = bodyOf(result);
      expect(body).toMatchObject({
        stdout_bytes: 16384,
        stderr_bytes: 16384,
        diagnostic_available_bytes: 65536,
        diagnostic_displayed_bytes: 4096,
      });
      const displayed =
        typeof body.stdout === 'string'
          ? Buffer.from(body.stdout)
          : Buffer.from(body.stdout_b64 as string, 'base64');
      expect(displayed.equals(stream)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(256 * 1024);
      expect(textOf(result)).not.toContain('PRIVATE-');
    },
  );

  it.each([
    ['missing stdout', { stdout_offset: undefined }],
    ['missing stderr', { stderr_offset: undefined }],
    ['negative', { stdout_offset: -1 }],
    ['fraction', { stderr_offset: 0.5 }],
    ['string', { stdout_offset: '0' }],
    ['null', { stdout_offset: null }],
    ['unsafe sum', { stdout_offset: Number.MAX_SAFE_INTEGER }],
    ['default sum', { stderr_offset: Number.MAX_SAFE_INTEGER - 4095 }],
    ['zero limit', { limit: 0 }],
    ['large limit', { limit: 16385 }],
    ['fraction limit', { limit: 1.5 }],
    ['string limit', { limit: '1' }],
  ])('refuses invalid %s before HTTP', async (_name, patch) => {
    const { call, calls } = await setup(output);
    expect((await call('read_execution_output', { ...zero, ...(patch as object) })).isError).toBe(
      true,
    );
    expect(calls).toHaveLength(0);
  });

  it('allows a one-byte read to reach exactly the maximum safe offset', async () => {
    const { call } = await setup({
      ...output,
      stdout_b64: 'AA==',
      stdout_offset: Number.MAX_SAFE_INTEGER,
    });
    const result = await call('read_execution_output', {
      ...zero,
      stdout_offset: Number.MAX_SAFE_INTEGER - 1,
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(bodyOf(result)).toMatchObject({
      stdout_b64: 'AA==',
      stdout_offset: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each([
    ['wrong identity', { execution_id: OTHER }],
    ['missing identity', { execution_id: undefined }],
    ['missing stdout', { stdout_b64: undefined }],
    ['invalid b64', { stdout_b64: 'PRIVATE-INVALID' }],
    ['unpadding', { stdout_b64: 'aGk' }],
    ['whitespace', { stdout_b64: 'aGk=\n' }],
    ['pad bits', { stdout_b64: 'aGl=' }],
    ['diagnostic pad bits', { diagnostic_b64: 'AB==' }],
    ['urlsafe', { stderr_b64: '_w==' }],
    ['wrong stdout offset', { stdout_offset: 0 }],
    ['wrong stderr offset', { stderr_offset: 1 }],
    ['string offset', { stdout_offset: '2' }],
    ['unsafe offset', { stdout_offset: 9007199254740992 }],
    ['string more', { stdout_more: 'false' }],
    ['short more', { stdout_more: true }],
    ['missing more', { stderr_more: undefined }],
    ['missing diagnostic', { diagnostic_b64: undefined }],
    ['invalid truncation', { diagnostic_truncated: 1 }],
  ])('refuses %s output evidence without secret echo or cursor invention', async (_name, patch) => {
    const { call, calls } = await setup({ ...output, ...(patch as object) });
    const result = await call('read_execution_output', zero);
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('PRIVATE-');
    expect(calls).toHaveLength(1);
  });

  it('refuses oversized stream or diagnostic rather than silently trimming its cursor', async () => {
    for (const payload of [
      { ...output, stdout_b64: Buffer.alloc(4097).toString('base64'), stdout_offset: 4097 },
      { ...output, diagnostic_b64: Buffer.alloc(65537).toString('base64') },
    ]) {
      const { call } = await setup(payload);
      expect((await call('read_execution_output', zero)).isError).toBe(true);
    }
  });
});

describe('authority and transport boundaries', () => {
  it.each([401, 403, 404, 409, 429, 503])(
    'preserves HTTP %i without exposing raw error or replay advice',
    async (status) => {
      const { call, calls } = await setup(
        { error: 'PRIVATE-SERVER-ERROR', detail: 'PRIVATE-DETAIL', token: 'PRIVATE-TOKEN' },
        status,
      );
      for (const tool of ['get_execution', 'read_execution_output']) {
        const result = await call(tool, zero);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`HTTP ${status}`);
        expect(textOf(result)).not.toContain('PRIVATE-');
      }
      expect(calls).toHaveLength(2);
      expect(
        calls.every(
          (entry) => entry.init?.method === 'GET' && entry.url.pathname.includes('/executions/'),
        ),
      ).toBe(true);
    },
  );

  it.each([null, [], 'PRIVATE-NOT-OBJECT', {}])(
    'refuses malformed successes through actual tools',
    async (body) => {
      const { call } = await setup(body);
      for (const tool of ['get_execution', 'read_execution_output']) {
        const result = await call(tool, zero);
        expect(result.isError).toBe(true);
        expect(textOf(result)).not.toContain('PRIVATE-');
      }
    },
  );

  it('preserves configured URL prefixes and auth; does not follow an arbitrary redirect', async () => {
    const { call, calls } = await setup(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://other.invalid/PRIVATE-LOCATION' },
        }),
      200,
      { baseUrl: 'https://api.test/custom/api/v1', apiKey: 'com_fake' },
    );
    const result = await call('read_execution_output', {
      ...zero,
      stdout_offset: 7,
      stderr_offset: 9,
      limit: 3,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('HTTP 302');
    expect(textOf(result)).not.toContain('PRIVATE-LOCATION');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.toString()).toBe(
      `https://api.test/custom/api/v1/computers/vm-1/executions/${ID}/output?stdout_offset=7&stderr_offset=9&limit=3`,
    );
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer com_fake');
    expect(calls[0]?.init?.redirect).toBe('manual');
  });

  it.each(['get_execution', 'read_execution_output'])(
    'propagates cancellation into one %s HTTP call',
    async (tool) => {
      let announce!: () => void;
      let stopped!: () => void;
      const entered = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const aborted = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      const { client, calls } = await setup((_url: URL, init?: RequestInit) => {
        announce();
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => {
              stopped();
              reject(init.signal?.reason);
            },
            { once: true },
          ),
        );
      });
      const controller = new AbortController();
      const pending = client.callTool({ name: tool, arguments: zero }, undefined, {
        signal: controller.signal,
      });
      await entered;
      controller.abort();
      await expect(pending).rejects.toThrow();
      await aborted;
      expect(calls).toHaveLength(1);
    },
  );

  it('never promotes a reused or reconstructed PID identity; older replies stay usable', async () => {
    for (const execution_id of [undefined, OTHER, 'PRIVATE-BAD-ID']) {
      const { call, calls } = await setup({
        pid: 4242,
        running: false,
        exit_code: -9,
        stdout_b64: 'aGk=',
        stderr_b64: 'ZGlhZw==',
        ...(execution_id === undefined ? {} : { execution_id }),
      });
      for (const tool of ['exec_poll', 'exec_kill']) {
        const result = await call(tool, { pid: 4242 });
        expect(result.isError).toBeFalsy();
        expect(bodyOf(result)).toMatchObject({ pid: 4242, stdout: 'hi', stderr: 'diag' });
        expect(bodyOf(result).execution_id).toBeUndefined();
        expect(textOf(result)).not.toContain('PRIVATE-');
      }
      expect(calls).toHaveLength(2);
    }
  });

  it('preserves an accepted command on older platforms without inventing stable identity', async () => {
    const { call } = await setup({ pid: 4242, running: true, stdout_b64: '', stderr_b64: '' });
    const result = await call('exec', { command: 'true', background: true });
    expect(result.isError).toBeFalsy();
    expect(bodyOf(result).execution_id).toBeUndefined();
    expect(textOf(result)).toContain('Started as pid 4242');
    expect(textOf(result)).not.toContain('read_execution_output');
  });
});
