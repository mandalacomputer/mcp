import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED, patternFor, UNIMPLEMENTED } from './allowlist.js';
import { connect, installFakePlatform, type Recorded } from './harness.js';

/**
 * Arguments good enough to make each tool do its request — a list per tool,
 * because a few of them reach a different route depending on what they are
 * given. snapshot_schedule is the clearest: no arguments reads the schedule,
 * `set` writes it, `clear` removes it, and those are three HTTP verbs.
 *
 * A tool with no entry here fails the first test rather than being quietly
 * skipped, which is the point: a tool nobody calls is a tool whose route nobody
 * is checking.
 */
const EXERCISE: Record<string, Record<string, unknown>[]> = {
  list_templates: [{}],
  list_computers: [{}],
  get_computer: [{}],
  use_computer: [{ computer_id: 'vm-1' }],
  start_computer: [{}],
  stop_computer: [{}],
  suspend_computer: [{}],
  restart_computer: [{}],
  update_computer: [{ name: 'renamed' }],
  wait_for_computer: [{ until: 'guest' }],
  get_desktop_url: [{}],
  create_computer: [{ template: 'base' }],
  clone_computer: [{ name: 'copy' }],
  delete_computer: [{ computer_id: 'vm-2', confirm: true }],

  screenshot: [{}],
  click: [{ x: 10, y: 20 }],
  type_text: [{ text: 'hi' }],
  press_key: [{ keys: ['ctrl', 'c'] }],
  scroll: [{ direction: 'down' }],
  drag: [{ to_x: 5, to_y: 6, from_x: 1, from_y: 2 }],
  move_mouse: [{ x: 3, y: 4 }],
  mouse_button: [{ state: 'down', x: 1, y: 1 }],
  cursor_position: [{}],
  wait: [{ seconds: 1 }],

  exec: [{ command: 'true' }],
  exec_poll: [{ pid: 4242 }],
  exec_kill: [{ pid: 4242 }],
  open_url: [{ url: 'https://example.com' }],
  list_windows: [{}],
  window_action: [{ window_id: '0x2600003', action: 'focus' }],
  write_file: [{ path: '/home/user/a.txt', content: 'hello' }],
  read_file: [{ path: '/home/user/a.txt' }],

  list_snapshots: [{}],
  snapshot_holdings: [{}],
  create_snapshot: [{}],
  restore_snapshot: [{ snapshot_id: 'snap-1', confirm: true }],
  clone_snapshot: [{ snapshot_id: 'snap-1' }],
  snapshot_schedule: [{}, { set: { enabled: true, hour: 4 } }, { clear: true }],
  delete_snapshot: [{ snapshot_id: 'snap-1', confirm: true }],

  run_agent: [{ prompt: 'open firefox' }],
};

const routesOf = (calls: Recorded[]) =>
  new Set(calls.map((c) => `${c.method} ${patternFor(c.path)}`));

describe('the surface this server calls', () => {
  let platform: ReturnType<typeof installFakePlatform>;

  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('exercises every tool it registers', async () => {
    const { client, close } = await connect({ modelKey: 'sk-ant-test' });
    const { tools } = await client.listTools();
    await close();
    const names = tools.map((t) => t.name).sort();
    const covered = Object.keys(EXERCISE).sort();
    expect(names).toEqual(covered);
  });

  it('lands every call on a route the platform allowlists', async () => {
    const { call, close } = await connect({ modelKey: 'sk-ant-test' });
    for (const [name, argSets] of Object.entries(EXERCISE)) {
      for (const args of argSets) {
        const res = await call(name, args);
        // A tool that refused did not make its request, and would pass the
        // allowlist check by having called nothing at all.
        expect(res.isError, `${name} failed: ${JSON.stringify(res.content)}`).toBeFalsy();
      }
    }
    await close();

    const called = routesOf(platform.calls);
    expect(called.size).toBeGreaterThan(0);
    const outside = [...called].filter((r) => !ALLOWED.has(r));
    expect(outside, 'these routes are not on the platform allowlist and will 404').toEqual([]);
  });

  it('leaves exactly the pinned part of the platform surface unreached', async () => {
    const { call, close } = await connect({ modelKey: 'sk-ant-test' });
    for (const [name, argSets] of Object.entries(EXERCISE)) {
      for (const args of argSets) await call(name, args);
    }
    await close();

    const called = routesOf(platform.calls);
    const unreached = [...ALLOWED].filter((r) => !called.has(r)).sort();
    expect(unreached).toEqual([...UNIMPLEMENTED].sort());
  });

  it('withholds the lifecycle tools when they are turned off', async () => {
    const { client, close } = await connect({ lifecycle: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    await close();
    for (const gated of [
      'create_computer',
      'clone_computer',
      'delete_computer',
      'delete_snapshot',
    ]) {
      expect(names).not.toContain(gated);
    }
    // Power is not lifecycle: a server that may only attach still has to be
    // able to bring a computer up.
    expect(names).toContain('start_computer');
    expect(names).toContain('screenshot');
  });

  it('does not offer run_agent without a model key', async () => {
    const { client, close } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    await close();
    expect(names).not.toContain('run_agent');
  });
});

describe('patternFor', () => {
  it('treats ids as ids', () => {
    expect(patternFor('/computers/vm-1/start')).toBe('computers/:id/start');
    expect(patternFor('/snapshots/snap-1/clone')).toBe('snapshots/:id/clone');
    expect(patternFor('/computers/vm-1/exec/103457')).toBe('computers/:id/exec/:pid');
    expect(patternFor('/computers/vm-1/windows/0x2600003')).toBe('computers/:id/windows/:window');
    // A computer whose id looks like a route segment is still an id.
    expect(patternFor('/computers/audit')).toBe('computers/:id');
  });
});

describe('the allowlist itself', () => {
  it("reaches none of the daemon's ops routes", () => {
    // The previous tests prove this server stays inside ALLOWED. This proves
    // ALLOWED stays honest, so widening it later is a deliberate act. None of
    // these are owner-scoped inside the daemon.
    const internal = new Set(['audit', 'host', 'fleet', 'retention']);
    for (const route of ALLOWED) {
      const first = route.split(' ')[1].split('/')[0];
      expect(internal.has(first), `${route} reaches an ops endpoint`).toBe(false);
    }
  });
});
