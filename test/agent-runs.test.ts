/**
 * Agent threads and background runs (OPL-6085): thread_id and store on the two
 * agent tools, the background run tools, and the thread tools.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_RUN,
  AGENT_THREAD,
  CHAT_COMPLETION,
  connect,
  installFakePlatform,
  RUN_ID,
  THREAD_ID,
} from './harness.js';

let platform: ReturnType<typeof installFakePlatform>;
/** The fake platform's own fetch, which records every request; the helpers below wrap it. */
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

/** Answer the next platform requests with this body, still recording them. */
function answer(value: unknown, status = 200, contentType = 'application/json') {
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    await recording(...args);
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
      status,
      headers: { 'Content-Type': contentType },
    });
  }) as typeof fetch;
}

/** Fail the next platform requests the way a socket does: refused, or reset mid-answer. */
function transport(kind: 'refused' | 'reset') {
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    await recording(...args);
    throw Object.assign(new TypeError('fetch failed'), {
      cause:
        kind === 'refused'
          ? Object.assign(new Error('connect ECONNREFUSED'), {
              code: 'ECONNREFUSED',
              syscall: 'connect',
            })
          : Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
  }) as typeof fetch;
}

const stream = (...frames: [string, unknown][]) =>
  frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

const OTHER_THREAD = 'thr_fedcba9876543210fedcba98';

describe('run_agent keeps and continues threads', () => {
  it('sends thread_id and store when given, and neither otherwise', async () => {
    const { call } = await open({ modelKey: 'sk-ant-test' });
    await call('run_agent', { prompt: 'now close it', thread_id: THREAD_ID });
    expect(platform.calls.at(-1)?.body).toMatchObject({
      prompt: 'now close it',
      thread_id: THREAD_ID,
    });
    expect(platform.calls.at(-1)?.body).not.toHaveProperty('store');
    await call('run_agent', { prompt: 'open firefox', store: false });
    expect(platform.calls.at(-1)?.body).toMatchObject({ store: false });
    expect(platform.calls.at(-1)?.body).not.toHaveProperty('thread_id');
    await call('run_agent', { prompt: 'open firefox' });
    expect(platform.calls.at(-1)?.body).not.toHaveProperty('thread_id');
    expect(platform.calls.at(-1)?.body).not.toHaveProperty('store');
  });

  it('refuses store: false with a thread_id, and a malformed thread_id, before any request', async () => {
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const both = await call('run_agent', { prompt: 'go', thread_id: THREAD_ID, store: false });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain('cannot continue a thread');
    for (const thread_id of ['thr_123', 'run_0123456789abcdef01234567', `${THREAD_ID}/../x`]) {
      expect((await call('run_agent', { prompt: 'go', thread_id })).isError).toBe(true);
    }
    expect(platform.calls).toEqual([]);
  });

  it('names the thread a finished run was kept in, in words and in the record', async () => {
    answer(
      stream([
        'done',
        { steps: 1, stop: 'end_turn', text: 'Done.', usage: {}, thread_id: THREAD_ID },
      ]),
      200,
      'text/event-stream',
    );
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('run_agent', { prompt: 'open firefox' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(`Thread: ${THREAD_ID}. Send it as thread_id`);
    expect(textOf(res)).toContain(`"thread_id": "${THREAD_ID}"`);
  });

  it('names the thread a failed run was kept in', async () => {
    answer(
      stream(
        ['step', { n: 1, tool: 'computer', action: 'left_click', detail: 'clicked' }],
        ['error', { error: 'overloaded', status: 529, usage: {}, steps: [], thread_id: THREAD_ID }],
      ),
      200,
      'text/event-stream',
    );
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('run_agent', { prompt: 'open firefox' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`Thread: ${THREAD_ID}.`);
    expect(textOf(res)).toContain(`"thread_id": "${THREAD_ID}"`);
  });

  it('does not hand on a thread id that is not one', async () => {
    answer(
      stream(['done', { steps: 1, stop: 'end_turn', text: 'Done.', usage: {}, thread_id: 'x y' }]),
      200,
      'text/event-stream',
    );
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const said = textOf(await call('run_agent', { prompt: 'go' }));
    expect(said).not.toContain('Thread:');
    expect(said).not.toContain('"thread_id"');
  });

  it('points a client that cannot hold a call open at start_agent_run', async () => {
    const { client } = await open({ modelKey: 'sk-ant-test' });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'run_agent');
    expect(tool?.description).toContain('start_agent_run');
    expect(tool?.description).toContain('Unless it sent store: false');
    expect(tool?.inputSchema.properties).toHaveProperty('thread_id');
    expect(tool?.inputSchema.properties).toHaveProperty('store');
    expect(tool?.inputSchema.properties).not.toHaveProperty('messages');
  });
});

describe('run_agent_chat keeps and continues threads', () => {
  const task = { messages: [{ role: 'user', content: 'now close it' }] };

  it('sends thread_id and store, and keeps agent.thread_id from the answer', async () => {
    answer({ ...CHAT_COMPLETION, agent: { ...CHAT_COMPLETION.agent, thread_id: THREAD_ID } });
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('run_agent_chat', { ...task, thread_id: THREAD_ID });
    expect(platform.calls.at(-1)?.body).toMatchObject({ thread_id: THREAD_ID, stream: false });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(`Thread: ${THREAD_ID}.`);
    expect(textOf(res)).toContain(`"thread_id": "${THREAD_ID}"`);
    await call('run_agent_chat', { ...task, store: false });
    expect(platform.calls.at(-1)?.body).toMatchObject({ store: false });
  });

  it('refuses store: false with a thread_id before any request', async () => {
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('run_agent_chat', { ...task, thread_id: THREAD_ID, store: false });
    expect(res.isError).toBe(true);
    expect(platform.calls).toEqual([]);
  });

  it('names the thread a failed chat run was kept in', async () => {
    answer(
      {
        error: {
          message: 'Anthropic overloaded (529)',
          code: 529,
          agent: {
            computer_id: 'vm-1',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
            },
            steps: [],
            thread_id: THREAD_ID,
          },
        },
        request_id: '00000000-0000-4000-8000-000000000000',
      },
      529,
    );
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('run_agent_chat', task);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`Thread: ${THREAD_ID}.`);
  });

  it('keeps the thread of a failure whose step record is too large to show', async () => {
    const steps = Array.from({ length: 40 }, (_, i) => ({
      n: i + 1,
      tool: 'computer',
      action: 'left_click',
      detail: `clicked the thing number ${i} ${'x'.repeat(150)}`,
    }));
    answer(
      {
        error: {
          message: 'Anthropic overloaded (529)',
          code: 529,
          agent: {
            computer_id: 'vm-1',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
            },
            steps,
            thread_id: THREAD_ID,
          },
        },
        request_id: '00000000-0000-4000-8000-000000000000',
      },
      529,
    );
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const said = textOf(await call('run_agent_chat', task));
    expect(said).toContain('oversized and omitted');
    expect(said).toContain(`Thread: ${THREAD_ID}.`);
    expect(said).toContain(`"thread_id": "${THREAD_ID}"`);
  });

  it('names the thread of an answer it cannot otherwise read, and drops one that is not a thread', async () => {
    const { choices: _c, ...broken } = CHAT_COMPLETION;
    answer({ ...broken, agent: { ...CHAT_COMPLETION.agent, thread_id: THREAD_ID } });
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const malformed = await call('run_agent_chat', task);
    expect(malformed.isError).toBe(true);
    expect(textOf(malformed)).toContain('Malformed or missing chat terminal metadata');
    expect(textOf(malformed)).toContain(`Thread: ${THREAD_ID}.`);
    answer({ ...CHAT_COMPLETION, agent: { ...CHAT_COMPLETION.agent, thread_id: 'thr_nope' } });
    const odd = await call('run_agent_chat', task);
    expect(odd.isError).toBeFalsy();
    expect(textOf(odd)).not.toContain('Thread:');
    expect(textOf(odd)).not.toContain('thr_nope');
  });

  it('says earlier messages are the conversation, not that they are ignored', async () => {
    const { client } = await open({ modelKey: 'sk-ant-test' });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'run_agent_chat');
    expect(tool?.description).not.toContain('not replayed');
    expect(tool?.description).toContain('conversation so far');
    expect(tool?.description).toContain('With thread_id');
    expect(tool?.description).toContain('Unless it sent store: false');
  });
});

describe('start_agent_run', () => {
  it('is offered when run_agent is, and the read tools always', async () => {
    const names = async (cfg: Parameters<typeof connect>[0]) =>
      (await (await open(cfg)).client.listTools()).tools.map((t) => t.name);
    const reads = [
      'get_agent_run',
      'list_agent_runs',
      'cancel_agent_run',
      'list_agent_threads',
      'get_agent_thread',
      'delete_agent_thread',
    ];
    const bare = await names({});
    expect(bare).not.toContain('start_agent_run');
    expect(bare).toEqual(expect.arrayContaining(reads));
    expect(await names({ modelKey: 'sk-ant-test' })).toContain('start_agent_run');
    expect(await names({ funded: true })).toContain('start_agent_run');
  });

  it.each([{ modelKey: 'sk-ant-test' }, { funded: true }])(
    'accepts 500 background steps and refuses 501: %j',
    async (config) => {
      const { call } = await open(config);
      const accepted = await call('start_agent_run', { prompt: 'go', max_steps: 500 });
      expect(accepted.isError).toBeFalsy();
      expect(platform.calls.at(-1)?.body).toMatchObject({ max_steps: 500 });
      const count = platform.calls.length;
      const rejected = await call('start_agent_run', { prompt: 'go', max_steps: 501 });
      expect(rejected.isError).toBe(true);
      expect(platform.calls).toHaveLength(count);
    },
  );

  it('starts a keyed run with the key and no stream, and says to poll it', async () => {
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('start_agent_run', {
      computer_id: 'vm-7',
      prompt: 'download the invoices',
      thread_id: THREAD_ID,
    });
    expect(res.isError).toBeFalsy();
    const sent = platform.calls.at(-1)!;
    expect(sent).toMatchObject({ method: 'POST', path: '/computers/vm-7/agent/runs' });
    expect(sent.headers['x-model-key']).toBe('sk-ant-test');
    expect(sent.body).toEqual({
      prompt: 'download the invoices',
      max_steps: 20,
      thread_id: THREAD_ID,
    });
    const said = textOf(res);
    expect(said).toContain(`Started ${RUN_ID} in the background`);
    expect(said).toContain('get_agent_run');
    expect(said).toContain('STILL RUNNING');
    expect(said).toContain('No thread yet');
    expect(said).not.toContain('sk-ant-test');
  });

  it('starts a run on credits without a key, and takes max_cost_usd', async () => {
    const { call, client } = await open({ funded: true });
    const tool = (await client.listTools()).tools.find((t) => t.name === 'start_agent_run');
    expect(tool?.inputSchema.properties).toHaveProperty('max_cost_usd');
    expect(tool?.inputSchema.properties).not.toHaveProperty('system');
    expect(tool?.inputSchema.properties).not.toHaveProperty('store');
    expect(tool?.inputSchema.properties).not.toHaveProperty('stream');
    await call('start_agent_run', { prompt: 'go', max_cost_usd: 1.5 });
    const sent = platform.calls.at(-1)!;
    expect(sent.headers).not.toHaveProperty('x-model-key');
    expect(sent.body).toMatchObject({ prompt: 'go', max_cost_usd: 1.5 });
  });

  it('refuses an argument it does not take', async () => {
    const { call } = await open({ modelKey: 'sk-ant-test' });
    expect((await call('start_agent_run', { prompt: 'go', store: false })).isError).toBe(true);
    expect((await call('start_agent_run', { prompt: 'go', stream: true })).isError).toBe(true);
    expect(platform.calls).toEqual([]);
  });

  it('words a run the credits cannot cover as that, naming this tool', async () => {
    answer({ error: 'Insufficient AI credits', top_up_url: '/billing' }, 402);
    const { call } = await open({ funded: true });
    const res = await call('start_agent_run', { prompt: 'go' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('AI credits cannot cover the run');
    expect(textOf(res)).toContain('do not call start_agent_run again');
    expect(textOf(res)).toContain('/billing');
  });

  it('passes on a computer another run is driving as the contention it is', async () => {
    answer({ error: 'another agent run is driving this computer', reason: 'contention' }, 409);
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('start_agent_run', { prompt: 'go' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('another agent run is driving this computer');
  });

  it('says a run may have started when the outcome is unknown, and not on a refusal', async () => {
    answer({ error: 'the control plane could not be reached' }, 503);
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const unknown = await call('start_agent_run', { computer_id: 'vm-3', prompt: 'go' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('A RUN MAY HAVE STARTED on vm-3');
    expect(textOf(unknown)).toContain('list_agent_runs with computer_id vm-3');
    answer({ error: 'computer is not running' }, 409);
    const refused = await call('start_agent_run', { computer_id: 'vm-3', prompt: 'go' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).not.toContain('MAY HAVE STARTED');
  });

  it('tells a request that never left from one whose answer was lost', async () => {
    const { call } = await open({ modelKey: 'sk-ant-test' });
    transport('refused');
    const unsent = textOf(await call('start_agent_run', { computer_id: 'vm-3', prompt: 'go' }));
    expect(unsent).toContain('could not reach');
    expect(unsent).not.toContain('MAY HAVE STARTED');
    transport('reset');
    const lost = textOf(await call('start_agent_run', { computer_id: 'vm-3', prompt: 'go' }));
    expect(lost).toContain('A RUN MAY HAVE STARTED on vm-3');
  });

  it('does not call a request this client refused to send a run that may have started', async () => {
    // The real HTTP stack, which refuses a header value with a line break in it
    // before opening any connection.
    platform.restore();
    const { call } = await open({ modelKey: 'sk-ant-test\ncontinuation' });
    const said = textOf(await call('start_agent_run', { computer_id: 'vm-3', prompt: 'go' }));
    expect(said).toContain('rejected locally before it could be sent');
    expect(said).not.toContain('MAY HAVE STARTED');
    const { call: del } = await open({ apiKey: 'com_test\ncontinuation' });
    const deleted = textOf(
      await del('delete_agent_thread', { thread_id: THREAD_ID, confirm: true }),
    );
    expect(deleted).toContain('rejected locally before it could be sent');
    expect(deleted).not.toContain('MAY OR MAY NOT');
  });

  it('does not call a computer id it refused locally a run that may have started', async () => {
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('start_agent_run', { computer_id: 'a/b', prompt: 'go' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('MAY HAVE STARTED');
    expect(platform.calls).toEqual([]);
  });

  it('follows an accepted run by its id even when the rest of the answer is unreadable', async () => {
    answer({ id: RUN_ID, status: 'running' }, 202);
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('start_agent_run', { prompt: 'go' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`as ${RUN_ID}`);
    expect(textOf(res)).toContain('A RUN IS GOING');
    expect(textOf(res)).toContain(`get_agent_run (run_id ${RUN_ID})`);
  });

  it('never sends a lost start to a listing filtered on running, which hides a run that ended', async () => {
    const { call, client } = await open({ modelKey: 'sk-ant-test' });
    transport('reset');
    const lost = textOf(await call('start_agent_run', { computer_id: 'vm-3', prompt: 'go' }));
    expect(lost).toContain('no status filter');
    expect(lost).toContain('newest on the list');
    answer({ id: 'not-a-run' }, 202);
    const unread = textOf(await call('start_agent_run', { computer_id: 'vm-3', prompt: 'go' }));
    expect(unread).toContain('no status filter');
    const description =
      (await client.listTools()).tools.find((t) => t.name === 'start_agent_run')?.description ?? '';
    expect(description).toContain('no status filter before starting another');
    expect(description).not.toContain('with computer_id and status running before starting');
  });

  it('says a run may be going when the acceptance cannot be read', async () => {
    answer({ id: 'not-a-run', status: 'running' }, 202);
    const { call } = await open({ modelKey: 'sk-ant-test' });
    const res = await call('start_agent_run', { prompt: 'go' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('A RUN MAY BE GOING');
    expect(textOf(res)).toContain('list_agent_runs');
  });
});

describe('get_agent_run', () => {
  const read = async (run: Record<string, unknown>) => {
    answer(run);
    const { call } = await open();
    const res = await call('get_agent_run', { run_id: RUN_ID });
    expect(platform.calls.at(-1)).toMatchObject({ method: 'GET', path: `/agent/runs/${RUN_ID}` });
    return res;
  };

  it('calls only completed with end_turn finished, and names its thread', async () => {
    const res = await read(AGENT_RUN);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('FINISHED: completed with stop end_turn');
    expect(textOf(res)).toContain(`Thread: ${THREAD_ID}.`);
    expect(textOf(res)).toContain('1. took a screenshot');
    expect(textOf(res)).toContain('The invoices are in ~/invoices.');
  });

  it('reads a time-limited completed run as unfinished', async () => {
    const said = textOf(
      await read({ ...AGENT_RUN, result: { ...AGENT_RUN.result, stop: 'time_limit' } }),
    );
    expect(said).toContain('WITHOUT FINISHING (stop time_limit)');
    expect(said).toContain('60-MINUTE WALL-CLOCK LIMIT');
  });

  it('reads a completed run that stopped early as unfinished', async () => {
    const said = textOf(
      await read({ ...AGENT_RUN, result: { ...AGENT_RUN.result, stop: 'max_steps', steps: 20 } }),
    );
    expect(said).not.toContain('FINISHED');
    expect(said).toContain('WITHOUT FINISHING (stop max_steps)');
    expect(said).toContain('RAN OUT OF STEPS after 20');
  });

  it('reads a run that ran out of rate budget as unfinished, in words', async () => {
    const said = textOf(
      await read({ ...AGENT_RUN, result: { ...AGENT_RUN.result, stop: 'rate_limited' } }),
    );
    expect(said).toContain('WITHOUT FINISHING (stop rate_limited)');
    expect(said).toContain('RAN OUT OF RATE BUDGET');
    const other = textOf(
      await read({ ...AGENT_RUN, result: { ...AGENT_RUN.result, stop: 'max_tokens' } }),
    );
    expect(other).toContain('ended: max_tokens — not finished (only end_turn is)');
  });

  it('reads a completed run with no result as unknown, not finished', async () => {
    const { result: _r, ...rest } = AGENT_RUN;
    const said = textOf(await read(rest));
    expect(said).not.toContain('FINISHED');
    expect(said).toContain('whether the task was finished is unknown');
  });

  it('says a running run is not finished and how to wait for it', async () => {
    const said = textOf(
      await read({ ...AGENT_RUN, status: 'running', result: undefined, ended_at: null }),
    );
    expect(said).toContain('STILL RUNNING');
    expect(said).toContain('What it did so far');
  });

  it('warns that an interrupted run may have done more than it recorded', async () => {
    const said = textOf(
      await read({
        ...AGENT_RUN,
        status: 'interrupted',
        result: undefined,
        error: { error: 'the control plane restarted', status: 503 },
      }),
    );
    expect(said).toContain('INTERRUPTED');
    expect(said).toContain('MAY HAVE DONE MORE THAN IT RECORDED');
  });

  it('reads a failed run for what its status means on an agent run', async () => {
    const credits = textOf(
      await read({
        ...AGENT_RUN,
        status: 'failed',
        result: undefined,
        cost_usd: 0.5,
        error: { error: 'Insufficient AI credits', status: 402, top_up_url: '/billing' },
      }),
    );
    expect(credits).toContain('FAILED after 2 step(s)');
    expect(credits).toContain('AI credits cannot cover the run');
    expect(credits).toContain('$0.50');
    const revoked = textOf(
      await read({
        ...AGENT_RUN,
        status: 'failed',
        result: undefined,
        error: { error: 'key revoked', status: 403, reason: 'revoked' },
      }),
    );
    expect(revoked).toContain('no longer permits the run');
    expect(revoked).toContain('start_agent_run');
  });

  it('reads cancelled and unknown statuses as not finished', async () => {
    expect(textOf(await read({ ...AGENT_RUN, status: 'cancelled', result: undefined }))).toContain(
      'CANCELLED',
    );
    const unknown = textOf(await read({ ...AGENT_RUN, status: 'paused' }));
    expect(unknown).toContain('status paused, which this server does not know');
    expect(unknown).not.toContain('FINISHED');
  });

  it('does not hand on a thread id that is not one', async () => {
    const said = textOf(await read({ ...AGENT_RUN, thread_id: 'thread 7' }));
    expect(said).not.toContain('Thread:');
    expect(said).not.toContain('thread 7');
    expect(said).toContain('"thread_id": null');
  });

  it('refuses a malformed answer rather than guessing', async () => {
    const res = await read({ ...AGENT_RUN, status: undefined });
    expect(res.isError).toBe(true);
  });

  it('refuses an id that is not a run id before any request', async () => {
    const { call } = await open();
    for (const run_id of ['run_1', THREAD_ID, '../agent/threads']) {
      expect((await call('get_agent_run', { run_id })).isError).toBe(true);
    }
    expect(platform.calls).toEqual([]);
  });
});

describe('list_agent_runs', () => {
  it('sends its filters and says how to page, without steps or whole prompts', async () => {
    const long = `${'x'.repeat(300)}\nsecond line`;
    answer({
      runs: [
        { ...AGENT_RUN, prompt: long, steps_taken: [] },
        { ...AGENT_RUN, id: 'run_0000000000000000000000ff', status: 'running', result: undefined },
      ],
      has_more: true,
    });
    const { call } = await open();
    const res = await call('list_agent_runs', {
      computer_id: 'vm-1',
      status: 'running',
      limit: 2,
      before: RUN_ID,
    });
    const sent = platform.calls.at(-1)!;
    expect(sent.path).toBe('/agent/runs');
    expect(Object.fromEntries(sent.query)).toEqual({
      computer_id: 'vm-1',
      status: 'running',
      limit: '2',
      before: RUN_ID,
    });
    const said = textOf(res);
    expect(said).toContain(`${RUN_ID}: completed (stop end_turn), finished`);
    expect(said).toContain('run_0000000000000000000000ff: running on vm-1');
    expect(said).toContain('pass before=run_0000000000000000000000ff');
    expect(said).not.toContain('second line');
    expect(said).not.toContain('x'.repeat(200));
    expect(said).not.toContain('steps_taken');
  });

  it('refuses a status the platform does not have', async () => {
    const { call } = await open();
    expect((await call('list_agent_runs', { status: 'done' })).isError).toBe(true);
    expect(platform.calls).toEqual([]);
  });
});

describe('cancel_agent_run', () => {
  it('cancels by id and says what stands', async () => {
    const { call, client } = await open();
    const res = await call('cancel_agent_run', { run_id: RUN_ID });
    expect(platform.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `/agent/runs/${RUN_ID}/cancel`,
    });
    expect(textOf(res)).toContain(`Cancelled ${RUN_ID}`);
    expect(textOf(res)).toContain('CANCELLED');
    const tool = (await client.listTools()).tools.find((t) => t.name === 'cancel_agent_run');
    expect(tool?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });

  it('does not call a status it does not know an ended run', async () => {
    answer({ ...AGENT_RUN, status: 'paused' });
    const { call } = await open();
    const said = textOf(await call('cancel_agent_run', { run_id: RUN_ID }));
    expect(said).not.toContain('had already ended');
    expect(said).toContain(
      'status paused, which this server does not know, so whether it stopped is unknown',
    );
  });

  it('points an unreadable or failed cancel at get_agent_run', async () => {
    const { call } = await open();
    answer({});
    const unread = await call('cancel_agent_run', { run_id: RUN_ID });
    expect(unread.isError).toBe(true);
    expect(textOf(unread)).toContain(
      `Whether ${RUN_ID} stopped is unknown: get_agent_run reads it`,
    );
    answer({ error: 'the control plane could not be reached' }, 503);
    expect(textOf(await call('cancel_agent_run', { run_id: RUN_ID }))).toContain(
      'get_agent_run reads it, and cancel_agent_run can be sent again safely',
    );
    answer({ error: 'run not found' }, 404);
    expect(textOf(await call('cancel_agent_run', { run_id: RUN_ID }))).not.toContain(
      'stopped is unknown',
    );
  });

  it('says nothing was cancelled on a run that had already ended', async () => {
    answer(AGENT_RUN);
    const { call } = await open();
    const said = textOf(await call('cancel_agent_run', { run_id: RUN_ID }));
    expect(said).toContain('had already ended (completed), so nothing was cancelled');
    expect(said).toContain('FINISHED');
  });
});

describe('agent threads', () => {
  it('lists threads with their filters and the page after', async () => {
    const { messages: _m, ...summary } = AGENT_THREAD;
    answer({ threads: [summary], has_more: true });
    const { call } = await open();
    const res = await call('list_agent_threads', {
      computer_id: 'vm-1',
      limit: 1,
      before: OTHER_THREAD,
    });
    const sent = platform.calls.at(-1)!;
    expect(sent.path).toBe('/agent/threads');
    expect(Object.fromEntries(sent.query)).toEqual({
      computer_id: 'vm-1',
      limit: '1',
      before: OTHER_THREAD,
    });
    expect(textOf(res)).toContain(`${THREAD_ID} on vm-1: "${AGENT_THREAD.title}" — 2 turn(s)`);
    expect(textOf(res)).toContain(`pass before=${THREAD_ID}`);
  });

  it('reads a thread turn by turn, and only end_turn as finished', async () => {
    const { call } = await open();
    const res = await call('get_agent_thread', { thread_id: THREAD_ID });
    expect(platform.calls.at(-1)?.path).toBe(`/agent/threads/${THREAD_ID}`);
    const said = textOf(res);
    expect(said).toContain('1. user, 2026-10-18T09:00:00.000Z:\nOpen Firefox');
    expect(said).toContain(
      '2. assistant, 2026-10-18T09:04:00.000Z — finished (stop end_turn); 4 step(s)',
    );
    expect(said).toContain(`Continue it with thread_id ${THREAD_ID} on vm-1`);
    expect(said).not.toContain('may have done more');
  });

  it('warns about turns that may have done more than they reported', async () => {
    const turn = (stop: string) => ({
      role: 'assistant',
      text: 'partial',
      stop,
      created_at: '2026-10-18T09:05:00.000Z',
    });
    answer({
      ...AGENT_THREAD,
      messages: [
        ...AGENT_THREAD.messages,
        turn('aborted'),
        turn('interrupted'),
        turn('running'),
        { ...turn('error'), error: 'Anthropic overloaded' },
        turn('max_steps'),
      ],
    });
    const { call } = await open();
    const said = textOf(await call('get_agent_thread', { thread_id: THREAD_ID }));
    expect(said).toContain('Turn 3, 4, 5 ended running, aborted or interrupted');
    expect(said).toContain('ABORTED part way');
    expect(said).toContain('INTERRUPTED');
    expect(said).toContain('STILL RUNNING');
    expect(said).toContain('FAILED: Anthropic overloaded');
    expect(said).toContain('RAN OUT OF STEPS');
  });

  it('bounds a long thread to its newest turns and pages back through the rest', async () => {
    const big = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      text: `turn ${i + 1} ${'y'.repeat(32_000)}`,
      ...(i % 2 ? { stop: 'end_turn', steps: 1 } : {}),
      created_at: '2026-10-18T09:00:00.000Z',
    }));
    answer({ ...AGENT_THREAD, turns: 100, messages: big });
    const { call } = await open();
    const newest = textOf(await call('get_agent_thread', { thread_id: THREAD_ID }));
    expect(newest.length).toBeLessThan(60_000);
    // One 32,000-character turn fits in an answer, and two do not.
    expect(newest).toContain('turn 100 ');
    expect(newest).not.toContain('turn 99 ');
    expect(newest).toContain('Turns 1 to 99 are not shown');
    expect(newest).toContain('before_turn 100');
    const older = textOf(
      await call('get_agent_thread', { thread_id: THREAD_ID, before_turn: 100 }),
    );
    expect(older).toContain('turn 99 ');
    expect(older).not.toContain('turn 100 ');
    expect(older).toContain('Turn 100 comes after these');
    const first = textOf(await call('get_agent_thread', { thread_id: THREAD_ID, before_turn: 2 }));
    expect(first).toContain('turn 1 ');
    expect(first).not.toContain('not shown');
    expect(first).toContain('Turns 2 to 100 come after these');
    // Short turns: as many as fit, all of them here.
    answer({ ...AGENT_THREAD, messages: big.map((t) => ({ ...t, text: t.text.slice(0, 20) })) });
    const all = textOf(await call('get_agent_thread', { thread_id: THREAD_ID }));
    expect(all).toContain('turn 1 ');
    expect(all).toContain('turn 100');
    expect(all).not.toContain('not shown');
  });

  it('deletes a thread only with confirm, and says what stands', async () => {
    const { call, client } = await open();
    expect((await call('delete_agent_thread', { thread_id: THREAD_ID })).isError).toBe(true);
    expect(platform.calls).toEqual([]);
    const res = await call('delete_agent_thread', { thread_id: THREAD_ID, confirm: true });
    expect(platform.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/agent/threads/${THREAD_ID}`,
    });
    expect(textOf(res)).toContain(`Deleted ${THREAD_ID}`);
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === 'delete_agent_thread')?.annotations).toMatchObject({
      destructiveHint: true,
    });
    for (const name of [
      'get_agent_run',
      'list_agent_runs',
      'list_agent_threads',
      'get_agent_thread',
    ])
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, name).toBe(true);
  });

  it('says nothing was deleted for a thread it cannot see, and doubts an answer that is not the ack', async () => {
    answer({ error: 'thread not found' }, 404);
    const { call } = await open();
    const gone = await call('delete_agent_thread', { thread_id: THREAD_ID, confirm: true });
    expect(gone.isError).toBeFalsy();
    expect(textOf(gone)).toContain('Nothing was deleted');
    answer({ ok: false });
    const odd = await call('delete_agent_thread', { thread_id: THREAD_ID, confirm: true });
    expect(odd.isError).toBe(true);
    expect(textOf(odd)).toContain('MAY OR MAY NOT HAVE BEEN DELETED');
    // A request that never left deleted nothing; one whose answer was lost may have.
    transport('refused');
    const unsent = await call('delete_agent_thread', { thread_id: THREAD_ID, confirm: true });
    expect(unsent.isError).toBe(true);
    expect(textOf(unsent)).toContain('could not reach');
    expect(textOf(unsent)).not.toContain('MAY OR MAY NOT');
    transport('reset');
    const lost = await call('delete_agent_thread', { thread_id: THREAD_ID, confirm: true });
    expect(textOf(lost)).toContain('MAY OR MAY NOT HAVE BEEN DELETED');
  });
});
