import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webhookBody } from '../src/paths.js';
import {
  connect,
  installFakePlatform,
  WEBHOOK,
  WEBHOOK_CREATED,
  WEBHOOK_DELIVERY,
} from './harness.js';

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
    // Singular, deliberately: this assertion pinned "1 deliveries", which was
    // incidental to a case about state counts and the newest one's outcome.
    expect(text).toContain('1 delivery for');
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

  // The shape-checking pass computers.ts, snapshots.ts and templates.ts got and
  // this module did not. A body this server could not read is not an empty
  // account, and the sentence in front of the JSON is what a model acts on.
  it('refuses a listing body that is not a list rather than calling the account empty', async () => {
    const res = await over({ error: 'gateway said no' }, 200, 'list_webhooks', {});
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('not a list of subscriptions');
    expect(text).toContain('This is not an empty account');
    // The sentence that invites the action is the one that must not be said
    // over an unreadable body: a model that reads it subscribes a second
    // endpoint on an account that may already have ten.
    expect(text).not.toContain('create_webhook makes one');
  });

  it('refuses a delivery body that is not a list rather than saying nothing was delivered', async () => {
    const res = await over({ error: 'gateway said no' }, 200, 'list_webhook_deliveries', {
      webhook_id: WEBHOOK.id,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('not a list of deliveries');
    // "Either nothing it subscribes to has happened, or it was created too
    // recently" is a positive claim about an endpoint never having been called.
    expect(textOf(res)).not.toContain('Either nothing it subscribes to');
  });

  // The same pass, one object down. `json()` throws only for an empty body, so
  // a gateway answering 200 with a string, a number or a list reaches these
  // three intact, and `{}` reads as a subscription with every field absent.
  it('refuses a single subscription body that is not a record rather than reporting its health', async () => {
    const res = await over('OK', 200, 'get_webhook', { webhook_id: WEBHOOK.id });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('not a subscription');
    // The claim that must not be made from a body this server could not read:
    // that the endpoint is fine and has simply never been called.
    expect(text).not.toContain('nothing delivered yet');
  });

  it('does not report an update as landed over a body it could not read', async () => {
    const res = await over([], 200, 'update_webhook', {
      webhook_id: WEBHOOK.id,
      description: 'renamed',
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('THE CHANGE MAY HAVE LANDED');
    // Not "Updated wh_… → ?" — and a model must not send it again blind,
    // because a second update overwrites whatever the first one did.
    expect(text).not.toMatch(/^Updated /);
    expect(text).toContain('get_webhook');
    // The shape it names is the shape that arrived. "answered with object, not
    // a subscription" is what a list used to read as, and an object is what a
    // subscription IS — a contradiction in the sentence a model acts on.
    expect(text).toContain('answered with a list');
    expect(text).not.toContain('answered with object');
  });

  it('does not report a test delivery as queued over a body it could not read', async () => {
    const res = await over(5, 200, 'test_webhook', { webhook_id: WEBHOOK.id });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('IT MAY HAVE BEEN QUEUED');
    expect(text).not.toContain('the endpoint has not been called yet');
  });

  it('drops malformed webhook rows and says how many, rather than failing the whole listing', async () => {
    // `list.map((w) => w.id ?? '?')` dereferences before the `??`, so one null
    // row threw a TypeError and `guarded` reported the listing as an opaque
    // failure — the rows this server could read going with it.
    const res = await over([WEBHOOK, null, 'bad projection'], 200, 'list_webhooks', {});
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(textOf(res)).toMatch(/ignored 2 malformed webhook entries/);
    expect(textOf(res)).toContain(WEBHOOK.id);
  });

  it('drops malformed delivery rows the same way', async () => {
    const res = await over([WEBHOOK_DELIVERY, null], 200, 'list_webhook_deliveries', {
      webhook_id: WEBHOOK.id,
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(textOf(res)).toMatch(/ignored 1 malformed delivery entry/);
    expect(textOf(res)).toContain('1 delivery for');
  });

  it('will not say a secret is in an answer that has no secret in it', async () => {
    // The sharpest of the four, and the reason this pass is not cosmetic. The
    // secret is minted once and never readable again, so "SHOWN ONCE" over a
    // body holding none tells the caller to store something that is not there.
    const res = await over({ ...WEBHOOK }, 201, 'create_webhook', {
      url: 'https://ci.example.com/mandala',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toMatch(/SHOWN ONCE/);
    expect(textOf(res)).toContain('MAY HAVE BEEN CREATED');
    expect(textOf(res)).toContain('list_webhooks');
  });

  it('says a rotate may have happened, and names the 24-hour clock, when no secret came back', async () => {
    // The old secret is already on its clock when this answer is written, so a
    // caller told to save a secret that is not in the payload finds out a day
    // later, as deliveries start failing signature checks.
    const res = await over([], 200, 'rotate_webhook_secret', { webhook_id: WEBHOOK.id });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toMatch(/SHOWN ONCE/);
    expect(textOf(res)).toContain('MAY HAVE HAPPENED');
    expect(textOf(res)).toContain('24-hour clock');
    expect(textOf(res)).toContain('get_webhook');
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
