import { z } from 'zod';
import { APIError } from '../errors.js';
import { said } from '../format.js';
import * as P from '../paths.js';
import { count, label, metadata, metadataCall } from './directory.js';
import { readAnnotations } from './results.js';
import type { Registrar } from './types.js';

// Every object projects only its public fields; a malformed report never becomes zero usage.
const report = z
  .object({
    scope: z.literal('account'),
    advisory: z.literal(true),
    observed_at: z.string().datetime(),
    plan: z.object({ id: label, label }),
    limits: z.object({
      max_computers: count,
      vcpu_pool: count,
      ram_pool_mb: count,
      disk_pool_gb: count,
      snapshot_storage_bytes: count,
    }),
    per_computer: z.object({ max_vcpu: count, max_ram_mb: count, max_disk_gb: count }),
    capabilities: z.object({ windows: z.boolean() }),
    complete: z.object({ computers: z.boolean(), snapshots: z.boolean() }),
    usage: z.object({
      kept_computers: count.nullable(),
      configured_vcpu: count.nullable(),
      configured_disk_gb: count.nullable(),
      running_or_reserved_computers: count.nullable(),
      running_or_reserved_vcpu: count.nullable(),
      running_or_reserved_ram_mb: count.nullable(),
      snapshot_storage_bytes: count.nullable(),
    }),
    remaining: z.object({
      kept_computers: count.nullable(),
      configured_vcpu: count.nullable(),
      configured_disk_gb: count.nullable(),
      running_or_reserved_ram_mb: count.nullable(),
      snapshot_storage_bytes: count.nullable(),
    }),
  })
  .refine((data) => {
    for (const group of [data.usage, data.remaining]) {
      for (const [field, value] of Object.entries(group)) {
        const complete =
          field === 'snapshot_storage_bytes' ? data.complete.snapshots : data.complete.computers;
        if (complete !== (value !== null)) return false;
      }
    }
    if (data.complete.computers) {
      // Nullability was checked above. These are relationships within one observation,
      // independent of plan ceilings: a consistent account can still be over quota.
      const kept = data.usage.kept_computers!;
      const cpu = data.usage.configured_vcpu!;
      const disk = data.usage.configured_disk_gb!;
      const active = data.usage.running_or_reserved_computers!;
      const activeCPU = data.usage.running_or_reserved_vcpu!;
      const activeRAM = data.usage.running_or_reserved_ram_mb!;
      if (active > kept || activeCPU > cpu) return false;
      // Equal counts mean both CPU sums cover every kept computer.
      if (active === kept && activeCPU !== cpu) return false;
      if (kept === 0 && (cpu !== 0 || disk !== 0)) return false;
      if (active === 0 && (activeCPU !== 0 || activeRAM !== 0)) return false;
      // Each active computer contributes positive integer MB, but its CPU may be zero.
      if (activeRAM < active) return false;
    }
    const ceilings = {
      kept_computers: data.limits.max_computers,
      configured_vcpu: data.limits.vcpu_pool,
      configured_disk_gb: data.limits.disk_pool_gb,
      running_or_reserved_ram_mb: data.limits.ram_pool_mb,
      snapshot_storage_bytes: data.limits.snapshot_storage_bytes,
    };
    for (const field of Object.keys(ceilings) as (keyof typeof ceilings)[]) {
      const used = data.usage[field];
      if (used !== null && data.remaining[field] !== Math.max(0, ceilings[field] - used))
        return false;
    }
    return true;
  });

// Who the credential is, and the holder's keys (platform OPL-5053). Both
// projected to the public fields only; the raw key is never on either answer.
const apiKey = z.object({
  id: label,
  name: z.string().nullable(),
  prefix: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  workspace_id: z.string().nullable(),
  workspace_name: z.string().nullable(),
  manage_keys: z.boolean(),
});
const whoami = z.object({
  user: z.object({ id: label, email: z.string(), name: z.string().nullable() }),
  account: z.object({
    id: label,
    name: z.string().nullable(),
    plan: z.string(),
    status: z.string(),
  }),
  role: label,
  workspace: z.object({ id: label, name: z.string(), created_at: z.string() }).nullable(),
  key: apiKey.nullable(),
});

/**
 * Minting and revoking keys are deliberately NOT tools (OPL-5053), though the
 * platform has both routes:
 *
 * - A mint answers the raw key, once. Handed to a model it lands in the
 *   conversation, the client's logs and whatever the transcript is shared
 *   with — the worst place a long-lived credential can be, and one nobody can
 *   take it back from.
 * - A revoke is irreversible and can cut off the person's CI, another agent,
 *   or this very session, on a model's reading of a list.
 *
 * Listing is safe to offer: it never carries a raw key. People mint and revoke
 * from the dashboard or the `mandala api-keys` CLI.
 */
export const registerAccount: Registrar = (server, session) => {
  server.registerTool(
    'whoami',
    {
      title: 'Who this credential is',
      description:
        'Who the API key this server runs with belongs to: the person (id, email, name), the account it acts on (id, name, plan, status: active or suspended), the role it acts with now (owner, member or viewer), the workspace it is confined to (null for the whole account), and the key itself (id, name, prefix, and manage_keys: whether it may manage API keys). Needs no permission and any role; a suspended account can call it. No arguments.',
      inputSchema: z.object({}).strict(),
      annotations: readAnnotations,
    },
    (_args, extra) =>
      metadataCall(async () => {
        const data = metadata(
          whoami,
          await session.api.json('GET', P.WHOAMI, { signal: extra.signal }),
        );
        const scope = data.workspace
          ? `confined to workspace ${data.workspace.name} (${data.workspace.id})`
          : 'acting on the whole account';
        return said(
          `${data.user.email} as ${data.role} on ${data.account.name ?? data.account.id} (${data.account.status}), ${scope}.` +
            (data.account.status === 'suspended'
              ? ' The account is SUSPENDED: other calls will be refused until it is reinstated.'
              : ''),
          data,
        );
      }),
  );

  server.registerTool(
    'list_api_keys',
    {
      title: 'List your API keys',
      description:
        'The API keys of the person this server\'s key belongs to, on the account it acts on, newest first: id, name, prefix (display only), scope, when last used, and manage_keys. Never a raw key. Needs this server\'s key to have the "Manage keys" permission, which only a person can turn on, in the dashboard; without it the answer is a 403 that says so — relay it rather than retrying. A key confined to a workspace sees only keys confined to that workspace. Minting and revoking keys are not available here: they are done in the dashboard or with the mandala CLI.',
      inputSchema: z.object({}).strict(),
      annotations: readAnnotations,
    },
    (_args, extra) =>
      metadataCall(async () => {
        const data = metadata(
          z.array(apiKey),
          await session.api.json('GET', P.API_KEYS, { signal: extra.signal }),
        );
        return said(
          data.length
            ? `${data.length} API key${data.length === 1 ? '' : 's'} this key can reach, newest first. None of them is shown in full; revoking one is done by a person, in the dashboard or with the mandala CLI.`
            : 'No API keys this key can reach.',
          data,
        );
      }),
  );

  server.registerTool(
    'get_account',
    {
      title: 'Read current account quota',
      description:
        'Read account-wide plan ceilings, per-computer maxima, current consumption and advisory remaining quota. Viewer or stronger; workspace-scoped keys receive aggregates without resource identities. No arguments, selected computer or model key. Incomplete computer/snapshot groups have null consumption and remaining values, meaning unknown. Snapshot headroom covers indexed stored bytes, excludes in-flight capture reservations and cannot promise that a capture will fit. This observation reserves nothing; later mutations still enforce quota.',
      inputSchema: z.object({}).strict(),
      annotations: readAnnotations,
    },
    (_args, extra) =>
      metadataCall(async () => {
        let raw: unknown;
        try {
          raw = await session.api.json('GET', P.ACCOUNT, { signal: extra.signal });
        } catch (error) {
          if (error instanceof APIError) {
            const refusal = z.object({ error: label.optional() }).safeParse(error.body);
            throw new APIError(
              refusal.success && refusal.data.error
                ? refusal.data.error
                : 'Account quota request failed',
              error.status,
              error.body,
              error.retryAfterMs,
              error,
            );
          }
          // JSON decoding failures can carry raw response text. Never print that text here.
          throw new Error(
            extra.signal.aborted
              ? 'Account quota read cancelled; no report was established.'
              : 'Account quota could not be read; consumption and remaining quota are unknown.',
          );
        }
        const data = metadata(report, raw);
        const unknown = [
          ...(!data.complete.computers ? ['computer'] : []),
          ...(!data.complete.snapshots ? ['snapshot'] : []),
        ];
        return said(
          (unknown.length
            ? `UNKNOWN ${unknown.join(' and ')} consumption and remaining quota: null is not zero. `
            : '') +
            'ADVISORY account observation; this reserves nothing and does not guarantee a later request will fit. ' +
            'Snapshot headroom is against indexed stored bytes only; in-flight capture reservations are not included. ' +
            'Configured CPU/disk cover kept computers; running or reserved RAM includes current reservations. ' +
            'Units are CPU, MB, GB and snapshot bytes as named. Use get_usage for historical metered consumption.',
          data,
        );
      }),
  );
};
