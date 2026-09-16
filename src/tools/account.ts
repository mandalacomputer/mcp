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

export const registerAccount: Registrar = (server, session) => {
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
