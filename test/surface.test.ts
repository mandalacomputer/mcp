import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED,
  PARAMETERS,
  patternFor,
  UNIMPLEMENTED,
  UNIMPLEMENTED_PARAMETERS,
} from './allowlist.js';
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
  list_sizes: [{}],
  list_computers: [{}, { allow_partial: true }],
  get_computer: [{}],
  use_computer: [{ computer_id: 'vm-1' }],
  start_computer: [{}],
  stop_computer: [{}],
  suspend_computer: [{}],
  restart_computer: [{}],
  // Two shapes, because a resize needs the computer stopped and a rename does
  // not, so the platform refuses them together.
  update_computer: [
    { name: 'renamed' },
    { cpu: 4, ram_mb: 4096, disk_gb: 40 },
    { idle_suspend_min: 30 },
  ],
  wait_for_computer: [{ until: 'guest' }],
  get_desktop_url: [{}],
  // A named size and an explicit shape are alternatives, never both.
  create_computer: [
    { template: 'base', name: 'made', cpu: 2, ram_mb: 2048, disk_gb: 20, resolution: '1280x800' },
    { size: 'small' },
  ],
  clone_computer: [{ name: 'copy' }],
  delete_computer: [
    { computer_id: 'vm-2', confirm: true },
    { computer_id: 'vm-2', confirm: true, delete_snapshots: true, expect: 'fp-abc123' },
  ],

  screenshot: [{}, { width: 800, fresh: true }],
  click: [{ x: 10, y: 20 }],
  type_text: [{ text: 'hi' }],
  press_key: [{ keys: ['ctrl', 'c'] }],
  scroll: [{ direction: 'down' }],
  drag: [{ to_x: 5, to_y: 6, from_x: 1, from_y: 2 }],
  move_mouse: [{ x: 3, y: 4 }],
  mouse_button: [{ state: 'down', x: 1, y: 1 }],
  cursor_position: [{}],
  wait: [{ seconds: 1 }],

  exec: [{ command: 'true' }, { command: 'sleep 1', background: true, cwd: '/tmp', desktop: true }],
  exec_poll: [{ pid: 4242 }],
  exec_kill: [{ pid: 4242 }],
  open_url: [{ url: 'https://example.com' }],
  list_windows: [{}, { include_all: true }],
  window_action: [
    { window_id: '0x2600003', action: 'focus' },
    { window_id: '0x2600003', action: 'move', x: 10, y: 20 },
    { window_id: '0x2600003', action: 'resize', width: 640, height: 480 },
  ],
  write_file: [{ path: '/home/user/a.txt', content: 'hello' }],
  // The offset is the parameter, and it is the whole of OPL-3740: without an
  // argument that turns into a Range this route is reachable and a file over
  // 64 MiB still is not.
  read_file: [{ path: '/home/user/a.txt' }, { path: '/home/user/a.txt', offset: 2 }],

  list_snapshots: [{}, { allow_partial: true, include_unfinished: true }],
  snapshot_holdings: [{}],
  create_snapshot: [{}, { memory: true }],
  restore_snapshot: [{ snapshot_id: 'snap-1', confirm: true }],
  clone_snapshot: [{ snapshot_id: 'snap-1' }, { snapshot_id: 'snap-1', name: 'copy' }],
  snapshot_schedule: [
    {},
    { set: { enabled: true, hour: 4, minute: 30, tz: 'UTC' } },
    { clear: true },
  ],
  delete_snapshot: [{ snapshot_id: 'snap-1', confirm: true }],

  run_agent: [
    { prompt: 'open firefox' },
    { prompt: 'open firefox', system: 'be brief', max_steps: 3 },
  ],
};

const routesOf = (calls: Recorded[]) =>
  new Set(calls.map((c) => `${c.method} ${patternFor(c.path)}`));

/**
 * The headers the platform documents as parameters, anywhere on the surface.
 *
 * Every request also carries `Authorization`, `Accept` and a `Content-Type`.
 * None is a parameter of a route — they are how any request is made rather than
 * what this one asks for — so they are not in the platform's table and must not
 * be compared against it. Restricting to the documented names rather than
 * excluding those three by hand means a header the platform adds later is
 * compared, instead of quietly falling through a denylist nobody updated.
 */
const DOCUMENTED_HEADERS = new Set(
  [...PARAMETERS.values()].flat().flatMap((p) => (p.startsWith('header:') ? [p.slice(7)] : [])),
);

/** What one call actually carried, in the mirror's spelling. */
function parametersOf(call: Recorded): string[] {
  const sent = [
    ...[...call.query.keys()].map((k) => `query:${k}`),
    // Matched case-insensitively, because a header name is: the mirror spells
    // `Range` and `X-Model-Key` as the platform's table does, and what went out
    // on the wire is whatever this server's own code wrote.
    ...[...DOCUMENTED_HEADERS]
      .filter((h) => call.headers[h.toLowerCase()] !== undefined)
      .map((h) => `header:${h}`),
  ];
  // Only an object body has named fields. A file upload's body is the file.
  if (call.body && typeof call.body === 'object' && !Array.isArray(call.body)) {
    sent.push(...Object.keys(call.body).map((k) => `body:${k}`));
  }
  return sent;
}

/** Everything this server sent, by route. */
function sentParameters(calls: Recorded[]): Map<string, Set<string>> {
  const byRoute = new Map<string, Set<string>>();
  for (const call of calls) {
    const route = `${call.method} ${patternFor(call.path)}`;
    const set = byRoute.get(route) ?? new Set<string>();
    for (const p of parametersOf(call)) set.add(p);
    byRoute.set(route, set);
  }
  return byRoute;
}

/** Every tool, with every argument set, against the fake platform. */
async function exerciseEverything(
  call: (n: string, a: Record<string, unknown>) => Promise<unknown>,
) {
  for (const [name, argSets] of Object.entries(EXERCISE)) {
    for (const args of argSets) await call(name, args);
  }
}

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
    await exerciseEverything(call);
    await close();

    const called = routesOf(platform.calls);
    const unreached = [...ALLOWED].filter((r) => !called.has(r)).sort();
    expect(unreached).toEqual([...UNIMPLEMENTED].sort());
  });

  it('sends only parameters the platform documents', async () => {
    // A field the platform does not read is a field it ignores, silently: the
    // call succeeds, and the thing the caller asked for does not happen.
    const { call, close } = await connect({ modelKey: 'sk-ant-test' });
    await exerciseEverything(call);
    await close();

    const outside: string[] = [];
    for (const [route, sent] of sentParameters(platform.calls)) {
      const known = new Set(PARAMETERS.get(route) ?? []);
      for (const p of sent) if (!known.has(p)) outside.push(`${route}  ${p}`);
    }
    expect(outside.sort(), 'this server sends parameters the platform ignores').toEqual([]);
  });

  it('leaves exactly the pinned part of the parameter surface unsent', async () => {
    // The test the route table could not be: `Range` was documented, on a route
    // this server called on every read_file, and unsendable — and every other
    // test in this file passed for the whole time that was true.
    const { call, close } = await connect({ modelKey: 'sk-ant-test' });
    await exerciseEverything(call);
    await close();

    const sent = sentParameters(platform.calls);
    const unsent: string[] = [];
    for (const [route, params] of PARAMETERS) {
      // A route nobody calls sends none of its parameters; its own line in
      // UNIMPLEMENTED already says so, and repeating it here per parameter
      // would bury the ones that are genuinely missing.
      if (UNIMPLEMENTED.has(route)) continue;
      const actual = sent.get(route) ?? new Set<string>();
      for (const p of params) if (!actual.has(p)) unsent.push(`${route}  ${p}`);
    }
    expect(unsent.sort()).toEqual([...UNIMPLEMENTED_PARAMETERS].sort());
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
