import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type ServerConfig } from '../src/server.js';

export const BASE = 'https://api.test/api/v1';

export type Recorded = {
  method: string;
  path: string;
  /** Exact concrete HTTP pathname, including the API base. */
  pathname?: string;
  body?: unknown;
  query: URLSearchParams;
  /** Lower-cased, because a header name is compared case-insensitively. */
  headers: Record<string, string>;
};

export const RETAINED_ID = 'res_0123456789abcdef0123456789abcdef';
export const ARTIFACT_ID = 'art_0123456789abcdef0123456789abcdef';
export const ARTIFACT_BYTES = Buffer.from([0, 128, 255]);
const retainedPrefix = {
  bytes: 0,
  sha256: createHash('sha256').digest('hex'),
  source_offset: 0,
  next_source_offset: 0,
  end_reason: 'observed_eof',
};
export const RETAINED_MANIFEST = {
  version: 1,
  result_id: RETAINED_ID,
  kind: 'background-output',
  state: 'ready',
  account_id: 'acc-1',
  computer_id: 'vm-1',
  workspace_id: null,
  execution_id: 'exec_0123456789abcdef0123456789abcdef',
  source: 'volatile_guest_files',
  capture_started_at: '2026-09-16T12:00:00Z',
  captured_at: '2026-09-16T12:00:01Z',
  expires_at: '2026-09-17T12:00:00Z',
  execution_observation: { status: 'exited', observed_at: '2026-09-16T12:00:00.9Z', exit_code: -1 },
  stdout: retainedPrefix,
  stderr: retainedPrefix,
  diagnostic: {
    bytes: 0,
    sha256: retainedPrefix.sha256,
    source: 'wrapper',
    diagnostic_truncated: false,
  },
};
export const ARTIFACT_MANIFEST = {
  artifact_id: ARTIFACT_ID,
  kind: 'artifact',
  state: 'ready',
  computer_id: 'vm-1',
  workspace_id: null,
  created_at: '2026-09-16T12:00:01Z',
  expires_at: '2026-09-17T12:00:00Z',
  size: ARTIFACT_BYTES.length,
  sha256: createHash('sha256').update(ARTIFACT_BYTES).digest('hex'),
  execution_association: {
    kind: 'caller_selected',
    execution_id: RETAINED_MANIFEST.execution_id,
    verified_at: '2026-09-16T12:00:00Z',
  },
};
const COMPUTER = {
  id: 'vm-1',
  name: 'desk',
  status: 'running',
  os: 'linux',
  template: 'base',
  cpu: 2,
  ram_mb: 2048,
  resolution: '1280x800x24',
  vnc: {
    url: 'wss://app.test/vnc?token=SECRET-CONTROL',
    view_url: 'wss://app.test/vnc?token=view-only',
    embed_url: 'https://app.test/embed/vm-1',
    // The event stream (OPL-3785). Carries the controlling credential
    // like `url` does, which is why `withoutCredentials` has to keep taking the
    // whole `vnc` object rather than a named list of keys.
    events_url: 'wss://app.test/api/v1/computers/vm-1/events?token=SECRET-CONTROL',
    // Present and false, the way the platform sends it (OPL-3870): a computer
    // whose QEMU has no vdagent channel, or whose image was never verified to
    // carry the agent. Absent would be a different fixture — this server reads
    // that as false too, and one that is never sent cannot show that the field
    // is read at all.
    clipboard: false,
  },
};

/**
 * The same computer with the clipboard bridge provisioned.
 *
 * A second fixture rather than a flag on the first, because `get_desktop_url`
 * answers two quite different paragraphs off this one boolean and only one of
 * them can be reached per response. The prose scan needs both: the branch this
 * fixture reaches is the shorter one, and the branch the default reaches names
 * five tools it must not get wrong.
 */
const BRIDGED_COMPUTER = {
  ...COMPUTER,
  id: 'vm-bridged',
  vnc: { ...COMPUTER.vnc, clipboard: true },
};

/**
 * A move, as the platform answers it (OPL-3766).
 *
 * Two of them, because the route and the poll answer different moments of the
 * same operation and a stub that returned one shape for both would let a tool
 * that reads `live` off the wrong response pass. The POST is the 202 — the move
 * as it stood when it was accepted — and the listing is where it ended up.
 */
const MOVE_STARTED = {
  computer_id: 'vm-1',
  state: 'moving',
  detail: '',
  live: true,
  ram_mb: 26000,
  started_at: '2026-08-23T02:00:12.699Z',
};
const MOVE_DONE = {
  ...MOVE_STARTED,
  state: 'done',
  live: false,
  finished_at: '2026-08-23T02:00:17.336Z',
};

const SNAPSHOT = { id: 'snap-1', computer_id: 'vm-1', name: 's', kind: 'disk', state: 'durable' };

/**
 * The same capture as the POST answers it: a 202 and a placeholder (OPL-4562).
 *
 * Two fixtures for one snapshot, for the reason the two moves above are two
 * fixtures. The route and the poll answer different moments of the same
 * operation, and a stub that returned the finished row for both would let a
 * tool that never polls at all pass — which is precisely the defect this
 * server had. The id is SNAPSHOT's, because the id allocated before the copy is
 * the one the finished snapshot keeps, and matching on it is the whole poll.
 */
const CAPTURING_SNAPSHOT = { ...SNAPSHOT, state: 'capturing' };

const HOLDINGS = { count: 2, size_bytes: 6_100_000_000, fingerprint: 'fp-abc123' };

/** The plan's retention window. Every tier non-zero, so a tool that drops one shows it. */
export const RETENTION = { daily: 7, weekly: 4, monthly: 12 };

/** One OpenSSH public key line, the shape add_ssh_key sends. */
export const SSH_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMxlN5MDRT9cXdHi871o7Ty3dKfNLt8mNmjSWtwv6DTw you@laptop';

/** One registered SSH key as the platform lists it: canonical, no comment. */
export const SSH_KEY = {
  id: 'sshk-3c9a51d07be2f846',
  name: 'laptop',
  public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMxlN5MDRT9cXdHi871o7Ty3dKfNLt8mNmjSWtwv6DTw',
  fingerprint: 'SHA256:+GiGZKWHEUZeM+kzujljZNiEU86lD9XvR2QBUw90/r8',
  key_type: 'ssh-ed25519',
  created_at: '2026-09-16T12:00:00Z',
  last_used_at: null,
};

/** One computer's SSH setting, as a read and a write both answer it. */
export const SSH_SETTING = {
  computer: 'vm-1',
  enabled: true,
  available: true,
  pending: false,
  key_count: 1,
  keys_pushed: 1,
  error: null,
};

/** One computer's secret bindings, as a read answers them: ids only, never a value. */
export const SECRET_BINDINGS = {
  secrets: [
    {
      secret_id: 'csec-0123456789abcdef',
      revision_id: 'csr-0123456789abcdef01234567',
      env: 'OPENAI_API_KEY',
    },
  ],
  version: 3,
};

/**
 * One webhook subscription as the platform lists it — never with a secret. The
 * health fields are all non-null, so a sentence that reads one shows it.
 */
export const WEBHOOK = {
  id: 'whk-9f3c1a7e5b2d4c80',
  url: 'https://ci.example.com/mandala',
  description: 'CI',
  events: ['process.exited', 'computer.ready'],
  computers: [],
  enabled: true,
  disabled_reason: null,
  disabled_at: null,
  last_success_at: '2026-09-01T12:00:05.000Z',
  last_failure_at: null,
  last_status: 200,
  created_at: '2026-09-01T11:00:00.000Z',
  updated_at: '2026-09-01T11:00:00.000Z',
};

/** The same subscription as a create or a rotate answers it: with the secret. */
export const WEBHOOK_CREATED = {
  ...WEBHOOK,
  secret: 'whsec_bWFuZGFsYS13ZWJob29rLXRlc3QtdmVjdG9yLWtleSE=',
};

/** One delivery, accepted on the first attempt. */
export const WEBHOOK_DELIVERY = {
  id: 'whd-9f3c1a7e5b2d4c80',
  event_type: 'process.exited',
  computer: 'vm-1',
  cursor: 'mfc9z1k2x5ab.7:42',
  state: 'delivered',
  attempts: 1,
  next_at: null,
  attempted_at: '2026-09-01T12:00:04.000Z',
  last_status: 200,
  last_error: null,
  delivered_at: '2026-09-01T12:00:05.000Z',
  created_at: '2026-09-01T12:00:03.000Z',
};

/**
 * One usage report, complete: both shortfall flags false and the breakdown
 * present. The degraded shapes are built in the test that is about them.
 */
export const USAGE = {
  period: {
    start: '2026-08-04T00:00:00.000Z',
    end: '2026-09-04T00:00:00.000Z',
    source: 'subscription',
  },
  from: '2026-08-04T00:00:00.000Z',
  to: '2026-08-22T12:00:00.000Z',
  usage: {
    run_hours: 12.5,
    vcpu_hours: 25,
    ram_gb_hours: 50,
    snapshot_gb_hours: 96,
    snapshot_gb_months: 0.13,
    disk_gb_hours: 480,
    disk_gb_months: 0.66,
    computers: [{ id: 'vm-1', name: 'scratch', run_hours: 12.5, vcpu_hours: 25, ram_gb_hours: 50 }],
  },
  degraded: false,
  unmetered: false,
  reported_through: '2026-08-20',
};

export const ACTIVITY_ID = 'act_0123456789abcdef0123456789abcdef';
export const ACTIVITY = {
  activity_id: ACTIVITY_ID,
  account_id: 'acc-1',
  computer_id: 'vm-1',
  workspace_id: null,
  channel: 'api',
  route: 'exec',
  action: 'exec',
  state: 'exited',
  received_at: '2026-09-16T12:00:00Z',
  observed_at: '2026-09-16T12:00:01Z',
  dispatched_at: '2026-09-16T12:00:00Z',
  elapsed_ms: 1000,
  revision: 3,
  has_results: true,
  http_status: 200,
  exit_code: -1,
  execution_id: RETAINED_MANIFEST.execution_id,
};
export const ACTIVITY_PAGE = {
  items: [ACTIVITY],
  next_cursor: null,
  changes_cursor: 'revision:3',
  gap: false,
  health: {
    recording_started_at: '2026-09-01T00:00:00Z',
    earliest_retained_at: ACTIVITY.received_at,
    count_truncated: false,
    age_truncated: true,
    capture: 'available',
    completeness: 'best-effort',
    gap_at: null,
    recovered_at: null,
  },
};
export const ACTIVITY_RESULTS = {
  activity_id: ACTIVITY_ID,
  revision: 3,
  more: true,
  items: [
    {
      id: ARTIFACT_ID,
      kind: 'artifact',
      association: 'caller_selected_artifact',
      availability: 'available',
      captured_at: ARTIFACT_MANIFEST.created_at,
      expires_at: ARTIFACT_MANIFEST.expires_at,
      bytes: 3,
    },
    {
      id: RETAINED_ID,
      kind: 'background-output',
      association: 'background_execution_output',
      availability: 'unavailable',
    },
  ],
};
export const SIGNAL_PAGE = {
  computer: 'vm-1',
  from: 'head:1',
  cursor: 'head:1',
  events: [],
  more: false,
  baseline: true,
  supported: [
    'process.exited',
    'computer.started',
    'computer.stopped',
    'computer.suspended',
    'computer.idle',
  ],
  retention: 'ephemeral',
};
export const CHAT_COMPLETION = {
  id: 'chatcmpl-fixture',
  object: 'chat.completion',
  created: 1789552800,
  model: 'mandala-agent',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 },
  agent: { computer_id: 'vm-1', steps: 1, stop: 'end_turn' },
};

const AGENT_STREAM =
  'event: step\ndata: {"n":1,"tool":"computer","action":"screenshot","detail":"took a screenshot"}\n\n' +
  'event: done\ndata: {"steps":1,"stop":"end_turn","text":"Done.","usage":{}}\n\n';

/**
 * A stand-in for the platform, recording what was asked of it.
 *
 * Answers the shape each route answers rather than one generic body, because
 * the tools read fields off these responses and a uniform `{}` would let a tool
 * that misreads its own route pass.
 */
export function installFakePlatform(): {
  calls: Recorded[];
  restore: () => void;
  /**
   * What `GET computers/:id` says this computer is doing.
   *
   * Mutable, because a computer changing state under an open stream is a fixture
   * rather than a fixed value: the event socket re-reads this record on every
   * reconnect, which is how a suspend reaches a websocket client at all.
   */
  state: { status: string };
} {
  const calls: Recorded[] = [];
  const state = { status: 'running' };
  // Snapshots a DELETE has been accepted for, so that `GET /snapshots` stops
  // listing them. A deletion is a 202 now and the row going is the only thing
  // that means it finished (OPL-4572), so a fixture whose row never
  // goes is one where a tool that waits for it hangs and a tool that does not
  // wait passes — the fixture bug OPL-4568 found on the capture side, in the
  // mirror. Per-instance, like `state`: installFakePlatform is called per test.
  const deleted = new Set<string>();
  const real = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    // Only the platform. The HTTP-transport tests stand a real server up on
    // localhost and talk to it with this same global; swallowing those made
    // every one of them pass against a stub of the wrong thing.
    if (url.host !== new URL(BASE).host) return real(input as never, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body) {
      body = '<raw bytes>';
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    calls.push({ method, path, pathname: url.pathname, body, query: url.searchParams, headers });
    return respond(method, path, headers, state.status, deleted, url.searchParams, body);
  }) as typeof fetch;

  return {
    calls,
    state,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/**
 * One published template, in the platform's own spelling (OPL-3789).
 *
 * `document` as an OBJECT, not the canonical string the store keeps: the
 * platform parses it back on the way out, so a fixture holding the string would
 * let a tool that forgot to expect an object pass.
 */
const PUBLISHED_TEMPLATE = {
  ref: 'acc-1/devbox@1.0.0',
  doc_digest: 'sha256:aaaa',
  document: { apiVersion: 'mandala/v1', kind: 'Template' },
  template: { name: 'devbox', label: 'My desktop', os: 'linux', cpu: 2, ram_mb: 4096, disk_gb: 30 },
  versions: ['1.0.0'],
  published_at: '2026-08-26T12:00:00.000Z',
};

/**
 * What a retire took away (OPL-3830).
 *
 * `templates` and `refs_claimed` deliberately differ: a retired ref still
 * counts, and a fixture where the two agreed would let a tool that read one
 * field for both pass.
 */
const RETIRED_TEMPLATES = {
  retired: ['acc-1/devbox@1.0.0'],
  retired_at: '2026-08-26T13:00:00.000Z',
  versions: [],
  templates: 0,
  refs_claimed: 1,
};

const TEMPLATE_CHECK = {
  valid: true,
  ref: 'acc-1/devbox@1.0.0',
  doc_digest: 'sha256:aaaa',
  build_digest: 'sha256:bbbb',
};

const TEMPLATE_BUILD = {
  id: 'bld-1',
  ref: 'acc-1/devbox@1.0.0',
  status: 'running',
  started_at: '2026-08-26T12:00:00.000Z',
};

const BUILD_PROGRESS = {
  id: 'bld-1',
  status: 'succeeded',
  done: true,
  phase: 'published',
  step: 2,
  of: 2,
  steps: [
    { n: 1, kind: 'apt', label: 'ripgrep', status: 'done' },
    { n: 2, kind: 'finish', label: 'cleanup', status: 'done' },
  ],
  note: '',
  error: '',
  updated_at: '2026-08-26T12:15:00.000Z',
};

/** A build's event stream: one `progress` that is news, then the `done`. */
const BUILD_STREAM =
  `event: progress\ndata: ${JSON.stringify({ ...BUILD_PROGRESS, done: false, status: 'running', phase: 'copying' })}\n\n` +
  `event: done\ndata: ${JSON.stringify(BUILD_PROGRESS)}\n\n`;

/** Exec output, encoded the way the platform encodes it. */
export const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * What the platform reports as held against the running pool for a given status
 * (platform OPL-4630), so a fixture that says `suspended` says the whole of what
 * a suspended computer looks like.
 *
 * The real rule is a reservation OR a live process, and a reservation is taken
 * before the process exists — so a computer mid-start reads `stopped` or
 * `suspended` with a NON-zero value here. That case is not the default because
 * it is not the common one; a test that wants it overrides the field, and
 * `running_ram_mb: 0` on a stopped fixture is the fixture saying "and nobody is
 * starting it", which is what the waits key on.
 */
const runningRamFor = (status: string): number => (status === 'running' ? COMPUTER.ram_mb : 0);

function respond(
  method: string,
  path: string,
  headers: Record<string, string>,
  status = 'running',
  deleted: Set<string> = new Set(),
  query: URLSearchParams = new URLSearchParams(),
  body?: unknown,
): Response {
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

  const computerID = path.split('/')[2];
  if (path === '/chat/completions' && method === 'POST')
    return json({
      ...CHAT_COMPLETION,
      agent: {
        ...CHAT_COMPLETION.agent,
        computer_id: (body as { computer_id?: string })?.computer_id ?? 'vm-1',
      },
    });
  if (path.endsWith('/files/list') && method === 'GET')
    return json({
      path: query.get('path'),
      entries: [
        { name: 'résumé final.txt', type: 'file', size_bytes: 12 },
        { name: 'link', type: 'symlink' },
      ],
      truncated: false,
      skipped: 0,
    });
  if (/^\/computers\/[^/]+\/activities$/.test(path) && method === 'GET')
    return json({ ...ACTIVITY_PAGE, items: [{ ...ACTIVITY, computer_id: computerID }] });
  if (/^\/computers\/[^/]+\/activities\/act_[a-f0-9]{32}\/results$/.test(path) && method === 'GET')
    return json({ ...ACTIVITY_RESULTS, activity_id: path.split('/')[4] });
  if (/^\/computers\/[^/]+\/activities\/act_[a-f0-9]{32}$/.test(path) && method === 'GET')
    return json({ ...ACTIVITY, computer_id: computerID, activity_id: path.split('/')[4] });
  if (path.endsWith('/signals') && method === 'GET')
    return json({
      ...SIGNAL_PAGE,
      computer: computerID,
      from: query.get('since') || SIGNAL_PAGE.cursor,
      baseline: !query.get('since'),
    });
  if (path.endsWith('/screenshot')) {
    // A one-pixel PNG, so the image content the tool builds is a real image.
    return new Response(Buffer.from(PNG_1PX, 'base64'), {
      headers: { 'Content-Type': 'image/png' },
    });
  }
  if (path.endsWith('/agent')) {
    return new Response(AGENT_STREAM, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (path.endsWith('/files')) {
    if (method === 'PUT') return json({ path: '/home/user/a.txt', bytes: 5 });
    // Served as the platform serves it — a window, with the headers that say
    // which one. A stub that answered 200 with the whole body whatever the
    // Range said would let every paging bug through, since read_file's own
    // reading of a response is the thing under test.
    return download('hello', headers.range);
  }
  // Output as base64, the way the platform now sends it (OPL-4542). A fixture
  // still holding plain `stdout` would let a server that never decodes pass —
  // and against a current daemon that server reads every command as empty.
  const executionId = 'exec_0123456789abcdef0123456789abcdef';
  if (path.endsWith(`/executions/${executionId}/retained-output`))
    return json(RETAINED_MANIFEST, 201);
  if (path.endsWith(`/results/${RETAINED_ID}`))
    return method === 'DELETE' ? new Response(null, { status: 204 }) : json(RETAINED_MANIFEST);
  if (path.endsWith(`/results/${RETAINED_ID}/output`)) {
    const offset = query.get('offset') ?? '0';
    return new Response(null, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '0',
        'X-Result-Offset': offset,
        'X-Result-Next-Offset': offset,
        'X-Result-EOF': 'true',
      },
    });
  }
  if (path.endsWith('/artifacts') && method === 'POST') return json(ARTIFACT_MANIFEST, 201);
  if (path.endsWith(`/artifacts/${ARTIFACT_ID}`))
    return method === 'DELETE' ? new Response(null, { status: 204 }) : json(ARTIFACT_MANIFEST);
  if (path.endsWith(`/artifacts/${ARTIFACT_ID}/download`))
    return new Response(ARTIFACT_BYTES, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(ARTIFACT_BYTES.length),
      },
    });
  if (path.endsWith(`/executions/${executionId}/output`))
    return json({
      execution_id: executionId,
      stdout_b64: '',
      stderr_b64: '',
      stdout_offset: Number(query.get('stdout_offset')),
      stderr_offset: Number(query.get('stderr_offset')),
      stdout_more: false,
      stderr_more: false,
      diagnostic_b64: '',
      diagnostic_truncated: false,
    });
  if (path.endsWith(`/executions/${executionId}`))
    return json({
      execution_id: executionId,
      computer_id: 'vm-1',
      pid: 4242,
      status: 'running',
      started_at: '2026-09-15T12:00:00Z',
      output_source: 'volatile_guest_files',
    });
  if (path.endsWith('/exec')) {
    return json({
      exit_code: 0,
      stdout_b64: b64('ok\n'),
      stderr_b64: '',
      timed_out: false,
      pid: 4242,
    });
  }
  if (/\/exec\/\d+$/.test(path)) {
    return json({
      pid: 4242,
      running: false,
      exited: true,
      exit_code: 0,
      stdout_b64: b64('done\n'),
      stdout_offset: 5,
    });
  }
  if (path.endsWith('/input')) return json({ ok: true, x: 1, y: 2, known: true });
  // Both verbs on one path, told apart by the method: the read answers text and
  // the write answers an ack, and a stub giving both one shape would let a tool
  // that reads the wrong field pass.
  if (path.endsWith('/clipboard')) {
    return json(method === 'GET' ? { text: 'on the clipboard' } : { ok: true });
  }
  if (path.endsWith('/windows')) {
    return json({ windows: [{ id: '0x2600003', title: 'T', class: 'Xfce4-terminal' }] });
  }
  if (/\/windows\/[^/]+$/.test(path))
    return json({ ok: true, window: { id: '0x2600003', x: 305 } });
  if (path.endsWith('/schedule')) return json({ enabled: true, hour: 4, minute: 0, tz: 'UTC' });
  if (path === '/templates/schema') return json({ $id: `${BASE}/templates/schema` });
  if (path === '/templates/validate') return json(TEMPLATE_CHECK);
  if (path === '/builds/bld-1/events') {
    return new Response(BUILD_STREAM, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (path.endsWith('/progress')) return json(BUILD_PROGRESS);
  if (path === '/builds')
    return json(method === 'GET' ? [TEMPLATE_BUILD] : TEMPLATE_BUILD, method === 'GET' ? 200 : 202);
  if (/^\/builds\/[^/]+$/.test(path)) return json(TEMPLATE_BUILD);
  // The store's ref route is THREE segments and is therefore not `/templates`.
  // DELETE and GET answer different shapes, which is the point: a retire has no
  // document left to hand back.
  if (/^\/templates\/[^/]+\/[^/]+$/.test(path)) {
    return json(method === 'DELETE' ? RETIRED_TEMPLATES : PUBLISHED_TEMPLATE);
  }
  // A publish is a POST to the collection and answers with the one template it
  // stored, the same way the snapshot POST below does.
  if (path.endsWith('/templates')) {
    return method === 'GET'
      ? json([{ name: 'base', os: 'linux', cpu: 2 }])
      : json(PUBLISHED_TEMPLATE, 201);
  }
  if (path.endsWith('/sizes'))
    return json([
      {
        id: 'small',
        label: 'Small',
        template: 'base',
        cpu: 2,
        ram_mb: 2048,
        disk_gb: 20,
        allowed: true,
        cheapest_plan: 'solo',
      },
    ]);
  // Three different answers behind one suffix, and they are worth keeping
  // apart. GET /snapshots is the account's list; GET computers/:id/snapshots is
  // that computer's HOLDINGS — a count, a total and a fingerprint, never the
  // snapshots themselves; POST there captures one. A stub that answered all
  // three alike would let a tool reading the wrong shape pass.
  // Before the computer routes, and `/moves` before `/move` would be a clash if
  // either were a prefix of the other — they are not, and the two are kept
  // adjacent so that stays visible.
  if (path === '/account' && method === 'GET') return json(ACCOUNT_QUOTA);
  if (path === '/usage') return json(USAGE);
  if (path === '/retention') return json(RETENTION);
  // The webhooks resource (OPL-4306). The two answers that carry the secret
  // are the create and the rotate, and only those; the test is a 202 with a
  // queued delivery, the way the platform answers it.
  if (path === '/webhooks')
    return json(method === 'GET' ? [WEBHOOK] : WEBHOOK_CREATED, method === 'GET' ? 200 : 201);
  if (path.startsWith('/webhooks/')) {
    if (path.endsWith('/rotate')) return json(WEBHOOK_CREATED);
    if (path.endsWith('/test'))
      return json(
        {
          ...WEBHOOK_DELIVERY,
          event_type: 'webhook.test',
          computer: '',
          state: 'pending',
          attempts: 0,
          last_status: null,
          delivered_at: null,
        },
        202,
      );
    if (path.endsWith('/deliveries')) return json([WEBHOOK_DELIVERY]);
    return json(method === 'DELETE' ? { ok: true } : WEBHOOK);
  }
  // SSH: the caller's keys (201 on an add, an ack on a remove), and one
  // computer's setting, which a read and a write both answer in full.
  if (path === '/ssh-keys')
    return json(method === 'GET' ? [SSH_KEY] : SSH_KEY, method === 'GET' ? 200 : 201);
  if (path.startsWith('/ssh-keys/')) return json({ ok: true });
  // The computer is the one in the path and a write answers what it was sent,
  // so a tool that ignored either would be caught rather than echoed a fixture.
  // A PUT that did not send a boolean `enabled` gets an answer no tool may
  // accept as a setting, so dropping the body fails whichever way it was asked.
  const ssh = /^\/computers\/([^/]+)\/ssh$/.exec(path);
  if (ssh) {
    const sent = (body as { enabled?: unknown } | undefined)?.enabled;
    if (method === 'PUT' && typeof sent !== 'boolean')
      return json({ error: 'enabled must be true or false' });
    return json({
      ...SSH_SETTING,
      computer: decodeURIComponent(ssh[1]),
      enabled: method === 'PUT' ? sent : SSH_SETTING.enabled,
    });
  }
  // Secret bindings. A write answers what it was sent, pinned at a revision
  // (the one it named, or a fixed "latest"), one version on from the read; a
  // PUT without a `secrets` list gets an answer no tool may read as bindings.
  if (/^\/computers\/[^/]+\/secrets$/.test(path)) {
    if (method !== 'PUT') return json(SECRET_BINDINGS);
    const sent = (body as { secrets?: unknown } | undefined)?.secrets;
    if (!Array.isArray(sent)) return json({ error: '`secrets` is required' });
    return json({
      secrets: sent.map((b: { secret_id: string; env: string; revision_id?: string }) => ({
        secret_id: b.secret_id,
        env: b.env,
        revision_id: b.revision_id ?? 'csr-latest000000000000000000',
      })),
      version: SECRET_BINDINGS.version + 1,
    });
  }
  if (path === '/moves') return json({ moves: [MOVE_DONE] });
  if (path.endsWith('/move')) return json(MOVE_STARTED, 202);
  // A deletion is accepted, not done: 202 with the row that goes when the work
  // finishes, and the listing stops carrying it from then on. Two segments
  // exactly, so `/snapshots/:id/restore` and `/snapshots/:id/clone` are not this.
  if (method === 'DELETE' && /^\/snapshots\/[^/]+$/.test(path)) {
    const id = path.slice('/snapshots/'.length);
    deleted.add(decodeURIComponent(id));
    return json({ ...SNAPSHOT, id: decodeURIComponent(id) }, 202);
  }
  if (path === '/snapshots') return json(deleted.has(SNAPSHOT.id) ? [] : [SNAPSHOT]);
  if (path.endsWith('/snapshots')) {
    return method === 'GET' ? json(HOLDINGS) : json(CAPTURING_SNAPSHOT, 202);
  }
  if (path.endsWith('/computers'))
    return json(
      method === 'GET'
        ? [{ ...COMPUTER, status, running_ram_mb: runningRamFor(status) }]
        : { ...COMPUTER, running_ram_mb: runningRamFor(COMPUTER.status) },
    );
  // The four power actions answer the platform's Ack and not a computer record
  // (apidoc: `response: ref('Ack')` on each). The catch-all below answered a
  // record for them, so the server's formatting of the real answer — a
  // computer with no name, id or status — was never seen here (OPL-3914).
  if (/\/computers\/[^/]+\/(start|stop|suspend|restart)$/.test(path)) return json({ ok: true });
  // Before the catch-all, which answers COMPUTER for every id there is.
  if (path === '/computers/vm-bridged') return json(BRIDGED_COMPUTER);
  return json({ ...COMPUTER, status, running_ram_mb: runningRamFor(status) });
}

/**
 * A file download, answering a `Range` the way the platform's does.
 *
 * 206 with a `Content-Range` for a range that names a byte the file has, 416
 * with `bytes *\/<size>` for one that does not, 200 for a request without a
 * range. The window is trimmed rather than refused when it runs past the end,
 * because that is the behaviour a caller has to be able to survive — see
 * the platform's own guest-file path resolution.
 */
export function download(content: string | Uint8Array, range?: string): Response {
  const body = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain',
    'Content-Disposition': 'attachment; filename="a.txt"',
    'Accept-Ranges': 'bytes',
  };
  const m = range ? /^bytes=(\d+)-(\d*)$/.exec(range.trim()) : null;
  if (!m) {
    return new Response(body, {
      headers: { ...headers, 'Content-Length': String(body.length) },
    });
  }
  const start = Number(m[1]);
  if (start >= body.length) {
    return new Response(
      JSON.stringify({ error: `that range is outside the file, which is ${body.length} bytes` }),
      {
        status: 416,
        headers: {
          'Content-Type': 'application/json',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${body.length}`,
        },
      },
    );
  }
  const asked = m[2] === '' ? body.length - 1 : Number(m[2]);
  const end = Math.min(asked, body.length - 1);
  const window = body.subarray(start, end + 1);
  return new Response(window, {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(window.length),
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
    },
  });
}

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A stand-in for the platform's event socket (OPL-3785).
 *
 * The one part of this server that is not `fetch`, so it is the one part
 * `installFakePlatform` cannot answer for: a websocket is not a request, and
 * replacing the global would not see it. Frames are pushed by the test rather
 * than scripted here, because what these tests are about is what the server
 * does BETWEEN frames — the order they arrive in is the fixture.
 */
export class FakeSocket {
  readonly url: string;
  closed = false;
  /**
   * Whether this connection has sent its opening frame.
   *
   * Exposed because a nomination REOPENS the socket, so a test that drives
   * frames onto "the newest socket" has to know that the newest one has
   * greeted — otherwise it races the factory's own `setTimeout` and delivers
   * an event to a connection the server has not been introduced to yet.
   */
  greeted = false;
  readonly #listeners = new Map<string, Set<(ev?: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  /** The `since` this connection asked to resume from, if any. */
  get since(): string | null {
    return new URL(this.url).searchParams.get('since');
  }

  /** The trees this connection nominated, in the order it wrote them. */
  get watches(): string[] {
    return new URL(this.url).searchParams.getAll('watch');
  }

  // The overloads the server's structural `EventSocket` asks for, over one
  // implementation. Without them this class is not assignable to it, and the
  // seam the whole file exists to fill does not typecheck.
  addEventListener(type: 'open', fn: () => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', fn: () => void): void;
  addEventListener(type: 'close', fn: () => void): void;
  addEventListener(type: string, fn: (ev: never) => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(fn as (ev?: unknown) => void);
    this.#listeners.set(type, set);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#fire('close');
  }

  /** The handshake completing, which is not the opening frame. */
  open(): void {
    this.#fire('open');
  }

  /** One text frame, as the platform writes them. */
  send(frame: unknown): void {
    this.#fire('message', { data: JSON.stringify(frame) });
  }

  /** A refused upgrade: an error with nothing readable on it, then a close. */
  fail(): void {
    this.#fire('error');
    this.close();
  }

  #fire(type: string, ev?: unknown): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(ev);
  }
}

/** The opening frame a computer with a working guest watcher sends. */
export const HELLO = {
  type: 'hello',
  computer: 'vm-1',
  cursor: 'cur-0',
  ready: true,
  events: [
    'window.opened',
    'window.closed',
    'window.focused',
    'window.blurred',
    'clipboard.changed',
    // On every Linux computer with a terminal channel, including the images too
    // old to carry the X bindings the desktop watcher needs — which is the
    // third case in the platform's capability list (OPL-3927). The default
    // fixture is a fully capable computer, so it has both halves.
    'file.changed',
    'process.exited',
    'computer.ready',
    'computer.idle',
    'computer.started',
    'computer.stopped',
    'computer.suspended',
  ],
  windows: [],
};

/**
 * A socket factory that hands back sockets the test can drive.
 *
 * `hello` is sent on a turn of the event loop rather than inside the factory,
 * because the server attaches its listeners after the factory returns — a frame
 * delivered synchronously would arrive before anything was listening, which is
 * a race no real socket can produce and every test would then be written around.
 */
export function fakeEvents(
  hello: Record<string, unknown> | null = {},
  /**
   * Whether a nominated tree comes back already armed.
   *
   * `true` by default because that is the shape most tests are not about — a
   * tree somebody has watched before, which the host reports as live in the
   * opening frame with no event to follow. The arming path is its own fixture:
   * pass `false` and drive `{watch, armed: true}` onto the socket by hand,
   * which is what the guest actually does.
   */
  armed = true,
) {
  const sockets: FakeSocket[] = [];
  const factory = (url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    if (hello !== null) {
      setTimeout(() => {
        if (socket.closed) return;
        socket.open();
        // Echoed back the way the host echoes it: `watching` is ABSENT when
        // nothing was nominated, and present as `{path, armed}` when something
        // was. A fake that always sent the field would hide the case this
        // server has to tell apart — a host that ignored the nomination.
        const watches = socket.watches;
        const watching = watches.length
          ? { watching: watches.map((path) => ({ path, armed })) }
          : {};
        socket.send({ ...HELLO, ...watching, ...hello });
        socket.greeted = true;
      }, 0);
    }
    return socket;
  };
  return {
    factory,
    sockets,
    /** The connection now open — the newest, since each replaces the last. */
    last: () => sockets[sockets.length - 1],
  };
}

/** A connected client and server pair over an in-memory transport. */
export async function connect(cfg: Partial<ServerConfig> = {}) {
  const server = createServer({
    apiKey: 'com_test',
    baseUrl: BASE,
    computerId: 'vm-1',
    ...cfg,
    // After the spread, not before it: `{webSocket: undefined}` is what a
    // caller who did not mention sockets passes, and it would otherwise
    // overwrite this with nothing and send every test at undici.
    webSocket: cfg.webSocket ?? fakeEvents().factory,
  });
  const client = new Client({ name: 'test', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    server,
    call: (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Synthetic public account quota report; partial variants are tested separately. */
export const ACCOUNT_QUOTA = {
  scope: 'account',
  advisory: true,
  observed_at: '2026-09-16T12:00:00.000Z',
  plan: { id: 'starter', label: 'Starter' },
  limits: {
    max_computers: 5,
    vcpu_pool: 16,
    ram_pool_mb: 32768,
    disk_pool_gb: 200,
    snapshot_storage_bytes: 107374182400,
  },
  per_computer: { max_vcpu: 8, max_ram_mb: 16384, max_disk_gb: 100 },
  capabilities: { windows: false },
  complete: { computers: true, snapshots: true },
  usage: {
    kept_computers: 2,
    configured_vcpu: 6,
    configured_disk_gb: 60,
    running_or_reserved_computers: 1,
    running_or_reserved_vcpu: 2,
    running_or_reserved_ram_mb: 4096,
    snapshot_storage_bytes: 1073741825,
  },
  remaining: {
    kept_computers: 3,
    configured_vcpu: 10,
    configured_disk_gb: 140,
    running_or_reserved_ram_mb: 28672,
    snapshot_storage_bytes: 106300440575,
  },
};
