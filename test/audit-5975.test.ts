import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY, ACTIVITY_ID, connect, installFakePlatform } from './harness.js';

// OPL-5975: the pre-release audit of this server. One test per behaviour it
// changed that no other file pins.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

let platform: ReturnType<typeof installFakePlatform>;
beforeEach(() => {
  platform = installFakePlatform();
});
afterEach(() => platform.restore());

/** Answer one route with `body` while the rest of the fake platform answers as usual. */
function answering(match: (method: string, path: string) => boolean, body: unknown) {
  const fake = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    if (match(method, url.pathname.replace(/^\/api\/v1/, '')))
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    return fake(input as never, init);
  }) as typeof fetch;
}

async function tools() {
  const { client, close } = await connect({ modelKey: 'sk-ant-fixture' });
  const list = (await client.listTools()).tools;
  const instructions = client.getInstructions() ?? '';
  await close();
  return { byName: new Map(list.map((t) => [t.name, t])), instructions };
}

describe('stop_computer', () => {
  // A graceful stop already forces the computer off after 45 seconds, so
  // `force` only skips that wait. It was described as the fix for a stop that
  // fails, which sent agents to cut power for nothing.
  it('says an ordinary stop forces the computer off itself, and force only skips the wait', async () => {
    const stop = (await tools()).byName.get('stop_computer');
    expect(stop?.description).toContain('up to 45 seconds');
    expect(stop?.description).toContain('forced off by the platform');
    const force = (stop?.inputSchema.properties?.force as { description?: string } | undefined)
      ?.description;
    expect(force).toContain('only saves those 45 seconds');
    expect(force).not.toMatch(/second attempt|refuse the polite stop/);
  });
});

describe('create_computer that did not start', () => {
  // The API reference: a start refused for low disk answers the same until space is
  // freed — "wait before sending it again rather than retrying it in a loop".
  it('does not say a second start often works', async () => {
    answering((m, p) => m === 'POST' && p === '/computers', {
      computer: { id: 'vm-9', name: 'fresh', status: 'stopped', resolution: '1280x800x24' },
      start_error: 'This host is low on disk space.',
    });
    const { call, close } = await connect({ computerId: undefined });
    const text = textOf(await call('create_computer', {}));
    await close();
    expect(text).toContain('This host is low on disk space.');
    expect(text).not.toContain('often works');
    expect(text).toContain('do not create another');
    expect(text).toContain('rather than retrying it in a loop');
  });
});

describe('get_desktop_url', () => {
  // A workspace move replaces the desktop credentials too (the API reference says so), and the
  // tool said a restart was the only thing that did.
  it('names a workspace move as the other thing that reissues the credentials', async () => {
    const { byName } = await tools();
    expect(byName.get('get_desktop_url')?.description).toContain(
      'restarts or is moved to another workspace',
    );
    const { call, close } = await connect();
    const control = textOf(await call('get_desktop_url', { control: true }));
    await close();
    expect(control).toContain('move_computer_to_workspace');
    expect(control).not.toContain('restart_computer is the only');
  });
});

describe('activities', () => {
  it('keeps a managed-agent run’s funded and cost_usd, and refuses a malformed one', async () => {
    answering((m, p) => m === 'GET' && p.startsWith('/computers/vm-1/activities/'), {
      ...ACTIVITY,
      funded: true,
      cost_usd: 0.42,
    });
    const { call, close } = await connect();
    const kept = textOf(await call('get_activity', { activity_id: ACTIVITY_ID }));
    expect(kept).toContain('"funded": true');
    expect(kept).toContain('"cost_usd": 0.42');
    await close();
    answering((m, p) => m === 'GET' && p.startsWith('/computers/vm-1/activities/'), {
      ...ACTIVITY,
      funded: 'yes',
    });
    const bad = await (await connect()).call('get_activity', { activity_id: ACTIVITY_ID });
    expect(bad.isError).toBe(true);
  });
});

describe('the listings scoped by the key', () => {
  it('say a key confined to a workspace sees only that workspace’s moves and operations', async () => {
    const { byName } = await tools();
    for (const name of ['list_moves', 'list_operations', 'get_operation']) {
      expect(byName.get(name)?.description, name).toMatch(/confined to a workspace/);
    }
  });
});

describe('the server instructions on a 409', () => {
  it('no longer say most 409s pass, and say an unclassified one does not', async () => {
    const { instructions } = await tools();
    expect(instructions).not.toContain('Most describe a passing state');
    expect(instructions).toContain('A 409 that does not say it will clear is one of those');
  });
});

// P5: the daemon decodes coordinates as integers, so a fraction is refused
// here, before anything is sent, on every tool that takes one.
describe('input coordinates', () => {
  it.each([
    ['click', { x: 100.5, y: 200 }],
    ['click', { x: 100, y: 200.25 }],
    ['move_mouse', { x: 1.5, y: 2 }],
    ['scroll', { x: 10.5, y: 10, direction: 'down' }],
    ['mouse_button', { x: 10, y: 10.5, state: 'down' }],
    ['drag', { to_x: 10.5, to_y: 10 }],
    ['drag', { to_x: 10, to_y: 10, from_x: 0.5, from_y: 0 }],
    ['window_action', { window_id: '0x2600003', action: 'move', x: 1.5, y: 2 }],
    ['window_action', { window_id: '0x2600003', action: 'resize', width: 100.5, height: 200 }],
    ['screenshot', { region: { x: 0.5, y: 0, width: 10, height: 10 } }],
  ])('%s refuses a fractional coordinate %j before sending', async (tool, args) => {
    const { call, close } = await connect();
    const before = platform.calls.length;
    const res = await call(tool, args).catch(
      (e: unknown): CallToolResult => ({
        isError: true,
        content: [{ type: 'text', text: String(e) }],
      }),
    );
    await close();
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/\bint(eger)?\b/i);
    expect(platform.calls.slice(before)).toEqual([]);
  });
});
