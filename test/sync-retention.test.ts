import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, expect, it, vi } from 'vitest';
import { synchronousResultId } from '../src/results.js';
import { connect, RETAINED_ID } from './harness.js';

const original = globalThis.fetch,
  clients: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  globalThis.fetch = original;
});
const source = {
  exit_code: -1,
  timed_out: false,
  out_truncated: false,
  err_truncated: false,
  stdout_b64: 'AP8=',
  stderr_b64: '',
  result_id: RETAINED_ID,
};
const text = (r: CallToolResult) =>
  r.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
const data = (r: CallToolResult) => JSON.parse(text(r).slice(text(r).indexOf('{')));
async function setup(reply = source, status = 200) {
  const calls: RequestInit[] = [];
  globalThis.fetch = vi.fn(async (_input, init) => {
    calls.push(init!);
    return Response.json(reply, { status });
  });
  const c = await connect();
  clients.push(c);
  return { ...c, calls };
}
it.each([undefined, false])(
  'preserves default wire/presentation without exposing raw result_id (%s)',
  async (retain_output) => {
    const c = await setup();
    const r = await c.call('exec', {
      command: 'true',
      ...(retain_output === undefined ? {} : { retain_output }),
    });
    expect(r.isError).toBeFalsy();
    expect(data(r).result_id).toBeUndefined();
    expect(JSON.parse(c.calls[0].body as string)).toEqual({ command: 'true', timeout_s: 30 });
  },
);
it.each([true, {}, { max_bytes_per_stream: 1, retention_seconds: 1 }])(
  'exposes only confirmed opt-in identity without replay (%j)',
  async (retain_output) => {
    const c = await setup();
    const r = await c.call('exec', { command: 'true', retain_output });
    expect(data(r)).toMatchObject({ result_id: RETAINED_ID, exit_code: -1, stdout_b64: 'AP8=' });
    expect(JSON.parse(c.calls[0].body as string)).toMatchObject({ retain_output });
    expect(c.calls).toHaveLength(1);
    expect(text(r)).toContain('separate explicit read');
  },
);
it.each([null, 1, [], { extra: 1 }, { max_bytes_per_stream: null }, { retention_seconds: 0 }])(
  'rejects invalid opt-in before command dispatch: %j',
  async (retain_output) => {
    const c = await setup();
    expect((await c.call('exec', { command: 'true', retain_output })).isError).toBe(true);
    expect(c.calls).toHaveLength(0);
  },
);
it('rejects background capture combination without changing legacy background result identity', async () => {
  const c = await setup({
    ...source,
    pid: 42,
    execution_id: 'exec_0123456789abcdef0123456789abcdef',
  } as typeof source);
  expect(
    (await c.call('exec', { command: 'true', background: true, retain_output: true })).isError,
  ).toBe(true);
  expect(c.calls).toHaveLength(0);
  const r = await c.call('exec', { command: 'true', background: true });
  expect(data(r).result_id).toBeUndefined();
  expect(data(r).execution_id).toMatch(/^exec_/);
});
it.each([
  { result_id: undefined },
  { result_id: 'PRIVATE' },
  { timed_out: true },
  { exit_code: 2147483648 },
  { out_truncated: undefined },
])(
  'ignores malformed optional response metadata without failing executed command: %j',
  async (bad) => {
    const c = await setup({ ...source, ...bad } as typeof source);
    const r = await c.call('exec', { command: 'true', retain_output: true });
    expect(r.isError).toBeFalsy();
    expect(data(r).result_id).toBeUndefined();
    expect(text(r)).not.toContain('PRIVATE');
    expect(text(r)).toContain('Do not replay');
    expect(c.calls).toHaveLength(1);
  },
);
it('never confirms a valid-looking result ID from HTTP202', async () => {
  const c = await setup(source, 202);
  const r = await c.call('exec', { command: 'true', retain_output: true });
  expect(data(r).result_id).toBeUndefined();
  expect(c.calls).toHaveLength(1);
});
it('validates maximum optional streams without regex stack overflow or decoded copies', () => {
  const stdout_b64 = Buffer.alloc(16 * 1024 * 1024).toString('base64');
  expect(synchronousResultId({ ...source, stdout_b64 }, 200)).toBe(RETAINED_ID);
  for (const bad of ['AB==', 'AAB=', 'AAAA\n', '===='])
    expect(synchronousResultId({ ...source, stdout_b64: bad }, 200)).toBeUndefined();
});
it('strips raw result identity from legacy poll without associating by PID', async () => {
  const c = await setup({ ...source, pid: 42, running: false, exited: true } as typeof source);
  const r = await c.call('exec_poll', { pid: 42 });
  expect(data(r).result_id).toBeUndefined();
  expect(c.calls).toHaveLength(1);
});
