import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from './harness.js';

const TOOL = 'move_computer_to_workspace';
const DEST = 'wsp-0123456789ab';
const textOf = (result: CallToolResult) => JSON.stringify(result.content);
const computer = (workspace: unknown = DEST) => ({
  computer: {
    id: 'vm-2',
    workspace_id: workspace,
    vnc: { url: 'SECRET-CONNECTION' },
    guest_password: 'SECRET-PASSWORD',
  },
});
function platform(body: unknown = computer(), status = 200) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe('explicit workspace assignment', () => {
  it.each([DEST, null])(
    'sends one explicit PUT for %s and returns only confirmed membership',
    async (workspace_id) => {
      const fetch = platform(computer(workspace_id));
      const { call, close } = await connect({
        computerId: 'vm-other',
        defaultWorkspace: { id: 'wsp-ffffffffffff', name: 'default' },
      });
      try {
        const result = await call(TOOL, { computer_id: 'vm-2', workspace_id });
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('vm-2');
        expect(textOf(result)).not.toContain('SECRET');
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(String(url)).toBe('https://api.test/api/v1/computers/vm-2/workspace');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body as string)).toEqual({ workspace_id });
        expect(new Headers(init.headers).has('Idempotency-Key')).toBe(false);
      } finally {
        await close();
      }
    },
  );

  it.each([
    {},
    { workspace_id: DEST },
    { computer_id: 'vm-2' },
    { computer_id: '', workspace_id: DEST },
    { computer_id: '../vm-2', workspace_id: DEST },
    ...[
      '',
      'unassigned',
      'wsp-X123456789ab',
      'wsp-0123456789ab ',
      'wsp-0123456789ab\n',
      false,
      0,
    ].map((workspace_id) => ({ computer_id: 'vm-2', workspace_id })),
  ])('rejects missing or malformed arguments without a request: %j', async (args) => {
    const fetch = platform();
    const { call, close } = await connect();
    try {
      expect((await call(TOOL, args)).isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it.each([403, 409, 503])('preserves a %i refusal without stop/delete/retry', async (status) => {
    const fetch = platform(
      { error: 'Workspace move refused: snapshots remain', reason: 'snapshot_history' },
      status,
    );
    const { call, close } = await connect();
    try {
      const result = await call(TOOL, { computer_id: 'vm-2', workspace_id: DEST });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('snapshots remain');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it.each([
    null,
    [],
    {},
    { id: 'vm-2', workspace_id: DEST },
    { computer: [] },
    { computer: { id: 'other', workspace_id: DEST } },
    computer('wsp-ffffffffffff'),
    computer(null),
  ])('does not claim an unconfirmed response succeeded: %j', async (body) => {
    platform(body);
    const { call, close } = await connect();
    try {
      const result = await call(TOOL, { computer_id: 'vm-2', workspace_id: DEST });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('could not be confirmed');
    } finally {
      await close();
    }
  });

  it.each([null, '', undefined, false, 0])(
    'accepts only real unassigned representations: %s',
    async (value) => {
      const body = value === undefined ? { computer: { id: 'vm-2' } } : computer(value);
      platform(body);
      const { call, close } = await connect();
      try {
        const result = await call(TOOL, { computer_id: 'vm-2', workspace_id: null });
        expect(Boolean(result.isError)).toBe(value === false || value === 0);
      } finally {
        await close();
      }
    },
  );

  it('does not report an accepted but unfinished move as complete', async () => {
    platform(computer(), 202);
    const { call, close } = await connect();
    try {
      expect((await call(TOOL, { computer_id: 'vm-2', workspace_id: DEST })).isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('withholds workspace mutations from read-only clients', async () => {
    const { client, close } = await connect({ readOnly: true });
    try {
      expect((await client.listTools()).tools.some((t) => t.name === TOOL)).toBe(false);
    } finally {
      await close();
    }
  });

  it('advertises explicit required inputs and mutation hints even when create/delete are disabled', async () => {
    const { client, close } = await connect({ lifecycle: false });
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === TOOL)!;
      expect(tool.inputSchema.required).toEqual(['computer_id', 'workspace_id']);
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    } finally {
      await close();
    }
  });
});
