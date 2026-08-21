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

const SNAPSHOT = { id: 'snap-1', computer_id: 'vm-1', name: 's', kind: 'disk', state: 'durable' };

const HOLDINGS = { count: 2, size_bytes: 6_100_000_000, fingerprint: 'fp-abc123' };

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
  if (path.endsWith('/windows')) {
    return json({ windows: [{ id: '0x2600003', title: 'T', class: 'Xfce4-terminal' }] });
  }
  if (/\/windows\/[^/]+$/.test(path))
    return json({ ok: true, window: { id: '0x2600003', x: 305 } });
  if (path.endsWith('/schedule')) return json({ enabled: true, hour: 4, minute: 0, tz: 'UTC' });
  if (path.endsWith('/templates')) return json([{ name: 'base', os: 'linux', cpu: 2 }]);
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
