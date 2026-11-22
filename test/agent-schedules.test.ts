/**
 * Agent schedules: the tools that make, read, change, pause, resume and
 * delete a schedule, and what a create says when its answer is lost.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_SCHEDULE, connect, installFakePlatform, SCHEDULE_ID } from './harness.js';

let platform: ReturnType<typeof installFakePlatform>;
let recording: typeof fetch;
const connections: Awaited<ReturnType<typeof connect>>[] = [];
async function open(cfg: Parameters<typeof connect>[0] = {}) {
  const connection = await connect(cfg);
  connections.push(connection);
  return connection;
}
beforeEach(() => {
  platform = installFakePlatform();
  recording = globalThis.fetch;
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()));
  platform.restore();
});

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

function answer(value: unknown, status = 200) {
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    await recording(...args);
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('agent schedule tools', () => {
  it('are offered whatever pays', async () => {
    const names = (await (await open({})).client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'create_agent_schedule',
        'update_agent_schedule',
        'list_agent_schedules',
        'get_agent_schedule',
        'pause_agent_schedule',
        'resume_agent_schedule',
        'delete_agent_schedule',
      ]),
    );
  });

  it('creates on the selected computer and says when it next fires', async () => {
    const { call } = await open({});
    const res = await call('create_agent_schedule', {
      computer_id: 'vm-7',
      cron: '0 9 * * MON-FRI',
      prompt: 'check the build',
      timezone: 'UTC',
    });
    expect(res.isError).toBeFalsy();
    expect(platform.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/computers/vm-7/agent/schedules',
      body: { cron: '0 9 * * MON-FRI', prompt: 'check the build', timezone: 'UTC' },
    });
    expect(textOf(res)).toContain('next fire 2026-11-24T09:00:00.000Z');
  });

  it('says a schedule may have been made when the create fails with a 5xx (Codex round 1)', async () => {
    const { call } = await open({});
    answer({ error: 'boom' }, 500);
    const res = await call('create_agent_schedule', {
      computer_id: 'vm-7',
      cron: '0 9 * * *',
      prompt: 'x',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('A SCHEDULE MAY HAVE BEEN MADE on vm-7');
    expect(textOf(res)).toContain('list_agent_schedules with computer_id vm-7');
  });

  it('keeps the id of a schedule whose answer could not otherwise be read', async () => {
    const { call } = await open({});
    answer({ id: SCHEDULE_ID, cron: 5 }, 201);
    const res = await call('create_agent_schedule', {
      computer_id: 'vm-7',
      cron: '0 9 * * *',
      prompt: 'x',
    });
    expect(textOf(res)).toContain(`schedule_id ${SCHEDULE_ID}`);
    expect(textOf(res)).toContain('rather than making another');
  });

  it('passes a 4xx refusal on as it is, saying nothing may have been made', async () => {
    const { call } = await open({});
    answer({ error: 'cron may fire at most once every 5 minutes' }, 400);
    const res = await call('create_agent_schedule', {
      computer_id: 'vm-7',
      cron: '* * * * *',
      prompt: 'x',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('at most once every 5 minutes');
    expect(textOf(res)).not.toContain('MAY HAVE BEEN MADE');
  });

  it('lists summaries, not whole prompts or fire histories (Codex round 1)', async () => {
    const { call } = await open({});
    const long = { ...AGENT_SCHEDULE, prompt: `${'x'.repeat(64_000)}`, recent_fires: [] };
    answer({ schedules: Array.from({ length: 20 }, () => long), has_more: false });
    const res = await call('list_agent_schedules', {});
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res).length).toBeLessThan(40_000);
  });

  it('pauses, resumes and deletes by id', async () => {
    const { call } = await open({});
    await call('pause_agent_schedule', { schedule_id: SCHEDULE_ID });
    expect(platform.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { paused: true } });
    await call('resume_agent_schedule', { schedule_id: SCHEDULE_ID });
    expect(platform.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { paused: false } });
    const gone = await call('delete_agent_schedule', { schedule_id: SCHEDULE_ID, confirm: true });
    expect(platform.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/agent/schedules/${SCHEDULE_ID}`,
    });
    expect(textOf(gone)).toContain(`Deleted ${SCHEDULE_ID}`);
  });

  it('refuses a malformed schedule id before any request', async () => {
    const { call } = await open({});
    const before = platform.calls.length;
    const res = await call('get_agent_schedule', { schedule_id: 'sch_nope' });
    expect(res.isError).toBe(true);
    expect(platform.calls).toHaveLength(before);
  });
});
