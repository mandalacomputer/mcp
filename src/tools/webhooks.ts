import { z } from 'zod';
import { NotFoundError } from '../errors.js';
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

/**
 * The four fields a create and an update share, described for the one being
 * built. Omission means two different things on the two routes — "every
 * type" on a create, "leave the filter as it is" on an update — and a model
 * fills a field from ITS description, not from the tool's, so each has to say
 * which it means. One shared copy said the create meaning on both.
 */
const filterArgs = (on: 'create' | 'update') => {
  const omit =
    on === 'create'
      ? 'Omit or send [] for every'
      : 'Omit to keep the current filter; send [] to clear it to every';
  return {
    description: z.string().optional().describe('Free text for the listing, up to 200 characters.'),
    events: z
      .array(z.string())
      .optional()
      .describe(
        `Event types to deliver: ${EVENT_TYPES.join(', ')}. ${omit} type. file.changed is never delivered to a webhook. An unknown type is refused by the platform with the current list.`,
      ),
    computers: z
      .array(z.string())
      .optional()
      .describe(
        `Computer ids to deliver for, up to 64. ${omit} computer the key can see. Not checked against your computers — a subscription may name a computer you are about to create.`,
      ),
    enabled: z.boolean().optional().describe('Whether deliveries are made.'),
  };
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const asRecord = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** What a body turned out to be, for a refusal that names the shape that arrived. */
const shapeOf = (v: unknown): string =>
  v === undefined ? 'no body at all' : v === null ? 'null' : typeof v;

/**
 * The rows of a listing, checked, the way `list_computers`, `list_snapshots`
 * and `list_builds` check theirs.
 *
 * Two separate mistakes, and the sentence in front of a listing depends on
 * telling them apart. A body that is not an array at all — an error envelope, a
 * future paginated wrapper, a gateway answering 200 with nothing — coerced to
 * `[]` becomes an affirmative claim about the account made from a body this
 * server could not read; and a listing whose ROWS are not objects throws at the
 * first `w.id` before any `??` can help, so `guarded` turns the whole answer
 * into an opaque failure. Neither is an empty list, and only one of the two
 * answers invites an action.
 */
const rowsOf = (
  body: unknown,
): { rows: Record<string, unknown>[]; malformed: number } | undefined =>
  Array.isArray(body)
    ? { rows: body.filter(isRecord), malformed: body.filter((item) => !isRecord(item)).length }
    : undefined;

const malformedWarning = (noun: string, n: number): string =>
  n
    ? `WARNING: ignored ${n} malformed ${noun} entr${n === 1 ? 'y' : 'ies'} from the platform.\n\n`
    : '';

/**
 * The single record a one-subscription call answers with, or nothing.
 *
 * The same mistake `rowsOf` refuses for a listing, one object down. `asRecord`
 * turns anything that is not a record into `{}`, and `{}` reads as a
 * subscription with every field absent — which the sentences below then fill
 * in from their own fallbacks and state as fact: `wh_x → ?: nothing delivered
 * yet` is an affirmative report of a subscription's health, and `Updated wh_x`
 * an affirmative report that a change landed, both assembled from a body this
 * server could not read. `json()` throws only for an empty body, so a gateway
 * answering `200 "OK"`, `200 []` or `200 5` arrives here intact.
 */
const recordOf = (body: unknown): Record<string, unknown> | undefined =>
  isRecord(body) ? body : undefined;

/**
 * One subscription's health in a clause, for the sentence in front of a
 * listing or a read. Says the thing a model acts on — whether deliveries are
 * being made, and if not, whose decision that was — rather than restating the
 * timestamps underneath it.
 */
function health(w: Webhook): string {
  if (w.enabled === false) {
    return w.disabled_reason === 'failing'
      ? 'DISABLED BY THE PLATFORM after a day of failures — update_webhook with enabled: true to start it again'
      : 'disabled by you';
  }
  const success = instant(w.last_success_at);
  const failure = instant(w.last_failure_at);
  if (success !== undefined && failure === undefined) return 'healthy';
  if (failure !== undefined && success === undefined) {
    return `no delivery has ever been accepted (newest attempt: ${attempt(w.last_status)})`;
  }
  if (failure !== undefined && success !== undefined && failure > success) {
    return `failing since its last success (newest attempt: ${attempt(w.last_status)})`;
  }
  if (success !== undefined) return 'healthy';
  return 'nothing delivered yet';
}

/**
 * A timestamp as a number, or undefined for anything that is not one. Parsed
 * rather than compared as strings: two RFC 3339 spellings of nearby instants —
 * one with fractional seconds and one without — do not sort by the clock, and
 * a "healthy" read off that would be wrong about the newest attempt.
 */
function instant(v: string | null | undefined): number | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
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

/**
 * Whether a 2xx from a create or a rotate actually carries the secret its
 * sentence is about to promise.
 *
 * `asRecord` coerces anything it cannot read to `{}`, which costs a `?` in a
 * listing and costs the whole answer here. The secret is minted once and is
 * never readable again, so "THE SECRET IN THIS ANSWER IS SHOWN ONCE" over a
 * body holding none tells the caller to store something that is not there — and
 * on a rotate the OLD secret is already on its 24-hour clock by then, so the
 * loss surfaces a day later as deliveries failing signature checks, with
 * nothing in the answer that pointed at it. Checked the way build_template
 * checks a 2xx for its `id` (OPL-3835): if the one field that cannot be
 * re-fetched is not there, say the call MAY have happened rather than claim it
 * did.
 */
const carriesSecret = (w: Webhook): boolean =>
  typeof w.secret === 'string' && w.secret.trim() !== '';

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
    `${list.length} deliver${list.length === 1 ? 'y' : 'ies'} for ${id}, newest first: ${summary}. The newest is a ${newest.event_type ?? 'unknown'} event, ${outcome} after ${newest.attempts ?? 0} attempt(s). ` +
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
        const checked = rowsOf(body);
        if (!checked) {
          return refused(
            `GET /webhooks answered with ${shapeOf(body)}, not a list of subscriptions. This is not an empty account — do not create a webhook on the strength of it.`,
            body,
          );
        }
        const list = checked.rows as Webhook[];
        const warning = malformedWarning('webhook', checked.malformed);
        if (!list.length) {
          if (checked.malformed) {
            return refused(
              `${warning}No valid webhook subscriptions remained. This is not an empty account — do not create a webhook on the strength of a malformed listing.`,
              body,
            );
          }
          return said(
            `${warning}No webhook subscriptions on this account. create_webhook makes one.`,
            body,
          );
        }
        const lines = list.map((w) => `${w.id ?? '?'} → ${w.url ?? '?'}: ${health(w)}`);
        return said(
          `${warning}${list.length} webhook subscription${list.length === 1 ? '' : 's'}, oldest first:\n${lines.join('\n')}`,
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
        ...filterArgs('create'),
      },
    },
    (args, extra) =>
      guarded(async () => {
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('POST', P.WEBHOOKS, { body: P.webhookBody(args) });
        const w = asRecord(body) as Webhook;
        if (!carriesSecret(w)) {
          return refused(
            `POST /webhooks answered with ${shapeOf(body)} and no \`secret\`, so the signing secret is NOT in this answer and cannot be read back. THE SUBSCRIPTION MAY HAVE BEEN CREATED — call list_webhooks to find out rather than creating a second one, and rotate_webhook_secret on it for a secret you can actually store.`,
            body,
          );
        }
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
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('GET', P.webhook(webhook_id));
        const record = recordOf(body);
        if (!record) {
          return refused(
            `GET ${webhook_id} answered with ${shapeOf(body)}, not a subscription. Nothing here says whether it is enabled or what it has delivered — do not read this as a healthy subscription with an empty history.`,
            body,
          );
        }
        const w = record as Webhook;
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
        ...filterArgs('update'),
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
        const answered = await session.api
          .with(extra.signal)
          .json<unknown>('PATCH', P.webhook(webhook_id), { body });
        const record = recordOf(answered);
        if (!record) {
          return refused(
            `The update to ${webhook_id} answered with ${shapeOf(answered)}, not a subscription. THE CHANGE MAY HAVE LANDED — read it back with get_webhook rather than sending it again, since a second update would overwrite whatever the first one did.`,
            answered,
          );
        }
        const w = record as Webhook;
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
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('POST', P.webhookAction(webhook_id, 'rotate'));
        const w = asRecord(body) as Webhook;
        if (!carriesSecret(w)) {
          return refused(
            `The rotate on ${webhook_id} answered with ${shapeOf(body)} and no \`secret\`, so the new signing secret is NOT in this answer and cannot be read back. THE ROTATE MAY HAVE HAPPENED — and if it did, the old secret is already on its 24-hour clock and deliveries will start failing signature checks when it runs out. Read the subscription with get_webhook, then rotate again: rotating inside the window replaces the pending secret rather than keeping three, so a second rotate is safe and is the only way to get one you can store.`,
            body,
          );
        }
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
        const answered = await session.api
          .with(extra.signal)
          .json<unknown>('POST', P.webhookAction(webhook_id, 'test'));
        const record = recordOf(answered);
        if (!record) {
          return refused(
            `The test delivery on ${webhook_id} answered with ${shapeOf(answered)}, not a delivery record. IT MAY HAVE BEEN QUEUED — call list_webhook_deliveries for ${webhook_id} in a few seconds to find out, rather than queueing a second one.`,
            answered,
          );
        }
        const d = record as Delivery;
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
        const checked = rowsOf(body);
        if (!checked) {
          return refused(
            `GET the deliveries of ${webhook_id} answered with ${shapeOf(body)}, not a list of deliveries. This is not an empty history — do not conclude anything about what has been delivered from it.`,
            body,
          );
        }
        const list = checked.rows as Delivery[];
        const warning = malformedWarning('delivery', checked.malformed);
        if (!list.length && checked.malformed) {
          return refused(
            `${warning}No valid deliveries remained for ${webhook_id}. This is not an empty history — do not conclude anything about what has been delivered from it.`,
            body,
          );
        }
        return said(`${warning}${deliveriesLine(webhook_id, list)}`, body);
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
        let res: unknown;
        try {
          res = await session.api.with(extra.signal).send('DELETE', P.webhook(webhook_id));
        } catch (err) {
          // A 404 is the state this call asked for, and this tool is annotated
          // `idempotentHint`, so the retry after a lost 2xx is one a client is
          // invited to make. Said as a success but not as "Deleted": the same
          // 404 answers an id that was never on this account — the platform
          // will not say whether a subscription exists outside your scope —
          // and "deleted" over a mistyped id leaves a real subscription
          // delivering. delete_computer and delete_snapshot answer the same way.
          if (!(err instanceof NotFoundError)) throw err;
          return said(
            `Nothing was deleted: the platform has no webhook with the id ${webhook_id} on this account. ` +
              'Either it was already removed — if this is a retry, the first call is the one that did it — or ' +
              'the id is not one of yours, in which case NO subscription has been touched and a real one may ' +
              'still be delivering under the id you meant. list_webhooks says which of the two this is.',
          );
        }
        return said(
          `Deleted ${webhook_id}. Nothing more will be sent to its endpoint, and its delivery history is gone with it.`,
          res,
        );
      }),
  );
};
