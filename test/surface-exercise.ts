import {
  ACTIVITY_ID,
  ARTIFACT_ID,
  ARTIFACT_MANIFEST,
  BASE,
  connect,
  installFakePlatform,
  RETAINED_ID,
  type Recorded,
  SSH_PUBLIC_KEY,
} from './harness.js';

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
export const EXERCISE: Record<string, Record<string, unknown>[]> = {
  retain_execution_output: [
    {
      execution_id: 'exec_0123456789abcdef0123456789abcdef',
      max_bytes_per_stream: 1048576,
      retention_seconds: 86400,
    },
  ],
  get_result: [{ result_id: RETAINED_ID }],
  read_result_output: [{ result_id: RETAINED_ID, stream: 'diagnostic', offset: 0, limit: 16 }],
  delete_result: [{ result_id: RETAINED_ID }],
  publish_artifact: [
    {
      path: '/tmp/nominated',
      expected_size: 3,
      expected_sha256: ARTIFACT_MANIFEST.sha256,
      execution_id: ARTIFACT_MANIFEST.execution_association.execution_id,
      max_bytes: 8,
      retention_seconds: 86400,
    },
  ],
  get_artifact: [{ artifact_id: ARTIFACT_ID }],
  read_artifact: [{ artifact_id: ARTIFACT_ID, max_bytes: 4096 }],
  delete_artifact: [{ artifact_id: ARTIFACT_ID }],
  list_templates: [{}],
  // The document format, and the store on top of it (OPL-3568,
  // OPL-3789, OPL-3830). Both spellings of the ref tools, because `version` is a
  // parameter like any other and a call that never sends one is the gap the
  // parameter half of this test exists to see.
  get_template_schema: [{}],
  check_template: [{ document: 'apiVersion: mandala/v1' }],
  publish_template: [{ document: 'apiVersion: mandala/v1' }],
  get_template: [
    { namespace: 'acc-1', name: 'devbox' },
    { namespace: 'acc-1', name: 'devbox', version: '1.0.0' },
  ],
  retire_template: [
    { namespace: 'acc-1', name: 'devbox', version: '1.0.0', confirm: true },
    { namespace: 'acc-1', name: 'devbox', confirm: true },
  ],
  // Compiling one (OPL-3791, OPL-3794). `no_reuse` on one of the two,
  // for the same reason.
  build_template: [
    { document: 'apiVersion: mandala/v1' },
    { document: 'apiVersion: mandala/v1', no_reuse: true },
  ],
  // Both spellings, the way list_computers below is exercised: a build listing
  // fails closed on a degraded fleet like every other fan-out, and OPL-3840 is
  // what made the way out of it something a client can send.
  list_builds: [{}, { allow_partial: true }],
  get_build: [{ build_id: 'bld-1' }],
  watch_build: [{ build_id: 'bld-1' }],
  list_sizes: [{}],
  // The third shape is `state` (OPL-4554): a filter the control plane
  // reads off the listing, and one no other call would send.
  list_computers: [{}, { allow_partial: true }, { state: 'deleted' }],
  get_computer: [{}],
  use_computer: [{ computer_id: 'vm-1' }],
  start_computer: [{}],
  // The force is the whole of OPL-3748: without it this route is reachable and
  // a guest that will not shut down cleanly still has no second move.
  stop_computer: [{}, { force: true }],
  suspend_computer: [{}],
  restart_computer: [{}],
  // Two shapes, because a resize needs the computer stopped and a rename does
  // not, so the platform refuses them together.
  update_computer: [
    { name: 'renamed' },
    { cpu: 4, ram_mb: 4096, disk_gb: 40 },
    { idle_suspend_min: 30 },
  ],
  // All three sizing fields in one call, because the platform reads exactly
  // these three off a move and the parameter sweep below is what proves it. A
  // move is the sizing group and never a rename, so there is only one shape.
  move_computer: [{ ram_mb: 26000, cpu: 2, disk_gb: 40 }],
  list_moves: [{}],
  get_account: [{}],
  // Both bounds, because a call that names neither cannot show the parameter
  // sweep that this server can send either.
  get_usage: [{}, { from: '2026-08-01T00:00:00Z', to: '2026-08-22T00:00:00Z' }],
  // No arguments to sweep: the window belongs to the account, so there is no id
  // and nothing to filter by.
  get_retention: [{}],
  // The webhooks CRUD (OPL-4306). Every body field on the create and on the
  // update, because the parameter sweep is what proves this server can send
  // them; the other five routes are bodyless or take only the id.
  list_webhooks: [{}],
  create_webhook: [
    { url: 'https://ci.example.com/mandala' },
    {
      url: 'https://ci.example.com/mandala',
      description: 'CI',
      events: ['process.exited'],
      computers: ['vm-1'],
      enabled: false,
    },
  ],
  get_webhook: [{ webhook_id: 'whk-9f3c1a7e5b2d4c80' }],
  update_webhook: [
    {
      webhook_id: 'whk-9f3c1a7e5b2d4c80',
      url: 'https://ci.example.com/mandala2',
      description: 'CI',
      events: ['process.exited'],
      computers: ['vm-1'],
      enabled: true,
    },
  ],
  rotate_webhook_secret: [{ webhook_id: 'whk-9f3c1a7e5b2d4c80' }],
  test_webhook: [{ webhook_id: 'whk-9f3c1a7e5b2d4c80' }],
  list_webhook_deliveries: [{ webhook_id: 'whk-9f3c1a7e5b2d4c80' }],
  delete_webhook: [{ webhook_id: 'whk-9f3c1a7e5b2d4c80', confirm: true }],
  // SSH: the caller's keys, and one computer's switch. The name is sent on one
  // of the two adds, because the parameter sweep is what proves it can be.
  list_ssh_keys: [{}],
  add_ssh_key: [{ public_key: SSH_PUBLIC_KEY }, { public_key: SSH_PUBLIC_KEY, name: 'laptop' }],
  remove_ssh_key: [{ key_id: 'sshk-3c9a51d07be2f846', confirm: true }],
  get_computer_ssh: [{}],
  set_computer_ssh: [{ enabled: true }],
  wait_for_computer: [{ until: 'guest' }],
  get_desktop_url: [{}],
  // A named size and an explicit shape are alternatives, never both.
  create_computer: [
    {
      template: 'base',
      template_transfer: 'prepare-token',
      name: 'made',
      cpu: 2,
      ram_mb: 2048,
      disk_gb: 20,
      resolution: '1280x800',
    },
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

  // The env is the whole of OPL-3746: without an argument that reaches the
  // body, this route is reachable and a variable still has to be written into
  // the command line as `FOO=bar cmd`.
  exec: [
    { command: 'true', retain_output: true },
    { command: 'true' },
    {
      command: 'sleep 1',
      background: true,
      cwd: '/tmp',
      desktop: true,
      env: { NODE_ENV: 'production' },
    },
  ],
  get_execution: [{ execution_id: 'exec_0123456789abcdef0123456789abcdef' }],
  read_execution_output: [
    {
      execution_id: 'exec_0123456789abcdef0123456789abcdef',
      stdout_offset: 0,
      stderr_offset: 0,
      limit: 1024,
    },
  ],
  exec_poll: [{ pid: 4242 }],
  exec_kill: [{ pid: 4242 }],
  open_url: [{ url: 'https://example.com' }],
  list_windows: [{}, { include_all: true }],
  window_action: [
    { window_id: '0x2600003', action: 'focus' },
    { window_id: '0x2600003', action: 'move', x: 10, y: 20 },
    { window_id: '0x2600003', action: 'resize', width: 640, height: 480 },
  ],
  // The event stream (OPL-3926). Both land on `GET computers/:id`, which is
  // where `events_url` lives — the socket itself is not a route on this table
  // and never can be, for the reason the platform keeps it beside `V1_ROUTES`
  // rather than on it: the catch-all that serves the table cannot hold one open.
  // The fixture's opening frame says the desktop is already up, so the wait ends
  // on a synthesized computer.ready rather than on its timeout.
  wait_for_event: [{ types: ['computer.ready'], timeout_s: 1 }],
  poll_events: [{}],
  // A watch is a connection parameter, so this one reopens the socket before it
  // can answer — which is a second `GET computers/:id` on the same route, and
  // nothing new for the mirror. The fixture reports the tree armed in its
  // opening frame, so the call reaches its wait and times out saying nothing
  // changed, which is an answer rather than an error.
  wait_for_file_change: [{ path: '/home/user/project', timeout_s: 1 }],
  read_clipboard: [{}],
  write_clipboard: [{ text: 'on the clipboard' }],
  write_file: [{ path: '/home/user/a.txt', content: 'hello' }],
  // The offset is the parameter, and it is the whole of OPL-3740: without an
  // argument that turns into a Range this route is reachable and a file over
  // 64 MiB still is not.
  read_file: [{ path: '/home/user/a.txt' }, { path: '/home/user/a.txt', offset: 2 }],

  list_snapshots: [{}, { allow_partial: true, include_unfinished: true }],
  snapshot_holdings: [{}],
  // The name is the whole of OPL-3747: without an argument that reaches the
  // body, this route is reachable and every snapshot it takes is still
  // anonymous.
  create_snapshot: [{}, { memory: true, name: 'before-upgrade' }],
  restore_snapshot: [{ snapshot_id: 'snap-1', confirm: true }],
  clone_snapshot: [{ snapshot_id: 'snap-1' }, { snapshot_id: 'snap-1', name: 'copy' }],
  snapshot_schedule: [
    {},
    { set: { enabled: true, hour: 4, minute: 30, tz: 'UTC' } },
    { clear: true },
  ],
  delete_snapshot: [{ snapshot_id: 'snap-1', confirm: true }],

  list_directory: [{ path: '/home/user/é files' }],
  list_activities: [{}, { cursor: 'older:2 /+' }, { cursor: 'changes:3 /+', changes: true }],
  get_activity: [{ activity_id: ACTIVITY_ID }],
  get_activity_results: [{ activity_id: ACTIVITY_ID }],
  read_signals: [{}, { since: '', limit: 1 }, { since: 'signal:3 /+', limit: 17 }],
  run_agent_chat: [
    { messages: [{ role: 'user', content: 'open firefox' }] },
    {
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'open firefox' }] },
      ],
      model: 'claude-test',
      max_steps: 3,
    },
  ],
  run_agent: [
    { prompt: 'open firefox' },
    { prompt: 'open firefox', system: 'be brief', max_steps: 3 },
  ],
};

export type ExerciseEvidence = { tool: string; requests: Recorded[] };

/** A strict inventory check cannot be satisfied by a registered but uncalled tool. */
export function checkInventory(names: string[], exercise: typeof EXERCISE): void {
  const missing = names.filter((name) => !Object.hasOwn(exercise, name));
  const extra = Object.keys(exercise).filter((name) => !names.includes(name));
  if (missing.length || extra.length)
    throw new Error(
      `Exercise inventory mismatch: missing tools [${missing.join(', ')}]; unregistered tools [${extra.join(', ')}]`,
    );
}

/** Fresh in-process sessions prevent cached event reads from masking zero-request tools. */
export async function collectExercises(
  exercise = EXERCISE,
  connectTools = connect,
): Promise<ExerciseEvidence[]> {
  const platform = installFakePlatform();
  const config = {
    baseUrl: BASE,
    apiKey: 'com_fixture',
    modelKey: 'sk-ant-fixture',
    computerId: 'vm-1',
    tags: [],
    readOnly: false,
    lifecycle: true,
  };
  const evidence: ExerciseEvidence[] = [];
  try {
    const inventory = await connectTools(config);
    try {
      checkInventory(
        (await inventory.client.listTools()).tools.map((tool) => tool.name),
        exercise,
      );
    } finally {
      await inventory.close();
    }
    for (const [name, variants] of Object.entries(exercise)) {
      const connection = await connectTools(config);
      const requests: Recorded[] = [];
      try {
        for (const [index, args] of variants.entries()) {
          const before = platform.calls.length;
          let result: Awaited<ReturnType<typeof connection.call>>;
          try {
            result = await connection.call(name, args);
          } catch {
            throw new Error(
              `Tool ${name} variant ${index + 1} failed at the MCP protocol boundary`,
            );
          }
          if (result.isError)
            throw new Error(`Tool ${name} variant ${index + 1} returned an error`);
          const observed = platform.calls.slice(before);
          if (!observed.length)
            throw new Error(`Zero request coverage for tool ${name} variant ${index + 1}`);
          requests.push(...observed);
        }
        if (!requests.length) throw new Error(`Zero request coverage for tool ${name}`);
        evidence.push({ tool: name, requests });
      } finally {
        await connection.close();
      }
    }
    return evidence;
  } finally {
    platform.restore();
  }
}

/** Use captured HTTP pathnames, independent of mirror normalization or route tables. */
export function operationEvidence(evidence: ExerciseEvidence[]) {
  return evidence.map(({ tool, requests }) => ({
    tool,
    requests: requests.map((request) => {
      if (!request.pathname) throw new Error(`Missing concrete HTTP pathname for tool ${tool}`);
      return { method: request.method, path: request.pathname };
    }),
  }));
}
