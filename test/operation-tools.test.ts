import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY,
  ACTIVITY_ID,
  ACTIVITY_PAGE,
  ACTIVITY_RESULTS,
  ARTIFACT_ID,
  connect,
  fakeEvents,
  installFakePlatform,
  RETAINED_ID,
  SIGNAL_PAGE,
} from './harness.js';

const variants = [
  {
    name: 'list_directory',
    args: { path: '/tmp/é files;$(literal)' },
    suffix: '/files/list',
    query: { path: '/tmp/é files;$(literal)' },
  },
  {
    name: 'list_activities',
    args: { cursor: 'older +/%:九', changes: false },
    suffix: '/activities',
    query: { cursor: 'older +/%:九' },
  },
  {
    name: 'get_activity',
    args: { activity_id: ACTIVITY_ID },
    suffix: `/activities/${ACTIVITY_ID}`,
    query: {},
  },
  {
    name: 'get_activity_results',
    args: { activity_id: ACTIVITY_ID },
    suffix: `/activities/${ACTIVITY_ID}/results`,
    query: {},
  },
  {
    name: 'read_signals',
    args: { since: 'signal +/%:九', limit: 7 },
    suffix: '/signals',
    query: { since: 'signal +/%:九', limit: '7' },
  },
];
let platform: ReturnType<typeof installFakePlatform>;
let conn: Awaited<ReturnType<typeof connect>>;
let events: ReturnType<typeof fakeEvents>;
function answer(value: unknown, status = 200, headers = {}) {
  const record = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await record(...args);
    return new Response(value === undefined ? null : JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  };
}
const prose = (value: unknown) => JSON.stringify(value);
beforeEach(async () => {
  platform = installFakePlatform();
  events = fakeEvents();
  conn = await connect({ apiKey: 'com_metadata_caller', webSocket: events.factory });
});
afterEach(async () => {
  await conn.close();
  platform.restore();
});

describe('one passive request per metadata tool', () => {
  it.each(variants)(
    '$name preserves the exact query, default/explicit identity, and caller key',
    async ({ name, args, suffix, query }) => {
      for (const computer_id of [undefined, 'vm-other']) {
        const before = platform.calls.length;
        const result = await conn.call(name, { ...args, ...(computer_id ? { computer_id } : {}) });
        expect(result.isError).not.toBe(true);
        expect(platform.calls).toHaveLength(before + 1);
        const call = platform.calls.at(-1)!;
        expect(call).toMatchObject({
          method: 'GET',
          path: `/computers/${computer_id ?? 'vm-1'}${suffix}`,
          headers: { authorization: 'Bearer com_metadata_caller' },
        });
        expect(Object.fromEntries(call.query)).toEqual(query);
        expect(call.body).toBeUndefined();
        expect(call.headers['x-model-key']).toBeUndefined();
        expect(prose(result)).not.toContain('com_metadata_caller');
      }
      expect(events.sockets).toEqual([]);
      expect((await conn.call('get_activity', { activity_id: ACTIVITY_ID })).isError).not.toBe(
        true,
      );
      expect(platform.calls.at(-1)?.path).toBe(`/computers/vm-1/activities/${ACTIVITY_ID}`);
      const tool = (await conn.client.listTools()).tools.find((tool) => tool.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    },
  );

  it.each(
    variants.flatMap((tool) =>
      [401, 403, 402, 404, 429, 501, 503].map((status) => ({ ...tool, status })),
    ),
  )(
    '$name keeps HTTP $status as an error without follow-up work',
    async ({ name, args, status }) => {
      answer(
        {
          error: 'metadata refused',
          code: 'metadata_unavailable',
          reason: status === 501 ? 'unsupported' : 'unavailable',
          incomplete: true,
          secret: 'DO-NOT-ECHO',
        },
        status,
        { 'Retry-After': '2' },
      );
      const result = await conn.call(name, args);
      expect(result.isError).toBe(true);
      expect(prose(result)).toContain(`HTTP ${status}`);
      expect(prose(result)).toContain('metadata_unavailable');
      expect(prose(result)).toContain('incomplete');
      expect(prose(result)).toContain('2000');
      expect(prose(result)).not.toContain('DO-NOT-ECHO');
      expect(platform.calls).toHaveLength(1);
      expect(events.sockets).toHaveLength(0);
      if (status === 403) expect(prose(result)).toContain('Retrying does not help');
      if (status === 402) expect(prose(result)).toContain('not something waiting fixes');
    },
  );

  it.each(
    variants.flatMap((tool) => [null, undefined, {}, []].map((value) => ({ ...tool, value }))),
  )('$name rejects malformed/empty envelopes: $value', async ({ name, args, value }) => {
    answer(value);
    expect((await conn.call(name, args)).isError).toBe(true);
    expect(platform.calls).toHaveLength(1);
  });

  it.each([
    ['list_directory', { path: 'relative' }],
    ['list_directory', { path: '/bad\0name' }],
    ['list_directory', { path: '/bad\ud800' }],
    ['list_activities', { cursor: '' }],
    ['list_activities', { cursor: 'x'.repeat(2049) }],
    ['list_activities', { changes: true }],
    ['get_activity', { activity_id: 'act_ABC' }],
    ['get_activity_results', { activity_id: '../results' }],
    ['read_signals', { since: 'x'.repeat(2049) }],
    ['read_signals', { limit: 0 }],
    ['read_signals', { limit: 101 }],
    ['read_signals', { limit: 1.5 }],
  ])('%s rejects invalid arguments before fetch', async (name, args) => {
    expect((await conn.call(name as string, args as Record<string, unknown>)).isError).toBe(true);
    expect(platform.calls).toHaveLength(0);
  });
});

describe('metadata meanings survive projection', () => {
  it('preserves partial directory names/types and absent size without inventing pagination', async () => {
    answer({
      path: '/tmp/é ',
      entries: [
        { name: ' spaced;$(x) ', type: 'file', size_bytes: 9 },
        { name: 'unknown', type: 'unavailable' },
        { name: 'symlink', type: 'symlink' },
      ],
      truncated: true,
      skipped: 2,
      next_cursor: 'invented',
    });
    const result = await conn.call('list_directory', { path: '/tmp/é ' });
    expect(result.isError).not.toBe(true);
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('PARTIAL');
    expect(text).toContain('no continuation token');
    expect(text).toContain('narrower path');
    const data = JSON.parse(text.split('\n\n')[1]);
    expect(data.entries[0].name).toBe(' spaced;$(x) ');
    expect(data.entries[1]).toEqual({ name: 'unknown', type: 'unavailable' });
    expect(data.skipped).toBe(2);
    expect(data).not.toHaveProperty('next_cursor');
  });
  it.each(['unavailable', 'directory', 'symlink', 'special'])(
    'rejects size metadata on a non-file directory entry: %s',
    async (type) => {
      answer({
        path: '/tmp',
        entries: [{ name: 'not-a-file', type, size_bytes: 0 }],
        skipped: 0,
        truncated: false,
      });
      expect((await conn.call('list_directory', { path: '/tmp' })).isError).toBe(true);
      expect(platform.calls).toHaveLength(1);
    },
  );
  it('distinguishes an empty regular file from unavailable or unknown size', async () => {
    const entries = [
      { name: 'empty', type: 'file', size_bytes: 0 },
      { name: 'unknown-size', type: 'file' },
      { name: 'unavailable', type: 'unavailable' },
    ];
    answer({ path: '/tmp', entries, skipped: 0, truncated: false });
    const result = await conn.call('list_directory', { path: '/tmp' });
    expect(result.isError).not.toBe(true);
    const first = result.content[0];
    expect(JSON.parse(first.type === 'text' ? first.text.split('\n\n')[1] : '{}').entries).toEqual(
      entries,
    );
    expect(platform.calls).toHaveLength(1);
  });
  it('accepts an empty complete directory', async () => {
    answer({ path: '/', entries: [], truncated: false, skipped: 0 });
    expect((await conn.call('list_directory', { path: '/' })).isError).not.toBe(true);
  });
  it('warns on skipped names even without the truncated flag', async () => {
    answer({ path: '/', entries: [], truncated: false, skipped: 1 });
    expect(prose(await conn.call('list_directory', { path: '/' }))).toContain('PARTIAL');
  });
  it('preserves activity continuation, health gaps, revisions, and signed exit code', async () => {
    answer({
      ...ACTIVITY_PAGE,
      next_cursor: 'next:opaque',
      gap: true,
      health: {
        ...ACTIVITY_PAGE.health,
        capture: 'degraded',
        gap_at: '2026-09-15T00:00:00Z',
        recovered_at: '2026-09-16T00:00:00Z',
      },
      secret: 'DO-NOT-ECHO',
    });
    const result = await conn.call('list_activities', { cursor: 'changes /+:9', changes: true });
    expect(result.isError).not.toBe(true);
    expect(prose(result)).toContain('GAP');
    expect(prose(result)).toContain('next:opaque');
    expect(prose(result)).toContain('revision');
    expect(prose(result)).toContain('-1');
    expect(prose(result)).toContain('degraded');
    expect(prose(result)).not.toContain('DO-NOT-ECHO');
    expect(Object.fromEntries(platform.calls[0].query)).toEqual({
      cursor: 'changes /+:9',
      changes: '1',
    });
  });
  it('keeps a legitimate empty activity page and opaque change checkpoint', async () => {
    answer({ ...ACTIVITY_PAGE, items: [], next_cursor: null, changes_cursor: 'new-head' });
    expect(prose(await conn.call('list_activities'))).toContain('new-head');
    expect(Object.fromEntries(platform.calls[0].query)).toEqual({});
  });
  it('does not turn accepted background work into a completed execution', async () => {
    answer({ ...ACTIVITY, state: 'accepted', exit_code: undefined, http_status: 202 });
    const result = await conn.call('get_activity', { activity_id: ACTIVITY_ID });
    expect(result.isError).not.toBe(true);
    expect(prose(result)).toContain('not completed');
    expect(prose(result)).toContain('execution_id');
  });
  it('preserves available/unavailable versions and more without following or exposing content paths', async () => {
    answer({
      ...ACTIVITY_RESULTS,
      items: [
        ...ACTIVITY_RESULTS.items.map((item) => ({
          ...item,
          url: 'DO-NOT-ECHO',
          path: 'DO-NOT-ECHO',
        })),
        {
          id: RETAINED_ID,
          kind: 'background-output',
          association: 'background_execution_output',
          availability: 'available',
          captured_at: '2026-09-16T00:00:00Z',
          expires_at: '2026-09-17T00:00:00Z',
          stdout: { bytes: 5, retained_truncated: true, upstream_truncated: null },
          stderr: { bytes: 0, retained_truncated: false, upstream_truncated: null },
          diagnostic: { bytes: 1, truncated: true },
          observation: { status: 'exited', exit_code: -7 },
        },
      ],
    });
    const result = await conn.call('get_activity_results', { activity_id: ACTIVITY_ID });
    expect(result.isError).not.toBe(true);
    expect(prose(result)).toContain('no continuation cursor');
    expect(prose(result)).toContain('unavailable');
    expect(prose(result)).toContain('retained_truncated');
    expect(prose(result)).toContain('-7');
    expect(prose(result)).not.toContain('DO-NOT-ECHO');
    expect(platform.calls).toHaveLength(1);
  });
  it.each([undefined, null, {}, { status: 'exited' }, { status: 'exited', exit_code: 1.5 }])(
    'requires a valid observation for an available background result link: %j',
    async (observation) => {
      answer({
        activity_id: ACTIVITY_ID,
        revision: 1,
        more: false,
        items: [
          {
            id: RETAINED_ID,
            kind: 'background-output',
            association: 'background_execution_output',
            availability: 'available',
            captured_at: '2026-09-16T00:00:00Z',
            expires_at: '2026-09-17T00:00:00Z',
            stdout: { bytes: 5, retained_truncated: true, upstream_truncated: null },
            stderr: { bytes: 0, retained_truncated: false, upstream_truncated: null },
            diagnostic: { bytes: 1, truncated: true },
            observation,
          },
        ],
      });
      expect((await conn.call('get_activity_results', { activity_id: ACTIVITY_ID })).isError).toBe(
        true,
      );
      expect(platform.calls).toHaveLength(1);
    },
  );
  it.each([{ status: 'running' }, { status: 'exited', exit_code: -7 }])(
    'preserves the required available background observation: %j',
    async (observation) => {
      answer({
        activity_id: ACTIVITY_ID,
        revision: 1,
        more: false,
        items: [
          {
            id: RETAINED_ID,
            kind: 'background-output',
            association: 'background_execution_output',
            availability: 'available',
            captured_at: '2026-09-16T00:00:00Z',
            expires_at: '2026-09-17T00:00:00Z',
            stdout: { bytes: 5, retained_truncated: true, upstream_truncated: null },
            stderr: { bytes: 0, retained_truncated: false, upstream_truncated: null },
            diagnostic: { bytes: 1, truncated: true },
            observation,
          },
        ],
      });
      const result = await conn.call('get_activity_results', { activity_id: ACTIVITY_ID });
      expect(result.isError).not.toBe(true);
      const first = result.content[0];
      expect(
        JSON.parse(first.type === 'text' ? first.text.split('\n\n')[1] : '{}').items[0].observation,
      ).toEqual(observation);
      expect(platform.calls).toHaveLength(1);
    },
  );
  it('rejects an available artifact link with absent byte metadata', async () => {
    answer({
      activity_id: ACTIVITY_ID,
      revision: 1,
      more: false,
      items: [
        {
          id: ARTIFACT_ID,
          kind: 'artifact',
          association: 'caller_selected_artifact',
          availability: 'available',
        },
      ],
    });
    expect((await conn.call('get_activity_results', { activity_id: ACTIVITY_ID })).isError).toBe(
      true,
    );
  });
  it.each([undefined, ''])(
    'signals supports the deliberate head-only baseline: %j',
    async (since) => {
      const result = await conn.call('read_signals', since === undefined ? {} : { since });
      expect(result.isError).not.toBe(true);
      expect(prose(result)).toContain('no historical replay');
      expect(Object.fromEntries(platform.calls[0].query)).toEqual(
        since === undefined ? {} : { since: '' },
      );
    },
  );
  it.each(['saved:1', 'opaque +/%:九'])(
    'preserves empty replay advancement from %j',
    async (since) => {
      answer({
        ...SIGNAL_PAGE,
        baseline: false,
        from: since,
        cursor: 'new-checkpoint',
      });
      const result = await conn.call('read_signals', { since });
      expect(result.isError).not.toBe(true);
      expect(prose(result)).toContain('new-checkpoint');
      expect(prose(result)).not.toContain('GAP');
      expect(platform.calls).toHaveLength(1);
      expect(Object.fromEntries(platform.calls[0].query)).toEqual({ since });
      expect(events.sockets).toEqual([]);
    },
  );
  const reset = {
    ...SIGNAL_PAGE,
    baseline: false,
    from: 'reset-head',
    cursor: 'reset-head',
    gap: {
      cursor: 'reset-head',
      at: '2026-09-16T00:00:00Z',
      type: 'gap',
      computer: 'vm-1',
      source: 'daemon',
      data: { detail: 'cursor reset', oldest_cursor: 'oldest' },
    },
  };
  it('preserves a consistent explicit reset gap', async () => {
    answer(reset);
    const result = await conn.call('read_signals', { since: 'old-checkpoint' });
    expect(result.isError).not.toBe(true);
    expect(prose(result)).toContain('reset-head');
    expect(prose(result)).toContain('GAP');
    expect(prose(result)).not.toContain('Head-only baseline');
    expect(platform.calls).toHaveLength(1);
    expect(Object.fromEntries(platform.calls[0].query)).toEqual({ since: 'old-checkpoint' });
    expect(events.sockets).toEqual([]);
  });
  const idle = {
    seq: 1,
    cursor: 'idle:1',
    at: '2026-09-16T00:00:00Z',
    computer: 'vm-1',
    source: 'daemon',
    type: 'computer.idle',
    data: { idle_seconds: 3 },
  };
  it.each([
    {
      name: 'replay starts at an unrelated checkpoint',
      since: 'saved:1',
      value: { ...SIGNAL_PAGE, baseline: false, from: 'other:7', cursor: 'other:8' },
    },
    { name: 'replay silently becomes a baseline', since: 'saved:1', value: SIGNAL_PAGE },
    {
      name: 'missing since does not establish a baseline',
      since: undefined,
      value: { ...SIGNAL_PAGE, baseline: false },
    },
    {
      name: 'empty since does not establish a baseline',
      since: '',
      value: { ...SIGNAL_PAGE, baseline: false },
    },
    {
      name: 'baseline has two heads',
      since: '',
      value: { ...SIGNAL_PAGE, from: 'other:7' },
    },
    { name: 'baseline has more pages', since: '', value: { ...SIGNAL_PAGE, more: true } },
    {
      name: 'baseline includes replay events',
      since: '',
      value: { ...SIGNAL_PAGE, events: [idle] },
    },
    { name: 'baseline also claims a gap', since: '', value: { ...reset, baseline: true } },
    { name: 'reset has a different start', since: 'saved:1', value: { ...reset, from: 'other:7' } },
    {
      name: 'reset has a different gap cursor',
      since: 'saved:1',
      value: { ...reset, gap: { ...reset.gap, cursor: 'other:8' } },
    },
    {
      name: 'reset has three different checkpoints',
      since: 'saved:1',
      value: { ...reset, from: 'other:7', cursor: 'other:8' },
    },
    { name: 'reset has more pages', since: 'saved:1', value: { ...reset, more: true } },
    {
      name: 'reset includes replay events',
      since: 'saved:1',
      value: { ...reset, events: [idle] },
    },
    {
      name: 'empty replay claims more pages',
      since: 'saved:1',
      value: { ...SIGNAL_PAGE, baseline: false, from: 'saved:1', more: true },
    },
  ])('rejects inconsistent signal checkpoints: $name', async ({ since, value }) => {
    answer(value);
    const result = await conn.call('read_signals', since === undefined ? {} : { since });
    expect(result.isError).toBe(true);
    expect(prose(result)).toContain('no checkpoint was established');
    expect(prose(result)).not.toContain('use the returned cursor');
    expect(prose(result)).not.toContain(value.cursor);
    expect(platform.calls).toHaveLength(1);
    expect(Object.fromEntries(platform.calls[0].query)).toEqual(
      since === undefined ? {} : { since },
    );
    expect(events.sockets).toEqual([]);
  });
  const replayEvents = [
    { ...idle, seq: 0, cursor: 'visible:z' },
    { ...idle, seq: 5, cursor: 'visible:a' },
    { ...idle, seq: 8, cursor: 'visible:m' },
  ];
  const replay = {
    ...SIGNAL_PAGE,
    baseline: false,
    from: 'saved:1',
    cursor: 'filtered:tail',
    events: replayEvents,
  };
  it.each(
    [
      {
        name: 'single event page returns to the start',
        value: { ...replay, cursor: replay.from, events: [replayEvents[0]] },
      },
      { name: 'next cursor returns to the start', value: { ...replay, cursor: replay.from } },
      {
        name: 'next cursor returns to the first event',
        value: { ...replay, cursor: replayEvents[0].cursor },
      },
      {
        name: 'next cursor returns to the middle event',
        value: { ...replay, cursor: replayEvents[1].cursor },
      },
      {
        name: 'first event reuses the start cursor',
        value: { ...replay, events: [{ ...replayEvents[0], cursor: replay.from }] },
      },
      {
        name: 'later event reuses the start cursor',
        value: {
          ...replay,
          events: [replayEvents[0], { ...replayEvents[1], cursor: replay.from }],
        },
      },
      {
        name: 'adjacent events share a cursor',
        value: {
          ...replay,
          events: [replayEvents[0], { ...replayEvents[1], cursor: replayEvents[0].cursor }],
        },
      },
      {
        name: 'nonadjacent events share a cursor',
        value: {
          ...replay,
          events: [
            replayEvents[0],
            replayEvents[1],
            { ...replayEvents[2], cursor: replayEvents[0].cursor },
          ],
        },
      },
      {
        name: 'sequence numbers decrease',
        value: { ...replay, events: [replayEvents[1], replayEvents[0]] },
      },
      {
        name: 'sequence numbers decrease after an increase',
        value: { ...replay, events: [replayEvents[0], replayEvents[2], replayEvents[1]] },
      },
      {
        name: 'distinct cursors have equal sequence numbers',
        value: {
          ...replay,
          events: [replayEvents[0], { ...replayEvents[1], seq: replayEvents[0].seq }],
        },
      },
    ].flatMap((scenario) => [false, true].map((more) => ({ ...scenario, more }))),
  )('rejects inconsistent signal replay progress: $name, more=$more', async ({ value, more }) => {
    answer({ ...value, more });
    const result = await conn.call('read_signals', { since: replay.from });
    expect(result.isError).toBe(true);
    expect(prose(result)).toContain('no checkpoint was established');
    expect(prose(result)).not.toContain('use the returned cursor');
    expect(prose(result)).not.toContain(value.cursor);
    expect(platform.calls).toHaveLength(1);
    expect(Object.fromEntries(platform.calls[0].query)).toEqual({ since: replay.from });
    expect(events.sockets).toEqual([]);
  });
  it.each(
    [
      { name: 'only visible event', cursor: replayEvents[0].cursor, pageEvents: [replayEvents[0]] },
      { name: 'last visible event', cursor: replayEvents.at(-1)!.cursor, pageEvents: replayEvents },
      { name: 'filtered tail', cursor: 'opaque +/%:九', pageEvents: replayEvents },
    ].flatMap((scenario) => [false, true].map((more) => ({ ...scenario, more }))),
  )(
    'preserves valid signal replay progress to $name, more=$more',
    async ({ cursor, more, pageEvents }) => {
      const value = { ...replay, cursor, more, events: pageEvents };
      const limit = pageEvents.length;
      answer(value);
      // Retrying the same checkpoint is independent; neither call consumes local state.
      for (let call = 1; call <= 2; call++) {
        const result = await conn.call('read_signals', { since: replay.from, limit });
        expect(result.isError).not.toBe(true);
        const first = result.content[0];
        expect(JSON.parse(first.type === 'text' ? first.text.split('\n\n')[1] : '{}')).toEqual(
          value,
        );
        expect(platform.calls).toHaveLength(call);
        expect(Object.fromEntries(platform.calls.at(-1)!.query)).toEqual({
          since: replay.from,
          limit: String(limit),
        });
        expect(events.sockets).toEqual([]);
      }
    },
  );
  it('preserves an empty replay at the current head', async () => {
    const value = { ...replay, cursor: replay.from, events: [] };
    answer(value);
    const result = await conn.call('read_signals', { since: replay.from });
    expect(result.isError).not.toBe(true);
    const first = result.content[0];
    expect(JSON.parse(first.type === 'text' ? first.text.split('\n\n')[1] : '{}')).toEqual(value);
    expect(platform.calls).toHaveLength(1);
    expect(events.sockets).toEqual([]);
  });
  it.each([false, true])(
    'preserves execution identity and signed exit outcome with more=%j',
    async (more) => {
      answer({
        ...SIGNAL_PAGE,
        baseline: false,
        from: 'page:0',
        more,
        events: [
          {
            seq: 1,
            cursor: 'e:1',
            at: '2026-09-16T00:00:00Z',
            computer: 'vm-1',
            source: 'daemon',
            type: 'process.exited',
            data: {
              pid: 17,
              execution_id: ACTIVITY.execution_id,
              exit_code: -2,
              output: 'DO-NOT-ECHO',
            },
          },
        ],
        cursor: 'page:9',
      });
      const result = await conn.call('read_signals', { since: 'page:0' });
      expect(result.isError).not.toBe(true);
      expect(prose(result)).toContain('-2');
      expect(prose(result)).toContain(ACTIVITY.execution_id);
      expect(prose(result)).toContain('page:9');
      expect(prose(result)).not.toContain('DO-NOT-ECHO');
      expect(platform.calls).toHaveLength(1);
      expect(events.sockets).toEqual([]);
    },
  );
});
