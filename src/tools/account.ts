import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { APIError } from '../errors.js';
import { failed, originWording, said, unavailableAdvice } from '../format.js';
import * as P from '../paths.js';
import { count, label, metadata, metadataCall } from './directory.js';
import { deleteAnnotations, readAnnotations } from './results.js';
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
  // The key that minted this one over the API, or null for a key minted from
  // the dashboard (OPL-5261). Kept after that key is revoked.
  minted_by_key_id: z.string().nullable(),
});
// email and plan are null, and both names too, when the key is confined to a
// workspace: the platform does not tell a key that may be in an end customer's
// hands who the operator's people are, or what the account is on.
const whoami = z.object({
  user: z.object({ id: label, email: z.string().nullable(), name: z.string().nullable() }),
  account: z.object({
    id: label,
    name: z.string().nullable(),
    plan: z.string().nullable(),
    status: z.string(),
  }),
  role: label,
  workspace: z.object({ id: label, name: z.string(), created_at: z.string() }).nullable(),
  key: apiKey.nullable(),
});

// The account's workspaces and who reaches them (platform OPL-5057), and
// their create, rename and delete (OPL-5473), projected to the public fields.
const workspace = z.object({ id: label, name: z.string(), created_at: z.string() });
const workspaceMember = z.object({
  user_id: label,
  email: z.string(),
  name: z.string().nullable(),
  role: label,
  accepted_at: z.string(),
  suspended: z.boolean(),
});

// What a workspace delete answers: the ack, and how many keys went with it.
const workspaceDeleted = z.object({ ok: z.literal(true), revoked_keys: count });

const workspaceNameArg = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v.trim().length > 0, 'A workspace name cannot be blank.')
  .describe(
    'The name: 1 to 40 characters once trimmed, no control characters, unique within the account.',
  );

/** Said on each workspace write: who may make it, and why a scoped key may not. */
const OWNER_ACCOUNT_WIDE =
  "Needs an owner's key that is not confined to a workspace: a member, a viewer, or any key confined to a workspace is refused with 403 — relay that rather than retrying.";

const workspaceIdArg = z
  .string()
  .min(1)
  .describe("The workspace id (wsp-…), from list_workspaces or a computer's workspace_id.");

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
        'Who the API key this server runs with belongs to: the person (id, email, name), the account it acts on (id, name, plan, status: active or suspended), the role it acts with now (owner, member or viewer), the workspace it is confined to (null for the whole account), and the key itself (id, name, prefix, and manage_keys: whether it may manage API keys). For a key confined to a workspace the email, both names and the plan are null: the platform withholds them from a key that may be in the hands of an end customer. Needs no permission and any role; a suspended account can call it. No arguments.',
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
          `${data.user.email ?? data.user.id} as ${data.role} on ${data.account.name ?? data.account.id} (${data.account.status}), ${scope}.` +
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
        'The API keys of the person this server\'s key belongs to, on the account it acts on, newest first: id, name, prefix (display only), scope, when last used, manage_keys, and minted_by_key_id: the key that minted this one (null for a key minted from the dashboard); revoking a key does not revoke the keys it minted. Never a raw key. Needs this server\'s key to have the "Manage keys" permission, which only a person can turn on, in the dashboard; without it the answer is a 403 that says so — relay it rather than retrying. A key confined to a workspace sees only keys confined to that workspace. Minting and revoking keys are deliberately not tools here, so a raw key never lands in this transcript and a model never revokes one on its own reading of this list: a person does both in the dashboard or with the mandala CLI (mandala api-keys create / revoke).',
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
    'list_workspaces',
    {
      title: 'List workspaces',
      description:
        "The account's workspaces, oldest first: id, name and created_at. A workspace partitions the account's computers: a key confined to one reaches that workspace's computers only, and a computer's workspace_id names the one it is in. A key confined to a workspace lists only that one. create_workspace, rename_workspace and delete_workspace change them. No arguments.",
      inputSchema: z.object({}).strict(),
      annotations: readAnnotations,
    },
    (_args, extra) =>
      metadataCall(async () => {
        const data = metadata(
          z.array(workspace),
          await session.api.json('GET', P.WORKSPACES, { signal: extra.signal }),
        );
        return said(
          data.length
            ? `${data.length} workspace${data.length === 1 ? '' : 's'}, oldest first.`
            : 'No workspaces.',
          data,
        );
      }),
  );

  server.registerTool(
    'get_workspace',
    {
      title: 'Read a workspace',
      description:
        "One workspace: id, name and created_at. An id this key cannot see is not found, the same as one that does not exist — another account's, any workspace but its own for a key confined to one, and a deleted workspace a computer's workspace_id can still name.",
      inputSchema: z.object({ workspace_id: workspaceIdArg }).strict(),
      annotations: readAnnotations,
    },
    ({ workspace_id }, extra) =>
      metadataCall(async () => {
        const data = metadata(
          workspace,
          await session.api.json('GET', P.workspace(workspace_id), { signal: extra.signal }),
        );
        return said(`Workspace ${data.name} (${data.id}).`, data);
      }),
  );

  server.registerTool(
    'list_workspace_members',
    {
      title: "List a workspace's members",
      description:
        "The people who reach a workspace, oldest member first: user_id, email, name (null when unset), role, accepted_at and suspended. Workspaces do not divide people — everybody on the account reaches every workspace at their account role — so this is the account's accepted members; invitations not yet accepted are left out. A key confined to a workspace is refused with 403, because the list is the whole account's: relay that rather than retrying, and use an account-wide key.",
      inputSchema: z.object({ workspace_id: workspaceIdArg }).strict(),
      annotations: readAnnotations,
    },
    ({ workspace_id }, extra) =>
      metadataCall(async () => {
        const data = metadata(
          z.array(workspaceMember),
          await session.api.json('GET', P.workspaceMembers(workspace_id), {
            signal: extra.signal,
          }),
        );
        return said(
          data.length
            ? `${data.length} member${data.length === 1 ? '' : 's'} reach this workspace, oldest first.`
            : 'No members reach this workspace.',
          data,
        );
      }),
  );

  // metadataCall was built for reads, and rebuilds every APIError as a plain
  // one: a 503 would lose its UnavailableError class and its method, and with
  // them the "THIS CHANGE MAY OR MAY NOT HAVE HAPPENED" warning every other
  // mutation tool gives. A write's 503 is answered from the original error; any
  // other failure keeps metadataCall's handling.
  const writeCall = (work: () => Promise<CallToolResult>) =>
    metadataCall(async () => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof APIError && unavailableAdvice(error) !== undefined)
          return failed(error);
        throw error;
      }
    });

  // The workspace writes (OPL-5473). Create and rename are ordinary owner
  // writes. Delete is behind `confirm: true`, as delete_secret is, because it
  // REVOKES every key confined to the workspace — a person's CI or another
  // agent may be standing in it — and says so in its description. It can never
  // revoke the key this server runs with: a key confined to a workspace is
  // refused all three, and an account-wide key is confined to none.
  server.registerTool(
    'create_workspace',
    {
      title: 'Create a workspace',
      description: `Make a workspace on this account: a partition of its computers, which API keys can be confined to. Answers its id, name and created_at. A name the account already uses, a blank or over-long one, or an account already holding 500 workspaces is refused with 400. ${OWNER_ACCOUNT_WIDE} NOT safe to repeat blind: if the answer is lost, list_workspaces before creating again, since it may exist.`,
      inputSchema: z.object({ name: workspaceNameArg }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ name }, extra) =>
      writeCall(async () => {
        const data = metadata(
          workspace,
          await session.api.json('POST', P.WORKSPACES, { body: { name }, signal: extra.signal }),
        );
        return said(`Created workspace ${data.name} (${data.id}).`, data);
      }),
  );

  server.registerTool(
    'rename_workspace',
    {
      title: 'Rename a workspace',
      description: `Rename a workspace. Its id does not change, so the API keys confined to it and the computers in it are untouched. The name follows create_workspace's rules; a name the account already uses is refused with 400, and an id this key cannot see is not found. ${OWNER_ACCOUNT_WIDE}`,
      inputSchema: z.object({ workspace_id: workspaceIdArg, name: workspaceNameArg }).strict(),
      // Not destructiveHint: false: the old name is replaced, as update_computer's is.
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ workspace_id, name }, extra) =>
      writeCall(async () => {
        const data = metadata(
          workspace,
          await session.api.json('PATCH', P.workspace(workspace_id), {
            body: { name },
            signal: extra.signal,
          }),
        );
        return said(`Workspace ${data.id} is now named ${data.name}.`, data);
      }),
  );

  server.registerTool(
    'delete_workspace',
    {
      title: 'Delete a workspace',
      description: `Permanently delete a workspace. It REVOKES every API key confined to it, whoever holds it, in the same step: anything using one of those keys — a person's CI, another agent — is refused from its next request, and this cannot be undone. The answer says how many were revoked. The computers in it are NOT deleted, stopped or moved: they keep the deleted workspace's id, and account-wide keys reach them as before. Needs confirm: true. ${OWNER_ACCOUNT_WIDE}`,
      inputSchema: z
        .object({
          workspace_id: workspaceIdArg,
          confirm: z
            .literal(true)
            .describe('Must be true. Every API key confined to this workspace is revoked with it.'),
        })
        .strict(),
      annotations: deleteAnnotations,
    },
    ({ workspace_id }, extra) =>
      writeCall(async () => {
        const data = metadata(
          workspaceDeleted,
          await session.api.json('DELETE', P.workspace(workspace_id), { signal: extra.signal }),
        );
        const n = data.revoked_keys;
        return said(
          `Deleted workspace ${workspace_id}; ${n} API key${n === 1 ? '' : 's'} confined to it ${n === 1 ? 'was' : 'were'} revoked. Its computers are kept.`,
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
            // 521-523, 525 and 526 keep their class, so the shared refusal
            // gives the SDKs' wording rather than the body's.
            if (originWording(error) !== undefined) throw error;
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
