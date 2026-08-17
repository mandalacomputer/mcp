import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type ServerConfig } from '../src/server.js';

export const BASE = 'https://api.test/api/v1';

export type Recorded = { method: string; path: string; body?: unknown; query: URLSearchParams };

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
    calls.push({ method, path, body, query: url.searchParams });
    return respond(method, path);
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

function respond(method: string, path: string): Response {
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
    return new Response('hello', {
      headers: {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="a.txt"',
      },
    });
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
  // Collections list on GET and answer with one object on POST.
  if (path.endsWith('/snapshots')) return json(method === 'GET' ? [SNAPSHOT] : SNAPSHOT);
  if (path.endsWith('/computers')) return json(method === 'GET' ? [COMPUTER] : COMPUTER);
  return json(COMPUTER);
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
