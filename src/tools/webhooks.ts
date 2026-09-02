import { z } from 'zod';
import { guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

/**
 * The webhooks resource (platform OPL-4300), mirrored as the CRUD and nothing
 * more (OPL-4306). This server never RECEIVES a webhook — it has no endpoint
 * for the platform to POST to, and a model taking turns has nowhere to be
 * woken — so there is no `verify` here, and deliberately so: the design says in
 * as many words that the MCP server and the CLI get the CRUD only. What a
 * model does with these is set up the endpoint a CI job or a queue worker will
 * be woken at, read whether deliveries are reaching it, and hand the secret
 * over to whoever runs it.
 *
 * Every tool here is account-scoped, like `get_usage` and `get_retention`: a
 * subscription belongs to the account and receives events from many computers,
 * so none of them takes a `computer_id` and none of them consults the session's
 * selected computer. A `computers` FILTER is a different thing and is a body
 * field.
 */

const webhookIdArg = {
  webhook_id: z.string().describe('The subscription id — `whk-` and sixteen hex characters.'),
};

/**
 * The types a webhook can subscribe to, for the tool descriptions only.
 *
 * The socket's vocabulary less `file.changed`, which a webhook never carries:
 * a file watch is a connection parameter on the socket, and a webhook has no
 * connection to set one on. Not an enum on the argument, for the reason
 * `wait_for_event` gives about its own list: the platform refuses an unknown
 * type with a 400 that lists the current vocabulary, so a closed enum here
 * would refuse a type the platform had started accepting.
 */
const EVENT_TYPES = [
  'window.opened',
  'window.closed',
  'window.focused',
  'window.blurred',
  'clipboard.changed',
  'process.exited',
  'computer.idle',
  'computer.ready',
  'computer.started',
  'computer.stopped',
  'computer.suspended',
];

const filterArgs = {
  description: z.string().optional().describe('Free text for the listing, up to 200 characters.'),
  events: z
    .array(z.string())
    .optional()
    .describe(
      `Event types to deliver: ${EVENT_TYPES.join(', ')}. Omit or send [] for every type. file.changed is never delivered to a webhook. An unknown type is refused by the platform with the current list.`,
    ),
  computers: z
    .array(z.string())
    .optional()
    .describe(
      'Computer ids to deliver for, up to 64. Omit or send [] for every computer the key can see. Not checked against your computers — a subscription may name a computer you are about to create.',
    ),
  enabled: z.boolean().optional().describe('Whether deliveries are made.'),
};

type Webhook = {
  id?: string;
  url?: string;
  enabled?: boolean;
  disabled_reason?: string | null;
  last_success_at?: string | null;
  last_failure_at?: string | null;
  last_status?: number | null;
  secret?: string;
};

type Delivery = {
  id?: string;
  event_type?: string;
  state?: string;
  attempts?: number;
  last_status?: number | null;
  last_error?: string | null;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * One subscription's health in a clause, for the sentence in front of a
 * listing or a read. Says the thing a model acts on — whether deliveries are
 * being made, and if not, whose decision that was — rather than restating the
 * timestamps underneath it.
 */
function health(w: Webhook): string {
  if (w.enabled === false) {
    return w.disabled_reason === 'failing'
      ? 'DISABLED BY THE PLATFORM after a day of failures — PATCH enabled: true to start it again'
      : 'disabled by you';
  }
  if (w.last_success_at && !w.last_failure_at) return 'healthy';
  if (w.last_failure_at && !w.last_success_at) {
    return `no delivery has ever been accepted (newest attempt: ${attempt(w.last_status)})`;
  }
  if (w.last_failure_at && w.last_success_at && w.last_failure_at > w.last_success_at) {
    return `failing since its last success (newest attempt: ${attempt(w.last_status)})`;
  }
  if (w.last_success_at) return 'healthy';
  return 'nothing delivered yet';
}

const attempt = (status: number | null | undefined) =>
  typeof status === 'number' ? `HTTP ${status}` : 'no answer';

/**
 * The sentence in front of a create or a rotate — the two answers that carry
 * the secret, and the only two that ever will. Said in the first line rather
 * than left to the schema, because a model that files the JSON away and reads
 * it back later has, by then, lost the one thing that cannot be re-read.
 */
const shownOnce = (verb: string, w: Webhook) =>
  `${verb} ${w.id ?? 'the subscription'}. THE SECRET IN THIS ANSWER IS SHOWN ONCE and cannot be read back: store it now, or hand it to whoever runs ${w.url ?? 'the endpoint'}. Every delivery is signed with it (Standard Webhooks v1: webhook-id, webhook-timestamp, webhook-signature over the raw body). rotate_webhook_secret is the only way to get another.`;

/** The states of a delivery listing, counted, so the line says what is stuck. */
function deliveriesLine(id: string, list: Delivery[]): string {
  if (!list.length) {
    return `No deliveries recorded for ${id}. Either nothing it subscribes to has happened, or it was created too recently — test_webhook queues one you can watch for here.`;
  }
  const counts = new Map<string, number>();
  for (const d of list)
    counts.set(d.state ?? 'unknown', (counts.get(d.state ?? 'unknown') ?? 0) + 1);
  const summary = [...counts].map(([state, n]) => `${n} ${state}`).join(', ');
  const newest = list[0];
  const outcome =
    newest.state === 'delivered'
      ? 'accepted'
      : `${newest.state}${newest.last_error ? ` (${newest.last_error})` : ''}`;
  return (
    `${list.length} deliveries for ${id}, newest first: ${summary}. The newest is a ${newest.event_type ?? 'unknown'} event, ${outcome} after ${newest.attempts ?? 0} attempt(s). ` +
    'exhausted means eight attempts failed over about fourteen hours and it will not be retried; pending and in_flight are still being tried.'
  );
}

export const registerWebhooks: Registrar = (server, session) => {
  server.registerTool(
    'list_webhooks',
    {
      title: 'List webhook subscriptions',
      description:
        'Every webhook subscription on the account, with its health: whether it is enabled, when its endpoint last accepted a delivery and when one last failed. A webhook is an HTTPS endpoint the platform POSTs events to — the other transport for the same events wait_for_event reads, for a CI job or a queue worker that wants to be woken rather than to wait. Never carries a secret: that is shown once, by create_webhook or rotate_webhook_secret. A workspace-scoped key sees only the subscriptions confined to that workspace.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    (_args, extra) =>
      guarded(async () => {
        const body = await session.api.with(extra.signal).json<unknown>('GET', P.WEBHOOKS);
        const list = Array.isArray(body) ? (body as Webhook[]) : [];
        if (!list.length) {
          return said('No webhook subscriptions on this account. create_webhook makes one.', body);
        }
        const lines = list.map((w) => `${w.id ?? '?'} → ${w.url ?? '?'}: ${health(w)}`);
        return said(
          `${list.length} webhook subscription${list.length === 1 ? '' : 's'}, oldest first:\n${lines.join('\n')}`,
          body,
        );
      }),
  );

  server.registerTool(
    'create_webhook',
    {
      title: 'Subscribe an endpoint to this account’s events',
      description:
        'Subscribe an HTTPS endpoint to this account’s events. THE ANSWER CARRIES THE SIGNING SECRET ONCE — it is not readable again, so store it or hand it over before doing anything else. Each event is POSTed as the same JSON object wait_for_event hands you, byte for byte, signed with Standard Webhooks v1 headers (webhook-id, webhook-timestamp, webhook-signature); the receiver should verify the raw body, acknowledge with a 2xx before doing the work, and refuse a timestamp more than 300 seconds off. Failed deliveries are retried eight times over about fourteen hours; an endpoint that keeps failing for a day is disabled. The url must be https, must not carry a username or password, and must resolve to a public address — a private or loopback address is refused. Paid plans allow ten subscriptions; an account with no plan allows none.',
      inputSchema: {
        url: z
          .string()
          .describe(
            'Where to POST. https:// only, no username or password, resolving to a public address. A port other than 443 is fine.',
          ),
        ...filterArgs,
      },
    },
    (args, extra) =>
      guarded(async () => {
        const w = asRecord(
          await session.api
            .with(extra.signal)
            .json<unknown>('POST', P.WEBHOOKS, { body: P.webhookBody(args) }),
        ) as Webhook;
        return said(shownOnce('Created', w), w);
      }),
  );

  server.registerTool(
    'get_webhook',
    {
      title: 'Read a webhook subscription',
      description:
        'One subscription with its health: whether it is enabled and why not if not, when the endpoint last accepted a delivery, when one last failed, and the status of the newest attempt. Never the secret. For the individual deliveries and what became of each, list_webhook_deliveries.',
      inputSchema: webhookIdArg,
      annotations: { readOnlyHint: true },
    },
    ({ webhook_id }, extra) =>
      guarded(async () => {
        const w = asRecord(
          await session.api.with(extra.signal).json<unknown>('GET', P.webhook(webhook_id)),
        ) as Webhook;
        return said(`${w.id ?? webhook_id} → ${w.url ?? '?'}: ${health(w)}.`, w);
      }),
  );

  server.registerTool(
    'update_webhook',
    {
      title: 'Change a webhook subscription',
      description:
        'Change the endpoint, the description, the filters, or whether it is enabled. Fields you leave out are kept as they are; name at least one. A new url is checked exactly as on create. enabled: true clears a disable the platform imposed for failures and starts fresh; enabled: false stops deliveries and records that you chose to. The secret does not change — rotate_webhook_secret is for that.',
      inputSchema: {
        ...webhookIdArg,
        url: z
          .string()
          .optional()
          .describe(
            'A new endpoint, checked exactly as on create: https, no credentials, public address.',
          ),
        ...filterArgs,
      },
      annotations: { idempotentHint: true },
    },
    ({ webhook_id, ...fields }, extra) =>
      guarded(async () => {
        const body = P.webhookBody(fields);
        if (!Object.keys(body).length) {
          return refused(
            'Nothing to change: name at least one of url, description, events, computers or enabled. The platform refuses an empty update, so nothing was sent.',
          );
        }
        const w = asRecord(
          await session.api
            .with(extra.signal)
            .json<unknown>('PATCH', P.webhook(webhook_id), { body }),
        ) as Webhook;
        return said(`Updated ${w.id ?? webhook_id} → ${w.url ?? '?'}: ${health(w)}.`, w);
      }),
  );

  server.registerTool(
    'rotate_webhook_secret',
    {
      title: 'Rotate a webhook’s signing secret',
      description:
        'Mint a new signing secret for a subscription. THE ANSWER CARRIES IT ONCE, like create_webhook. The old secret goes on being honoured for 24 hours — every delivery in that window carries two signatures on the one webhook-signature header, new first, so a receiver that accepts either passes throughout — which is the window to get the new one deployed. Rotating again inside it replaces the previous secret rather than keeping three. Do this when a secret has leaked or when whoever held it has moved on.',
      inputSchema: webhookIdArg,
    },
    ({ webhook_id }, extra) =>
      guarded(async () => {
        const w = asRecord(
          await session.api
            .with(extra.signal)
            .json<unknown>('POST', P.webhookAction(webhook_id, 'rotate')),
        ) as Webhook;
        return said(shownOnce('Rotated the secret on', w), w);
      }),
  );

  server.registerTool(
    'test_webhook',
    {
      title: 'Send a test delivery',
      description:
        'Queue one signed delivery of a synthetic webhook.test event through the ordinary path, so it is signed, retried and recorded exactly as a real one. The answer is the delivery record, ACCEPTED rather than finished: the endpoint has not been called yet when this returns. Read what it said back with list_webhook_deliveries a little later — a first attempt goes out within seconds, and a failed one is retried after 30 seconds. A disabled subscription is refused; enable it first with update_webhook.',
      inputSchema: webhookIdArg,
    },
    ({ webhook_id }, extra) =>
      guarded(async () => {
        const d = asRecord(
          await session.api
            .with(extra.signal)
            .json<unknown>('POST', P.webhookAction(webhook_id, 'test')),
        ) as Delivery;
        return said(
          `Queued test delivery ${d.id ?? ''} to ${webhook_id}. It is ${d.state ?? 'pending'}: the endpoint has not been called yet. Call list_webhook_deliveries for ${webhook_id} in a few seconds to read what it answered.`,
          d,
        );
      }),
  );

  server.registerTool(
    'list_webhook_deliveries',
    {
      title: 'List a webhook’s deliveries',
      description:
        'The newest hundred deliveries to one subscription, newest first, each with its state (pending, in_flight, delivered, exhausted or dropped), its attempt count, and the HTTP status or one-line error of its newest attempt. This is where a delivery that ran out of attempts shows up — nothing is dropped silently. Finished deliveries are kept for seven days. Each carries the event’s cursor, which is what to pass as since to the socket to read on from that point.',
      inputSchema: webhookIdArg,
      annotations: { readOnlyHint: true },
    },
    ({ webhook_id }, extra) =>
      guarded(async () => {
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('GET', P.webhookAction(webhook_id, 'deliveries'));
        const list = Array.isArray(body) ? (body as Delivery[]) : [];
        return said(deliveriesLine(webhook_id, list), body);
      }),
  );

  server.registerTool(
    'delete_webhook',
    {
      title: 'Delete a webhook subscription',
      description:
        'Remove a subscription and every delivery record it holds, pending ones included. Nothing more is sent to the endpoint. Irreversible: a new subscription to the same url gets a new id and a new secret. To stop deliveries without losing the record, update_webhook with enabled: false instead.',
      inputSchema: {
        ...webhookIdArg,
        confirm: z
          .literal(true)
          .describe('Must be true. This removes the subscription and its delivery history.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ webhook_id }, extra) =>
      guarded(async () => {
        const res = await session.api.with(extra.signal).send('DELETE', P.webhook(webhook_id));
        return said(
          `Deleted ${webhook_id}. Nothing more will be sent to its endpoint, and its delivery history is gone with it.`,
          res,
        );
      }),
  );
};
