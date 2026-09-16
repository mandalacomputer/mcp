import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filtersFromEnv, main } from '../src/cli.js';
import * as http from '../src/http.js';
import { createServer, type ServerConfig } from '../src/server.js';
import * as stdio from '../src/stdio.js';
import { parseToolTags, toolFilter, VALID_TAGS } from '../src/tool-filters.js';
import { BASE, connect, fakeEvents, installFakePlatform } from './harness.js';

// Independent expectations: changing the production mapping must change the
// advertised contract deliberately, rather than making both sides agree silently.
const GROUPS = {
  computers:
    'list_computers get_computer use_computer wait_for_computer get_desktop_url list_sizes',
  lifecycle:
    'create_computer start_computer stop_computer suspend_computer restart_computer update_computer clone_computer delete_computer move_computer list_moves',
  input:
    'screenshot click type_text press_key scroll drag move_mouse mouse_button cursor_position wait',
  guest:
    'exec exec_poll exec_kill open_url list_windows window_action read_clipboard write_clipboard',
  files: 'read_file write_file wait_for_file_change',
  executions: 'get_execution read_execution_output',
  results: 'retain_execution_output get_result read_result_output delete_result',
  artifacts: 'publish_artifact get_artifact read_artifact delete_artifact',
  snapshots:
    'list_snapshots snapshot_holdings create_snapshot restore_snapshot clone_snapshot snapshot_schedule get_retention delete_snapshot',
  templates:
    'list_templates get_template_schema check_template publish_template get_template retire_template build_template list_builds get_build watch_build',
  events: 'wait_for_event poll_events wait_for_file_change',
  usage: 'get_usage',
  webhooks:
    'list_webhooks create_webhook get_webhook update_webhook rotate_webhook_secret test_webhook list_webhook_deliveries delete_webhook',
  agent: 'run_agent',
};
const names = (tools: { name: string }[]) => tools.map((tool) => tool.name).sort();
const words = (text: string) => text.split(' ').sort();
const allNames = [...new Set(Object.values(GROUPS).flatMap(words))].sort();

let platform: ReturnType<typeof installFakePlatform>;
const connections: Awaited<ReturnType<typeof connect>>[] = [];
async function open(cfg: Partial<ServerConfig> = {}) {
  const connection = await connect(cfg);
  connections.push(connection);
  return connection;
}
beforeEach(() => {
  platform = installFakePlatform();
  vi.stubEnv('MANDALA_READ_ONLY', '');
  vi.stubEnv('MANDALA_TAGS', '');
});

describe('filtered transport sessions', () => {
  it.each([false, true])('HTTP applies filters per caller with readOnly=%s', async (readOnly) => {
    const server = await http.runHttp({
      port: 0,
      host: '127.0.0.1',
      baseUrl: BASE,
      tags: ['input', 'guest', 'agent'],
      readOnly,
      modelKey: 'sk-operator',
      computerId: 'operator-computer',
    });
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    const sessions: { client: Client; transport: StreamableHTTPClientTransport }[] = [];
    try {
      for (const [apiKey, modelKey] of [
        ['com_first', undefined],
        ['com_second', 'sk-caller'],
      ]) {
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              ...(modelKey ? { 'X-Model-Key': modelKey } : {}),
            },
          },
        });
        const client = new Client({ name: 'filter-test', version: '0' });
        sessions.push({ client, transport });
        await client.connect(transport);
        const visible = names((await client.listTools()).tools);
        if (readOnly) expect(visible).toEqual(words('screenshot list_windows read_clipboard'));
        else
          expect(visible).toEqual(
            words(`${GROUPS.input} ${GROUPS.guest}${modelKey ? ' run_agent' : ''}`),
          );
        expect((await client.callTool({ name: 'screenshot', arguments: {} })).isError).toBe(true);
        const result = await client.callTool({
          name: 'screenshot',
          arguments: { computer_id: 'caller-computer' },
        });
        expect(result.isError).not.toBe(true);
        expect(platform.calls.at(-1)).toMatchObject({
          path: '/computers/caller-computer/screenshot',
          headers: { authorization: `Bearer ${apiKey}` },
        });
        expect(
          (await client.callTool({ name: 'read_file', arguments: { path: '/tmp/example' } }))
            .isError,
        ).toBe(true);
      }
      expect(platform.calls.every((call) => !call.path.includes('operator-computer'))).toBe(true);
    } finally {
      for (const { client, transport } of sessions) {
        if (transport.sessionId) await transport.terminateSession();
        await client.close();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('stdio applies filters and keeps the explicit startup binding', async () => {
    const stdin = new Readable({ read() {} });
    const responses = new Map<number, { result: CallToolResult & ListToolsResult }>();
    let buffer = '';
    const stdout = new Writable({
      write(chunk, _encoding, done) {
        buffer += chunk.toString();
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const response = JSON.parse(buffer.slice(0, newline));
          responses.set(response.id, response);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
        done();
      },
    });
    const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
    const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let id = 0;
    const send = (message: unknown) => stdin.push(`${JSON.stringify(message)}\n`);
    const request = async (method: string, params = {}) => {
      const requestId = ++id;
      send({ jsonrpc: '2.0', id: requestId, method, params });
      await vi.waitFor(() => expect(responses.has(requestId)).toBe(true));
      return responses.get(requestId)?.result;
    };
    try {
      await stdio.runStdio({
        apiKey: 'com_stdio',
        baseUrl: BASE,
        computerId: 'stdio-computer',
        tags: ['input'],
        readOnly: true,
      });
      await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'filter-test', version: '0' },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(names((await request('tools/list'))?.tools ?? [])).toEqual(['screenshot']);
      expect(
        (await request('tools/call', { name: 'click', arguments: { x: 1, y: 2 } }))?.isError,
      ).toBe(true);
      expect(
        (await request('tools/call', { name: 'screenshot', arguments: {} }))?.isError,
      ).not.toBe(true);
      expect(platform.calls).toHaveLength(1);
      expect(platform.calls[0]).toMatchObject({
        path: '/computers/stdio-computer/screenshot',
        headers: { authorization: 'Bearer com_stdio' },
      });
    } finally {
      stdin.push(null);
      await vi.waitFor(() => expect(stdin.listenerCount('data')).toBe(0));
      if (realIn) Object.defineProperty(process, 'stdin', realIn);
      if (realOut) Object.defineProperty(process, 'stdout', realOut);
    }
  });
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  platform.restore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('tool registration filters over MCP', () => {
  it('tags every tool in the unfiltered inventory, including model-key tools', async () => {
    const { client } = await open({ modelKey: 'sk-test' });
    expect(names((await client.listTools()).tools)).toEqual(allNames);
    expect(VALID_TAGS).toEqual(Object.keys(GROUPS).sort());
    expect(() => toolFilter({}).allows('future_tool', { readOnlyHint: true })).toThrow(/no tag/);
  });

  it.each(Object.entries(GROUPS))('registers exactly the %s group', async (tag, expected) => {
    const { client } = await open({ tags: [tag], modelKey: 'sk-test' });
    expect(names((await client.listTools()).tools)).toEqual(words(expected));
  });

  it('uses only actual annotations for read-only and rejects every withheld tool by name', async () => {
    const baseline = await open({ modelKey: 'sk-test' });
    const full = (await baseline.client.listTools()).tools;
    const expected = full.filter((tool) => tool.annotations?.readOnlyHint === true);
    const { client, call } = await open({ readOnly: true, modelKey: 'sk-test' });
    const visible = names((await client.listTools()).tools);
    expect(visible).toEqual(names(expected));
    expect(visible).toEqual(
      expect.arrayContaining(['screenshot', 'read_clipboard', 'list_windows']),
    );
    for (const name of [
      'read_file',
      'cursor_position',
      'use_computer',
      'wait_for_computer',
      'snapshot_schedule',
    ]) {
      expect(visible).not.toContain(name);
    }
    for (const tool of full.filter((tool) => !visible.includes(tool.name))) {
      const result = await call(tool.name);
      expect(result.isError, tool.name).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining(`Tool ${tool.name} not found`),
        }),
      ]);
    }
    expect(platform.calls).toEqual([]);
    // A name that sounds dangerous is not a substitute for registry metadata.
    expect(toolFilter({ readOnly: true }).allows('exec', { readOnlyHint: true })).toBe(true);
    expect(toolFilter({ readOnly: true }).allows('screenshot')).toBe(false);
  });

  it('unions comma-separated tags before intersecting read-only', async () => {
    const tags = parseToolTags(' input, guest, input, ');
    const union = await open({ tags });
    expect(names((await union.client.listTools()).tools)).toEqual(
      words(`${GROUPS.input} ${GROUPS.guest}`),
    );
    const filtered = await open({ tags, readOnly: true });
    const unionTools = (await union.client.listTools()).tools;
    expect(names((await filtered.client.listTools()).tools)).toEqual(
      names(unionTools.filter((tool) => tool.annotations?.readOnlyHint === true)),
    );
    expect((await filtered.call('screenshot')).isError).not.toBe(true);
    const before = platform.calls.length;
    expect((await filtered.call('click', { x: 1, y: 2 })).isError).toBe(true);
    expect(platform.calls).toHaveLength(before);
  });

  it('deduplicates tools shared by tags and preserves an empty read-only file selection', async () => {
    const union = await open({ tags: ['files', 'events'] });
    expect(names((await union.client.listTools()).tools)).toEqual(
      words('read_file write_file wait_for_file_change wait_for_event poll_events'),
    );
    const empty = await open({ tags: ['files'], readOnly: true });
    expect((await empty.client.listTools()).tools).toEqual([]);
    await expect(empty.call('read_file', { path: '/tmp/example' })).rejects.toThrow(
      /No tools are available/,
    );
    expect(platform.calls).toEqual([]);
  });

  it('intersects lifecycle and per-session model-key gates with the tag union', async () => {
    const tags = ['lifecycle', 'snapshots', 'agent'];
    const limited = await open({ tags, lifecycle: false });
    const withheld = new Set([
      'create_computer',
      'clone_computer',
      'delete_computer',
      'clone_snapshot',
      'delete_snapshot',
    ]);
    expect(names((await limited.client.listTools()).tools)).toEqual(
      words(`${GROUPS.lifecycle} ${GROUPS.snapshots}`).filter((name) => !withheld.has(name)),
    );
    for (const name of [...withheld, 'run_agent'])
      expect((await limited.call(name)).isError).toBe(true);
    const keyed = await open({ tags: ['agent'], modelKey: 'sk-test' });
    expect(names((await keyed.client.listTools()).tools)).toEqual(['run_agent']);
    const readOnly = await open({ tags: ['agent'], modelKey: 'sk-test', readOnly: true });
    expect((await readOnly.client.listTools()).tools).toEqual([]);
    expect(platform.calls).toEqual([]);
  });

  it('isolates configuration, account credentials and startup computer bindings', async () => {
    const tags = ['input'];
    const first = await open({ tags, readOnly: true, apiKey: 'com_first', computerId: 'first' });
    tags.push('guest');
    const second = await open({ tags: ['guest'], apiKey: 'com_second', computerId: 'second' });
    expect(names((await first.client.listTools()).tools)).not.toContain('exec');
    expect(names((await second.client.listTools()).tools)).toEqual(words(GROUPS.guest));
    await first.call('screenshot');
    await second.call('read_clipboard');
    expect(platform.calls.map(({ path, headers }) => [path, headers.authorization])).toEqual([
      ['/computers/first/screenshot', 'Bearer com_first'],
      ['/computers/second/clipboard', 'Bearer com_second'],
    ]);
    const explicit = await open({ tags: ['input'], readOnly: true, computerId: undefined });
    expect((await explicit.call('screenshot', { computer_id: 'third' })).isError).not.toBe(true);
    expect(platform.calls.at(-1)?.path).toBe('/computers/third/screenshot');
  });

  it.each([
    { readOnly: true },
    { tags: ['files'] },
    { tags: ['lifecycle'], lifecycle: false },
    { tags: ['agent'] },
  ])('keeps withheld tool calls out of initialize instructions: %j', async (cfg) => {
    const { client } = await open(cfg);
    const visible = names((await client.listTools()).tools);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('computer_id');
    for (const name of allNames.filter((name) => !visible.includes(name))) {
      expect(instructions).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('does not allocate event sockets for hidden tools and closes visible event sockets with the session', async () => {
    const hiddenEvents = fakeEvents();
    const hidden = await open({ tags: ['usage'], webSocket: hiddenEvents.factory });
    expect((await hidden.call('poll_events')).isError).toBe(true);
    expect(hiddenEvents.sockets).toHaveLength(0);
    expect(platform.calls).toEqual([]);
    const events = fakeEvents();
    const visible = await open({ tags: ['events'], webSocket: events.factory });
    expect((await visible.call('poll_events')).isError).not.toBe(true);
    expect(events.sockets.length).toBeGreaterThan(0);
    expect(events.last().closed).toBe(false);
    await visible.close();
    expect(events.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it('holds activity until a cancelled callback actually settles, then releases once', async () => {
    const release = vi.fn();
    const activity = vi.fn(() => release);
    const { client, call } = await open({ tags: ['computers'], readOnly: true, activity });
    expect((await call('use_computer', { computer_id: 'vm-1' })).isError).toBe(true);
    expect(activity).not.toHaveBeenCalled();
    const respond = globalThis.fetch;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    globalThis.fetch = async (...args) => {
      await pending;
      return respond(...args);
    };
    const controller = new AbortController();
    const result = client
      .callTool({ name: 'get_computer', arguments: {} }, undefined, { signal: controller.signal })
      .catch((error) => error);
    try {
      await vi.waitFor(() => expect(activity).toHaveBeenCalledOnce());
      controller.abort();
      await result;
      expect(release).not.toHaveBeenCalled();
    } finally {
      finish();
    }
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it('releases activity on a failing platform call', async () => {
    const release = vi.fn();
    const activity = vi.fn(() => release);
    const { call } = await open({ tags: ['computers'], readOnly: true, activity });
    globalThis.fetch = async () => {
      throw new Error('mocked platform failure');
    };
    expect((await call('get_computer')).isError).toBe(true);
    expect(activity).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('filter configuration before startup', () => {
  it.each([
    { filters: { tags: ['Input'] }, error: /Unknown MANDALA_TAGS tag "Input".*Valid tags/ },
    { filters: { readOnly: 'false' as unknown as boolean }, error: /readOnly must be a boolean/ },
  ])(
    'refuses invalid direct HTTP filters before allocating resources: $filters',
    async ({ filters, error }) => {
      // Both resource boundaries are mocked so this also fails safely against
      // code that defers filter validation until the first MCP initialize.
      const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue({
        unref: vi.fn(),
      } as unknown as ReturnType<typeof setInterval>);
      const listen = vi.spyOn(express.application, 'listen').mockImplementation(() => {
        throw new Error('HTTP listen reached before filter validation');
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(
        http.runHttp({ port: 0, host: '127.0.0.1', baseUrl: BASE, ...filters }),
      ).rejects.toThrow(error);
      expect(interval).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(platform.calls).toEqual([]);
    },
  );

  it.each(['1', 'true', 'yes', 'on', ' YES '])('accepts read-only on: %j', (raw) => {
    expect(filtersFromEnv(raw, '').readOnly).toBe(true);
  });
  it.each(['0', 'false', 'no', 'off', ' OFF ', '', '  ', undefined])(
    'accepts read-only off: %j',
    (raw) => {
      expect(filtersFromEnv(raw, '').readOnly).toBe(false);
    },
  );
  it.each(['ture', 'enable', '2'])('refuses unknown read-only: %s', (raw) => {
    expect(() => filtersFromEnv(raw, '')).toThrow(/MANDALA_READ_ONLY=.*not a yes or a no/);
  });
  it.each(['Input', 'unknown', 'files;input', 'files,NOPE'])(
    'refuses an unknown tag: %s',
    (raw) => {
      expect(() => parseToolTags(raw)).toThrow(
        `Valid tags (lowercase only): ${Object.keys(GROUPS).sort().join(', ')}`,
      );
    },
  );
  it('accepts empty tags and validates programmatic configuration before session construction', async () => {
    expect(parseToolTags(undefined)).toEqual([]);
    expect(parseToolTags(' , , ')).toEqual([]);
    const { client } = await open({ tags: [], readOnly: false, modelKey: 'sk-test' });
    expect(names((await client.listTools()).tools)).toEqual(allNames);
    expect(() => createServer({ apiKey: 'com_test', baseUrl: 'invalid', tags: ['Input'] })).toThrow(
      /Valid tags/,
    );
    expect(() =>
      createServer({ apiKey: 'com_test', readOnly: 'false' as unknown as boolean }),
    ).toThrow(/readOnly must be a boolean/);
  });

  it.each([{ argv: [] }, { argv: ['--http'] }])(
    'passes parsed filters to the transport: %j',
    async ({ argv }) => {
      const runHttp = vi
        .spyOn(http, 'runHttp')
        .mockResolvedValue({} as Awaited<ReturnType<typeof http.runHttp>>);
      const runStdio = vi.spyOn(stdio, 'runStdio').mockResolvedValue(undefined);
      vi.stubEnv('MANDALA_API_KEY', 'com_test');
      vi.stubEnv('MANDALA_BASE_URL', BASE);
      vi.stubEnv('MANDALA_NO_LIFECYCLE', '0');
      vi.stubEnv('MANDALA_READ_ONLY', 'yes');
      vi.stubEnv('MANDALA_TAGS', ' input, guest,input ');
      await main(argv);
      const selected = argv.length ? runHttp : runStdio;
      const other = argv.length ? runStdio : runHttp;
      expect(selected).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true, tags: ['input', 'guest'] }),
      );
      expect(other).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['MANDALA_READ_ONLY', 'ture'],
    ['MANDALA_TAGS', 'Input'],
  ])('rejects invalid %s before either transport starts', async (variable, value) => {
    const runHttp = vi.spyOn(http, 'runHttp');
    const runStdio = vi.spyOn(stdio, 'runStdio');
    vi.stubEnv('MANDALA_API_KEY', 'com_test');
    vi.stubEnv('MANDALA_READ_ONLY', 'false');
    vi.stubEnv('MANDALA_TAGS', 'input');
    vi.stubEnv(variable, value);
    for (const argv of [[], ['--http']]) await expect(main(argv)).rejects.toThrow(variable);
    expect(runHttp).not.toHaveBeenCalled();
    expect(runStdio).not.toHaveBeenCalled();
    expect(platform.calls).toEqual([]);
  });

  it('forwards both filter variables through the plugin without requiring values', () => {
    const plugin = JSON.parse(
      readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    );
    expect(plugin.mcpServers.mandala.env.MANDALA_READ_ONLY).toBe(`\${MANDALA_READ_ONLY:-}`);
    expect(plugin.mcpServers.mandala.env.MANDALA_TAGS).toBe(`\${MANDALA_TAGS:-}`);
  });
});
