import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webhookBody } from '../src/paths.js';
import { connect, installFakePlatform, WEBHOOK, WEBHOOK_CREATED } from './harness.js';

// OPL-4300 on the platform, OPL-4306 here: the webhooks CRUD, and nothing that
// receives one. What is pinned is the part a model acts on — the first line of
// each answer — and the refusals that save a round trip which could only fail.
//
// The secret is the thing this file is really about. It is answered exactly
// twice, by a create and by a rotate, and never again; a model that files the
// JSON away and reads it back later has by then lost the one thing it cannot
// re-read. So the sentence in front of both answers says so, in words a model
// reads before it reads the JSON, and the listing and the read are proved never
// to carry one.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('the webhooks CRUD', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('says the secret is shown once, on the create and on the rotate, and nowhere else', async () => {
    const { call, close } = await connect();
    const created = textOf(await call('create_webhook', { url: 'https://ci.example.com/mandala' }));
    expect(created).toMatch(/SHOWN ONCE/);
    expect(created).toContain(WEBHOOK_CREATED.secret);

    const rotated = textOf(await call('rotate_webhook_secret', { webhook_id: WEBHOOK.id }));
    expect(rotated).toMatch(/SHOWN ONCE/);
    expect(rotated).toContain(WEBHOOK_CREATED.secret);

    // The listing and the read: the platform never sends a secret on either,
    // and neither sentence should claim one is there to be found.
    for (const [tool, args] of [
      ['list_webhooks', {}],
      ['get_webhook', { webhook_id: WEBHOOK.id }],
    ] as const) {
      const text = textOf(await call(tool, args));
      expect(text).not.toContain('whsec_');
      expect(text).not.toMatch(/SHOWN ONCE/);
    }
    await close();
  });

  it('sends only the fields that were given, de-duplicated', async () => {
    const { call, close } = await connect();
    await call('create_webhook', {
      url: 'https://ci.example.com/mandala',
      events: ['process.exited', 'process.exited', 'computer.ready'],
    });
    const sent = platform.calls.find((c) => c.method === 'POST' && c.path === '/webhooks');
    expect(sent?.body).toEqual({
      url: 'https://ci.example.com/mandala',
      events: ['process.exited', 'computer.ready'],
    });
    await close();
  });

  it('refuses an empty update without a round trip', async () => {
    const { call, close } = await connect();
    const res = await call('update_webhook', { webhook_id: WEBHOOK.id });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/name at least one/);
    expect(platform.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    await close();
  });

  it('describes a delivery listing by state and says what the newest one did', async () => {
    const { call, close } = await connect();
    const text = textOf(await call('list_webhook_deliveries', { webhook_id: WEBHOOK.id }));
    expect(text).toContain('1 deliveries');
    expect(text).toContain('1 delivered');
    expect(text).toMatch(/process\.exited event, accepted after 1 attempt/);
    await close();
  });

  it('says a test delivery is queued rather than done', async () => {
    const { call, close } = await connect();
    const text = textOf(await call('test_webhook', { webhook_id: WEBHOOK.id }));
    // The 202 is the whole point: the endpoint has not been called when this
    // answers, and a model that reads "sent" here goes on to report a success
    // it never observed.
    expect(text).toMatch(/has not been called yet/);
    expect(text).toContain('list_webhook_deliveries');
    await close();
  });

  // A variant of the platform's answer, swapped in over the fake the way
  // retention.test.ts reads its own variants: installFakePlatform serves one
  // healthy fixture, and these cases are about the shapes it does not carry.
  const answering =
    (body: unknown, status = 200) =>
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
  const over = async (
    body: unknown,
    status: number,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    const restore = globalThis.fetch;
    globalThis.fetch = answering(body, status) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call(tool, args);
      await close();
      return res;
    } finally {
      globalThis.fetch = restore;
    }
  };

  it('names update_webhook, not the HTTP verb, when the platform has disabled one', async () => {
    const res = await over(
      { ...WEBHOOK, enabled: false, disabled_reason: 'failing', disabled_at: WEBHOOK.updated_at },
      200,
      'get_webhook',
      { webhook_id: WEBHOOK.id },
    );
    const text = textOf(res);
    expect(text).toMatch(/DISABLED BY THE PLATFORM/);
    expect(text).toContain('update_webhook with enabled: true');
    expect(text).not.toMatch(/PATCH/);
  });

  it('orders the last success and the last failure by the clock, not by the string', async () => {
    // A success on the second and a failure 100 ms later, spelled the way two
    // timestamps from one platform can be: one without fractional seconds and
    // one with. As strings the success sorts later, because '.' < 'Z'.
    const res = await over(
      {
        ...WEBHOOK,
        last_success_at: '2026-09-01T12:00:05Z',
        last_failure_at: '2026-09-01T12:00:05.1Z',
        last_status: 503,
      },
      200,
      'get_webhook',
      { webhook_id: WEBHOOK.id },
    );
    const text = textOf(res);
    expect(text).toContain('failing since its last success');
    expect(text).toContain('HTTP 503');
    expect(text).not.toContain('healthy');
  });

  it('answers a 404 on delete as a success that does not say deleted', async () => {
    // The retry `idempotentHint` invites, after a lost 2xx — and equally the
    // answer for an id that was never on this account. Both readings named,
    // neither claimed; the same shape delete_computer and delete_snapshot use.
    const res = await over({ error: 'webhook not found' }, 404, 'delete_webhook', {
      webhook_id: 'whk-0000000000000000',
      confirm: true,
    });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain('Nothing was deleted');
    expect(text).not.toMatch(/^Deleted/);
    expect(text).toContain('list_webhooks');
  });

  it('reaches every route without a computer selected', async () => {
    // Account-scoped, all of it: none of these tools should consult the
    // session's computer, and a session with none bound must still be able to
    // set a webhook up. The harness binds nothing by default.
    const { call, close } = await connect();
    for (const [tool, args] of [
      ['list_webhooks', {}],
      ['create_webhook', { url: 'https://ci.example.com/mandala' }],
      ['get_webhook', { webhook_id: WEBHOOK.id }],
      ['update_webhook', { webhook_id: WEBHOOK.id, enabled: true }],
      ['rotate_webhook_secret', { webhook_id: WEBHOOK.id }],
      ['test_webhook', { webhook_id: WEBHOOK.id }],
      ['list_webhook_deliveries', { webhook_id: WEBHOOK.id }],
      ['delete_webhook', { webhook_id: WEBHOOK.id, confirm: true }],
    ] as const) {
      const res = await call(tool, args);
      expect(res.isError, `${tool}: ${textOf(res)}`).toBeFalsy();
    }
    expect(platform.calls.every((c) => c.path.startsWith('/webhooks'))).toBe(true);
    await close();
  });
});

describe('webhookBody', () => {
  it('refuses what the platform would refuse, before the round trip', () => {
    expect(() => webhookBody({ url: 'http://ci.example.com/x' })).toThrow(/https/);
    expect(() => webhookBody({ url: 'https://user:pw@ci.example.com/x' })).toThrow(/username/);
    expect(() => webhookBody({ url: 'not a url' })).toThrow(/not a URL/);
    expect(() => webhookBody({ description: 'x'.repeat(201) })).toThrow(/at most 200/);
    expect(() =>
      webhookBody({ computers: Array.from({ length: 65 }, (_, i) => `vm-${i}`) }),
    ).toThrow(/at most 64/);
    expect(() => webhookBody({ computers: ['vm-1', ''] })).toThrow(/empty id/);
  });

  it('collapses two spellings of one computer, and sends the trimmed id', () => {
    // The de-duplication ran over the raw strings and `trim()` was used only as
    // an emptiness test, so `' vm-1'` survived as a second entry naming one
    // machine: counted twice against the platform's cap, and a filter matching
    // no computer, so the subscription silently delivered nothing for the
    // machine the caller had asked for.
    expect(webhookBody({ computers: ['vm-1', ' vm-1'] })).toEqual({ computers: ['vm-1'] });
    expect(webhookBody({ computers: [' vm-2\n'] })).toEqual({ computers: ['vm-2'] });
    expect(() => webhookBody({ computers: ['vm-1', '  '] })).toThrow(/empty id/);
  });

  it('leaves the event vocabulary to the platform', () => {
    // The platform's 400 lists the current vocabulary; a list held here would
    // refuse a type the platform had started accepting.
    expect(webhookBody({ events: ['something.new'] })).toEqual({ events: ['something.new'] });
  });

  it('drops what was not given, so an update leaves it alone', () => {
    expect(webhookBody({})).toEqual({});
    expect(webhookBody({ enabled: false })).toEqual({ enabled: false });
    // A trimmed url, the way every other body here is trimmed.
    expect(webhookBody({ url: ' https://ci.example.com/x ' })).toEqual({
      url: 'https://ci.example.com/x',
    });
  });
});
