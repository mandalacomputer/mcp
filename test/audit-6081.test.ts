import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { errorForStatus, isTransientForPoll, reasonAdvice } from '../src/errors.js';
import { LIMITS } from '../src/limits.js';
import { execEnv, webhookBody } from '../src/paths.js';
import { connect, OPERATION } from './harness.js';

// OPL-6081: the 2026-10-18 audit's findings, one regression each.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

type Seen = { method: string; path: string; body?: unknown };

/** A platform answering from `respond`, recording every request, for the length of `fn`. */
async function platform<T>(
  respond: (seen: Seen, n: number) => [number, unknown] | Response,
  fn: (seen: Seen[]) => Promise<T>,
): Promise<T> {
  const restore = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const call: Seen = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname.replace(/^\/api\/v1/, ''),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(call);
    const answer = respond(call, seen.length);
    if (answer instanceof Response) return answer;
    const [status, body] = answer;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = restore;
  }
}

const box = { id: 'vm-1', name: 'box', status: 'running', os: 'linux', running_ram_mb: 2048 };
const conflict = (body: Record<string, unknown>) =>
  errorForStatus(409, String(body.error ?? 'x'), body);

describe('a 409 inside a wait (P7)', () => {
  it.each([
    'unsupported',
    'running',
    'exists',
    'revoked',
    'name_taken',
    'stale_revision',
    'stale_capture',
  ])('ends the wait on the permanent word %s', (reason) => {
    const err = conflict({ error: 'x', reason });
    expect(isTransientForPoll(err)).toBe(false);
    // Neither opt-out changes a permanent word other than `unavailable`.
    expect(isTransientForPoll(err, { unavailable: true, reasonless409: true })).toBe(false);
  });

  it.each(['idempotency_outcome_unknown', 'template_image_preparing'])(
    'ends the wait on the always-final code %s, even where a bare 409 settles',
    (code) => {
      expect(isTransientForPoll(conflict({ error: 'x', code }), { reasonless409: true })).toBe(
        false,
      );
    },
  );

  it('keeps polling a word that clears, on a 400 as well as a 409', () => {
    for (const status of [400, 409]) {
      for (const reason of ['contention', 'starting']) {
        expect(isTransientForPoll(errorForStatus(status, 'x', { error: 'x', reason }))).toBe(true);
      }
    }
    expect(isTransientForPoll(errorForStatus(400, 'x', { error: 'x' }))).toBe(false);
  });

  it('keeps polling the codes the platform documents as passing', () => {
    expect(isTransientForPoll(conflict({ error: 'x', code: 'idempotency_in_progress' }))).toBe(
      true,
    );
    expect(isTransientForPoll(conflict({ error: 'x', code: 'WORKSPACE_MOVING' }))).toBe(true);
    // The word decides WORKSPACE_MOVING when it is there: stuck is final.
    expect(
      isTransientForPoll(conflict({ error: 'x', code: 'WORKSPACE_MOVING', reason: 'unsupported' })),
    ).toBe(false);
  });

  it('polls a bare 409 only where the route says it settles', () => {
    const bare = conflict({ error: 'x' });
    expect(isTransientForPoll(bare)).toBe(false);
    expect(isTransientForPoll(bare, { reasonless409: true })).toBe(true);
    // A word this version does not know is no answer, and reads as bare.
    const unknown = conflict({ error: 'x', reason: 'wedged' });
    expect(isTransientForPoll(unknown)).toBe(false);
    expect(isTransientForPoll(unknown, { reasonless409: true })).toBe(true);
  });

  it('ends wait_for_computer at once on a permanent refusal of the guest probe', async () => {
    const res = await platform(
      (seen) =>
        seen.path.endsWith('/exec')
          ? [409, { error: 'this image cannot do that', reason: 'unsupported' }]
          : [200, box],
      async (seen) => {
        const { call, close } = await connect();
        const started = Date.now();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        // Answered on the first probe, not after the 30-second deadline.
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(seen.filter((s) => s.path.endsWith('/exec'))).toHaveLength(1);
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('this image cannot do that');
    expect(textOf(res)).not.toMatch(/last seen running/);
  }, 30_000);

  it('ends wait_for_computer on a guest probe 409 with no word', async () => {
    const res = await platform(
      (seen) => (seen.path.endsWith('/exec') ? [409, { error: 'held elsewhere' }] : [200, box]),
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        expect(seen.filter((s) => s.path.endsWith('/exec'))).toHaveLength(1);
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('held elsewhere');
  }, 30_000);

  it('keeps wait_for_computer polling a desktop probe 409 with no word', async () => {
    // The route's documented answer for a desktop session that is not up yet.
    let desktop = 0;
    const res = await platform(
      (seen) => {
        if (!seen.path.endsWith('/exec')) return [200, box];
        if ((seen.body as { session?: string }).session !== 'desktop')
          return [200, { exit_code: 0, stdout: '', stderr: '' }];
        desktop++;
        return desktop < 2
          ? [409, { error: 'no active desktop session' }]
          : [200, { exit_code: 0, stdout: '', stderr: '' }];
      },
      async () => {
        const { call, close } = await connect();
        const r = await call('wait_for_computer', { until: 'guest', timeout_s: 30 });
        await close();
        return r;
      },
    );
    expect(desktop).toBe(2);
    expect(res.isError).toBeFalsy();
  }, 30_000);

  it('ends wait_for_operation at once on a permanent refusal', async () => {
    const res = await platform(
      () => [409, { error: 'that cannot be read here', reason: 'unsupported' }],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('wait_for_operation', {
          operation_id: OPERATION.id,
          timeout_s: 30,
        });
        await close();
        expect(seen).toHaveLength(1);
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('that cannot be read here');
  }, 30_000);
});

describe('a build event stream ended by an error frame with a status (P10)', () => {
  it('reaches the model as the refusal, with its status, word and request id', async () => {
    const frame = {
      request_id: 'req-frame-1',
      error: 'This API key has been revoked.',
      status: 401,
      reason: 'revoked',
    };
    const res = await platform(
      () =>
        new Response(`event: error\ndata: ${JSON.stringify(frame)}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      async () => {
        const { call, close } = await connect();
        const r = await call('watch_build', { build_id: 'bld-1' });
        await close();
        return r;
      },
    );
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('This API key has been revoked.');
    expect(text).toContain('"status": 401');
    expect(text).toContain('"reason": "revoked"');
    expect(text).toContain('req-frame-1');
    // A caller whose authority is gone cannot poll the build either.
    expect(text).not.toMatch(/call get_build/);
  });

  it('still says the stream, not the build, ended when the frame has no status', async () => {
    const res = await platform(
      () =>
        new Response(`event: error\ndata: ${JSON.stringify({ error: 'stream closed' })}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      async () => {
        const { call, close } = await connect();
        const r = await call('watch_build', { build_id: 'bld-1' });
        await close();
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/call get_build/);
  });
});

describe('a create that names a secret revision (P11)', () => {
  it('is refused before anything is sent', async () => {
    const res = await platform(
      () => [200, box],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('create_computer', {
          secrets: [
            {
              secret_id: 'csec-0123456789abcdef',
              env: 'TOKEN',
              revision_id: 'csr-0123456789abcdef01234567',
            },
          ],
        });
        await close();
        expect(seen.filter((s) => s.method === 'POST')).toHaveLength(0);
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/revision_id/);
  });
});

describe('the manifest limits this server checks before sending (M1)', () => {
  it('mirrors every limit on a route it calls', () => {
    expect(Object.keys(LIMITS).sort()).toEqual(
      [
        'agent.maxSteps',
        'clipboard.writeMaxBytes',
        'exec.maxEnvEntries',
        'exec.maxEnvEntryBytes',
        'exec.maxTimeoutSeconds',
        'webhook.computersMax',
        'webhook.descriptionMaxChars',
        'webhook.replayWindowSeconds',
        'webhook.urlMaxChars',
      ].sort(),
    );
  });

  it('refuses an env past the entry count', () => {
    const at = Object.fromEntries(
      Array.from({ length: LIMITS['exec.maxEnvEntries'] }, (_, i) => [`V${i}`, 'x']),
    );
    expect(execEnv(at)).toEqual(at);
    expect(() => execEnv({ ...at, ONE_MORE: 'x' })).toThrow(/at most 64/);
  });

  it('counts an entry as NAME=value in UTF-8 bytes', () => {
    const max = LIMITS['exec.maxEnvEntryBytes'];
    // `AB=` is three bytes, so this value fills the entry exactly.
    expect(execEnv({ AB: 'x'.repeat(max - 3) })).toBeDefined();
    expect(() => execEnv({ AB: 'x'.repeat(max - 2) })).toThrow(/4097 bytes/);
    // A two-byte character costs two, not one.
    expect(() => execEnv({ AB: `${'x'.repeat(max - 4)}é` })).toThrow(/4097 bytes/);
  });

  it('refuses an exec over the env caps without calling the platform', async () => {
    const res = await platform(
      () => [200, { exit_code: 0, stdout: '', stderr: '' }],
      async (seen) => {
        const { call, close } = await connect();
        const r = await call('exec', {
          command: 'true',
          env: { BIG: 'x'.repeat(LIMITS['exec.maxEnvEntryBytes']) },
        });
        await close();
        expect(seen.filter((s) => s.path.endsWith('/exec'))).toHaveLength(0);
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/at most 4096 per entry/);
  });

  it('refuses a webhook url past its cap, counted as sent', () => {
    const max = LIMITS['webhook.urlMaxChars'];
    const prefix = 'https://hooks.example.com/';
    const at = prefix + 'a'.repeat(max - prefix.length);
    expect(webhookBody({ url: `  ${at}  ` })).toEqual({ url: at });
    expect(() => webhookBody({ url: `${at}a` })).toThrow(/2049 characters/);
  });

  it('names the caps in the tool descriptions', async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    await close();
    const exec = tools.find((t) => t.name === 'exec');
    const env = JSON.stringify(
      (exec?.inputSchema.properties as Record<string, unknown> | undefined)?.env,
    );
    expect(env).toContain('At most 64 entries, each at most 4096 bytes');
    const create = tools.find((t) => t.name === 'create_webhook');
    expect(create?.description).toContain('at most 2048 characters');
    expect(create?.description).toContain('more than 300 seconds off');
  });
});

describe('the audit’s wording fixes', () => {
  it('points the registry entry at the current key page and says what a model key does', () => {
    const entry = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')) as {
      packages: { environmentVariables: { name: string; description: string }[] }[];
    };
    const vars = entry.packages[0]?.environmentVariables ?? [];
    const by = Object.fromEntries(vars.map((v) => [v.name, v.description]));
    expect(by.MANDALA_API_KEY).toContain('Settings → Credentials → API keys');
    expect(by.MANDALA_MODEL_KEY).toContain('run_agent_chat');
    expect(by.MANDALA_MODEL_KEY).not.toContain('turns on run_agent');
    // Every variable the plugin passes through is declared for registry clients.
    const plugin = JSON.parse(
      readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    ) as { mcpServers: { mandala: { env: Record<string, string> } } };
    expect(vars.map((v) => v.name).sort()).toEqual(
      Object.keys(plugin.mcpServers.mandala.env).sort(),
    );
  });

  it('says what deleting a workspace does to its webhooks, and what a chunk 404 means', async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    await close();
    const del = tools.find((t) => t.name === 'delete_workspace')?.description ?? '';
    expect(del).toContain('Webhook subscriptions confined to the workspace');
    expect(del).toContain('account-wide subscriptions are not affected');
    const chunk = tools.find((t) => t.name === 'write_file_chunk')?.description ?? '';
    expect(chunk).toContain('A 404 from an older host');
    expect(chunk).toContain('do not resend the chunk through write_file');
  });

  it('has advice for every permanent word, stale_capture included', () => {
    expect(reasonAdvice('stale_capture')).toMatch(/take a new screenshot/);
  });
});

describe('a malformed computer listing (Codex review)', () => {
  it.each([
    ['beside a null row', [null, { id: 'vm-1', vnc: { url: 'wss://x/?token=SECRET-TOKEN' } }]],
    ['in a row without an id', [{ name: 'box', vnc: { url: 'wss://x/?token=SECRET-TOKEN' } }]],
  ])('never shows desktop credentials %s', async (_label, rows) => {
    const res = await platform(
      () => [200, rows],
      async () => {
        const { call, close } = await connect();
        const r = await call('list_computers');
        await close();
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('SECRET-TOKEN');
  });
});

describe('webhook rows whose filter lists are not lists of ids (P13)', () => {
  it.each([
    ['a computer id that is not a string', { computers: [7] }],
    ['a blank event', { events: [''] }],
    ['a filter that is not a list', { computers: 'vm-1' }],
  ])('fail the listing: %s', async (_label, extra) => {
    const row = { id: 'whk-1', url: 'https://hooks.example.com/', enabled: true, ...extra };
    const res = await platform(
      () => [200, [row]],
      async () => {
        const { call, close } = await connect();
        const r = await call('list_webhooks');
        await close();
        return r;
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/malformed/);
  });
});
