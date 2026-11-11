import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type APIError,
  ConflictError,
  codeAdvice,
  errorForStatus,
  isTransient,
  reasonAdvice,
  reasonKind,
} from '../src/errors.js';
import { failed } from '../src/format.js';
import {
  ARTIFACT_LISTING,
  connect,
  installFakePlatform,
  RESULT_LISTING,
  SSH_KEY,
  SSH_KEY_CHALLENGE,
  SSH_PUBLIC_KEY,
  WEBHOOK,
  WEBHOOK_DELIVERY,
} from './harness.js';

// The routes, parameters and answers the platform gained that no tool reached
// or read (OPL-6587): build cancel, the retained listings, SSH key proof, the
// deliveries listing's paging and filter, a test sent to a full queue, a
// computer its host holds paused, and the refusal words a tool has to name.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

type Override = (method: string, path: string) => Response | undefined;

let platform: ReturnType<typeof installFakePlatform>;
let clients: Awaited<ReturnType<typeof connect>>[] = [];
beforeEach(() => {
  platform = installFakePlatform();
});
afterEach(async () => {
  for (const c of clients) await c.close();
  clients = [];
  platform.restore();
});

/** Connect with some routes answered differently from the fake platform. */
async function open(override?: Override) {
  if (override) {
    const fake = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const answer = override(
        (init?.method ?? 'GET').toUpperCase(),
        url.pathname.replace(/^\/api\/v1/, ''),
      );
      if (answer) {
        platform.calls.push({
          method: (init?.method ?? 'GET').toUpperCase(),
          path: url.pathname.replace(/^\/api\/v1/, ''),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
          query: url.searchParams,
          headers: {},
        });
        return answer;
      }
      return fake(input as never, init);
    }) as typeof fetch;
  }
  const c = await connect();
  clients.push(c);
  return c;
}

const description = async (tool: string) => {
  const c = await open();
  const found = (await c.client.listTools()).tools.find((t) => t.name === tool);
  expect(found, tool).toBeDefined();
  return found?.description ?? '';
};

describe('builds', () => {
  it('cancel_build posts the cancel and says the build has not necessarily ended', async () => {
    const c = await open();
    const res = await c.call('cancel_build', { build_id: 'bld-1' });
    expect(res.isError).toBeFalsy();
    const sent = platform.calls.filter((x) => x.method === 'POST' && x.path.endsWith('/cancel'));
    expect(sent.map((x) => x.path)).toEqual(['/builds/bld-1/cancel']);
    const text = textOf(res);
    expect(text).toContain('reads running');
    expect(text).toMatch(/get_build or watch_build/);
  });

  it('build_template no longer calls the secret 409 or a 503 worth retrying', async () => {
    const d = await description('build_template');
    expect(d).not.toMatch(/and a 503, are worth retrying/);
    expect(d).not.toContain("a 409 saying a secret's value cannot be read right now");
    expect(d).toContain('a 409 with reason unsupported');
    expect(d).toMatch(/503 is an outcome nobody knows.*call list_builds before building again/);
    expect(d).toMatch(/ONE BUILD RUNS PER ACCOUNT AT A TIME.*429.*cancel_build/);
    expect(d).toMatch(/409 with reason contention .* worth retrying/);
  });
});

describe('webhooks', () => {
  it('test_webhook says a test dropped by a full queue was never sent', async () => {
    const dropped = {
      ...WEBHOOK_DELIVERY,
      event_type: 'webhook.test',
      state: 'dropped',
      attempts: 0,
      last_error: 'queue full',
    };
    const c = await open((method, path) =>
      method === 'POST' && path.endsWith('/test')
        ? Response.json(dropped, { status: 202 })
        : undefined,
    );
    const res = await c.call('test_webhook', { webhook_id: WEBHOOK.id });
    const text = textOf(res);
    expect(text).toContain('was NOT sent');
    expect(text).toContain('queue full');
    expect(text).toMatch(/new events are being dropped/);
    expect(text).toMatch(/events_url, shown by get_computer/);
    expect(text).toMatch(
      /connect to that socket with since set to the cursor of the last delivery/,
    );
    expect(text).not.toContain('poll_events');
    expect(text).toContain('state: "dropped"');
    expect(text).not.toContain('in a few seconds to read what it answered');
  });

  it('test_webhook still reports an ordinary test as queued', async () => {
    const c = await open();
    const text = textOf(await c.call('test_webhook', { webhook_id: WEBHOOK.id }));
    expect(text).toMatch(/^Queued test delivery/);
    expect(text).not.toContain('NOT sent');
  });

  it('test_webhook describes the full-queue case', async () => {
    expect(await description('test_webhook')).toMatch(/queue is full.*dropped.*never sent/);
  });

  it('list_webhook_deliveries sends state, limit and before, and nothing when none is given', async () => {
    const c = await open();
    await c.call('list_webhook_deliveries', { webhook_id: WEBHOOK.id });
    await c.call('list_webhook_deliveries', {
      webhook_id: WEBHOOK.id,
      state: 'exhausted',
      limit: 1,
      before: 'whd-0123456789abcdef',
    });
    const gets = platform.calls.filter((x) => x.method === 'GET' && x.path.endsWith('/deliveries'));
    expect(gets).toHaveLength(2);
    expect([...gets[0].query.keys()]).toEqual([]);
    expect(Object.fromEntries(gets[1].query)).toEqual({
      state: 'exhausted',
      limit: '1',
      before: 'whd-0123456789abcdef',
    });
  });

  it('list_webhook_deliveries says a full page may have older rows, and how to read on', async () => {
    const c = await open();
    const full = textOf(
      await c.call('list_webhook_deliveries', { webhook_id: WEBHOOK.id, limit: 1 }),
    );
    expect(full).toContain(`before: "${WEBHOOK_DELIVERY.id}"`);
    const short = textOf(await c.call('list_webhook_deliveries', { webhook_id: WEBHOOK.id }));
    expect(short).not.toContain('before:');
  });

  it('list_webhook_deliveries refuses a state outside the platform set without sending', async () => {
    const c = await open();
    const res = await c.call('list_webhook_deliveries', { webhook_id: WEBHOOK.id, state: 'lost' });
    expect(res.isError).toBe(true);
    expect(platform.calls.filter((x) => x.path.endsWith('/deliveries'))).toEqual([]);
  });
});

describe('retained listings', () => {
  it('list_artifacts reads the listing and says how full both quotas are', async () => {
    const c = await open();
    const res = await c.call('list_artifacts', { computer_id: 'vm-1' });
    expect(res.isError).toBeFalsy();
    expect(
      platform.calls.some((x) => x.method === 'GET' && x.path === '/computers/vm-1/artifacts'),
    ).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/^1 retained artifact on vm-1, oldest first/);
    expect(text).toContain('Computer quota: 2 of 256 objects');
    expect(text).toContain('Account quota: 3 of 2000 objects');
    expect(text).toContain(ARTIFACT_LISTING.artifacts[0].artifact_id);
  });

  it('list_results reads the listing the same way', async () => {
    const c = await open();
    const res = await c.call('list_results', { computer_id: 'vm-1' });
    expect(res.isError).toBeFalsy();
    expect(
      platform.calls.some((x) => x.method === 'GET' && x.path === '/computers/vm-1/results'),
    ).toBe(true);
    expect(textOf(res)).toContain(RESULT_LISTING.results[0].result_id);
  });

  it('marks a full quota FULL', async () => {
    const usage = {
      computer: { objects: 256, bytes: 10, max_objects: 256, max_bytes: 134217728 },
      account: { objects: 3, bytes: 10, max_objects: 2000, max_bytes: 536870912 },
    };
    const c = await open((method, path) =>
      method === 'GET' && path.endsWith('/results')
        ? Response.json({ ...RESULT_LISTING, usage })
        : undefined,
    );
    expect(textOf(await c.call('list_results', { computer_id: 'vm-1' }))).toContain(
      'Computer quota: 256 of 256 objects, 10 of 134217728 bytes (FULL)',
    );
  });

  it('refuses a listing whose quota cannot be read rather than reading it as room', async () => {
    const c = await open((method, path) =>
      method === 'GET' && path.endsWith('/artifacts')
        ? Response.json({ artifacts: [], usage: { computer: {} } })
        : undefined,
    );
    const res = await c.call('list_artifacts', { computer_id: 'vm-1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('quota:');
  });

  it('a capture refused for a full quota says nothing was captured and names the listings', async () => {
    const refusal = () =>
      Response.json(
        { error: 'quota', code: 'result_quota_exhausted', reason: 'computer_quota' },
        { status: 409 },
      );
    const c = await open((method, path) =>
      method === 'POST' && (path.endsWith('/artifacts') || path.endsWith('/retained-output'))
        ? refusal()
        : undefined,
    );
    for (const [tool, args] of [
      [
        'publish_artifact',
        {
          computer_id: 'vm-1',
          path: '/tmp/x',
          expected_size: 0,
          expected_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      ],
      [
        'retain_execution_output',
        { computer_id: 'vm-1', execution_id: 'exec_0123456789abcdef0123456789abcdef' },
      ],
    ] as const) {
      const res = await c.call(tool, args);
      expect(res.isError, tool).toBe(true);
      const text = textOf(res);
      expect(text, tool).toContain('Nothing was captured');
      expect(text, tool).toContain('the computer’s)');
      expect(text, tool).toMatch(/list_artifacts and list_results/);
      expect(text, tool).not.toContain('may have committed');
    }
  });

  it('publish_artifact and retain_execution_output describe the quota refusal', async () => {
    for (const tool of ['publish_artifact', 'retain_execution_output'])
      expect(await description(tool), tool).toMatch(
        /409 result_quota_exhausted.*list_(artifacts|results)/,
      );
  });
});

describe('SSH key proof', () => {
  it('ssh_key_challenge posts for a challenge and hands back the command to sign it', async () => {
    const c = await open();
    const res = await c.call('ssh_key_challenge', {});
    expect(res.isError).toBeFalsy();
    expect(
      platform.calls.some((x) => x.method === 'POST' && x.path === '/ssh-keys/challenge'),
    ).toBe(true);
    const text = textOf(res);
    expect(text).toContain(SSH_KEY_CHALLENGE.challenge);
    expect(text).toContain(SSH_KEY_CHALLENGE.sign_command);
    expect(text).toContain('add_ssh_key');
  });

  it('add_ssh_key sends challenge and signature together', async () => {
    const c = await open();
    await c.call('add_ssh_key', {
      public_key: SSH_PUBLIC_KEY,
      challenge: SSH_KEY_CHALLENGE.challenge,
      signature: 'SIG',
    });
    const sent = platform.calls.find((x) => x.method === 'POST' && x.path === '/ssh-keys');
    expect(sent?.body).toEqual({
      public_key: SSH_PUBLIC_KEY,
      challenge: SSH_KEY_CHALLENGE.challenge,
      signature: 'SIG',
    });
  });

  it('add_ssh_key refuses one of the pair without the other, sending nothing', async () => {
    const c = await open();
    for (const half of [{ challenge: SSH_KEY_CHALLENGE.challenge }, { signature: 'SIG' }]) {
      const res = await c.call('add_ssh_key', { public_key: SSH_PUBLIC_KEY, ...half });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('go together');
    }
    expect(platform.calls.filter((x) => x.path === '/ssh-keys')).toEqual([]);
  });

  it('says an unproven key connects by computer id only, on the add and in the listing', async () => {
    const unproven = { ...SSH_KEY, possession: 'unproven' };
    const c = await open((method, path) =>
      path === '/ssh-keys'
        ? method === 'POST'
          ? Response.json(unproven, { status: 201 })
          : Response.json([unproven])
        : undefined,
    );
    const added = textOf(await c.call('add_ssh_key', { public_key: SSH_PUBLIC_KEY }));
    expect(added).toContain('UNPROVEN');
    expect(added).toMatch(/computer named by its id only|named by its id only/);
    const listed = textOf(await c.call('list_ssh_keys', {}));
    expect(listed).toContain('[UNPROVEN: connects by computer id only]');
  });

  it('does not call a proven key unproven', async () => {
    const proven = { ...SSH_KEY, possession: 'proven' };
    const c = await open((method, path) =>
      path === '/ssh-keys' && method === 'POST'
        ? Response.json(proven, { status: 201 })
        : undefined,
    );
    const added = textOf(
      await c.call('add_ssh_key', {
        public_key: SSH_PUBLIC_KEY,
        challenge: SSH_KEY_CHALLENGE.challenge,
        signature: 'SIG',
      }),
    );
    expect(added).toContain('[proven]');
    expect(added).not.toContain('UNPROVEN');
  });

  it('add_ssh_key describes the id-only limit of a key added without proof', async () => {
    expect(await description('add_ssh_key')).toMatch(
      /UNPROVEN and connects to a computer named by its id only/,
    );
  });
});

describe('secrets', () => {
  it('delete_secret says saved memory holding the secret is lost whatever it is bound to', async () => {
    const d = await description('delete_secret');
    expect(d).toContain('SAVED MEMORY THAT HOLDS IT IS LOST');
    expect(d).toContain('memory snapshot');
    expect(d).toMatch(/Rebinding or unbinding first does not change that/);
    expect(d).toMatch(/resume it before the delete/);
  });
});

describe('a computer its host holds paused', () => {
  it('get_computer says it is paused by its host and not to stop it', async () => {
    const c = await open((method, path) =>
      method === 'GET' && path === '/computers/vm-1'
        ? Response.json({
            id: 'vm-1',
            name: 'dev',
            status: 'running',
            host_paused: { reason: 'disk_low', since: '2026-11-11T10:00:00Z' },
          })
        : undefined,
    );
    const text = textOf(await c.call('get_computer', { computer_id: 'vm-1' }));
    expect(text).toContain(
      'PAUSED BY ITS HOST to recover disk space (disk_low, since 2026-11-11T10:00:00Z)',
    );
    expect(text).toContain('Do not stop or restart it');
  });

  it('says nothing about it when the field is absent', async () => {
    const c = await open();
    expect(textOf(await c.call('get_computer', { computer_id: 'vm-1' }))).not.toContain(
      'PAUSED BY ITS HOST',
    );
  });
});

describe('refusal words', () => {
  it('reads unsupported_on_macos as final', () => {
    expect(reasonKind('unsupported_on_macos')).toBe('permanent');
    expect(reasonAdvice('unsupported_on_macos')).toMatch(/macOS/);
    const err = errorForStatus(409, 'SSH is not supported on macOS', {
      error: 'SSH is not supported on macOS',
      reason: 'unsupported_on_macos',
    });
    expect(err).toBeInstanceOf(ConflictError);
    expect(isTransient(err)).toBe(false);
    expect(failed(err).content[0]).toMatchObject({ text: expect.stringMatching(/macOS/) });
  });

  it('names STORAGE_OVER_PLAN and MACOS_LICENCE_REQUIRED on their statuses', () => {
    const storage = errorForStatus(402, 'over', { error: 'over', code: 'STORAGE_OVER_PLAN' });
    expect(codeAdvice(storage as APIError)).toMatch(/computers or snapshots.*deleted.*larger plan/);
    const licence = errorForStatus(403, 'licence', {
      error: 'licence',
      code: 'MACOS_LICENCE_REQUIRED',
    });
    expect(codeAdvice(licence as APIError)).toMatch(
      /owner of the account accepts the licence on the Billing page/,
    );
    expect(textOf(failed(licence))).toContain('Billing page');
    // The same code on another status is not that refusal.
    expect(
      codeAdvice(errorForStatus(409, 'x', { error: 'x', code: 'STORAGE_OVER_PLAN' }) as APIError),
    ).toBeUndefined();
  });
});
