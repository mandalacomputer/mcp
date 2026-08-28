import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type ServerConfig } from '../src/server.js';

export const BASE = 'https://api.test/api/v1';

export type Recorded = {
  method: string;
  path: string;
  body?: unknown;
  query: URLSearchParams;
  /** Lower-cased, because a header name is compared case-insensitively. */
  headers: Record<string, string>;
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
  },
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

const HOLDINGS = { count: 2, size_bytes: 6_100_000_000, fingerprint: 'fp-abc123' };

/** The plan's retention window. Every tier non-zero, so a tool that drops one shows it. */
export const RETENTION = { daily: 7, weekly: 4, monthly: 12 };

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
export function installFakePlatform(): { calls: Recorded[]; restore: () => void } {
  const calls: Recorded[] = [];
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
    calls.push({ method, path, body, query: url.searchParams, headers });
    return respond(method, path, headers);
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/**
 * One published template, in the platform's own spelling (platform OPL-3789).
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
 * What a retire took away (platform OPL-3830).
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

function respond(method: string, path: string, headers: Record<string, string>): Response {
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

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
  if (path.endsWith('/exec')) {
    return json({ exit_code: 0, stdout: 'ok\n', stderr: '', timed_out: false, pid: 4242 });
  }
  if (/\/exec\/\d+$/.test(path)) {
    return json({ pid: 4242, running: false, exited: true, exit_code: 0, stdout: 'done\n' });
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
  if (path === '/usage') return json(USAGE);
  if (path === '/retention') return json(RETENTION);
  if (path === '/moves') return json({ moves: [MOVE_DONE] });
  if (path.endsWith('/move')) return json(MOVE_STARTED, 202);
  if (path === '/snapshots') return json([SNAPSHOT]);
  if (path.endsWith('/snapshots')) return json(method === 'GET' ? HOLDINGS : SNAPSHOT);
  if (path.endsWith('/computers')) return json(method === 'GET' ? [COMPUTER] : COMPUTER);
  return json(COMPUTER);
}

/**
 * A file download, answering a `Range` the way the platform's does.
 *
 * 206 with a `Content-Range` for a range that names a byte the file has, 416
 * with `bytes *\/<size>` for one that does not, 200 for a request without a
 * range. The window is trimmed rather than refused when it runs past the end,
 * because that is the behaviour a caller has to be able to survive — see
 * `resolve` in the platform's server/guestfile.go.
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

/** A connected client and server pair over an in-memory transport. */
export async function connect(cfg: Partial<ServerConfig> = {}) {
  const server = createServer({
    apiKey: 'com_test',
    baseUrl: BASE,
    computerId: 'vm-1',
    ...cfg,
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
