import { z } from 'zod';
import { said } from '../format.js';
import * as P from '../paths.js';
import { count, executionId, exitCode, label, metadata, metadataCall } from './directory.js';
import { computerSchema, readAnnotations } from './results.js';
import type { Registrar } from './types.js';

const position = {
  seq: count,
  cursor: label,
  at: label,
  computer: label,
  source: z.literal('daemon'),
};
const status = z.enum([
  'running',
  'stopped',
  'suspended',
  'building',
  'build-failed',
  'half-removed',
]);
const processData = z.union([
  z.object({
    pid: count.min(1).max(2147483647),
    execution_id: executionId.optional(),
    exit_code: exitCode,
    lost: z.never().optional(),
  }),
  z.object({
    pid: count.min(1).max(2147483647),
    execution_id: executionId.optional(),
    lost: z.literal(true),
    exit_code: z.never().optional(),
  }),
]);
const event = z.discriminatedUnion('type', [
  z.object({ ...position, type: z.literal('process.exited'), data: processData }),
  z.object({
    ...position,
    type: z.literal('computer.started'),
    data: z.object({ status: z.literal('running'), previous: status.optional() }),
  }),
  z.object({
    ...position,
    type: z.literal('computer.stopped'),
    data: z.object({ status: z.literal('stopped'), previous: status.optional() }),
  }),
  z.object({
    ...position,
    type: z.literal('computer.suspended'),
    data: z.object({ status: z.literal('suspended'), previous: status.optional() }),
  }),
  z.object({
    ...position,
    type: z.literal('computer.idle'),
    data: z.object({ idle_seconds: count }),
  }),
]);
const page = z.object({
  computer: label,
  from: z.string(),
  cursor: label,
  events: z.array(event).max(100),
  more: z.boolean(),
  baseline: z.boolean(),
  gap: z
    .object({
      cursor: label,
      at: label,
      type: z.literal('gap'),
      computer: label,
      source: z.literal('daemon'),
      data: z.object({ oldest_cursor: label.optional(), detail: label }),
    })
    .optional(),
  supported: z.array(label),
  retention: z.literal('ephemeral'),
});
export const registerSignals: Registrar = (server, session) => {
  server.registerTool(
    'read_signals',
    {
      title: 'Read one passive platform signal page',
      description:
        'Read finite daemon facts without waking the computer, guest contact, event socket, watcher, capture or polling loop. Omit since or send empty for a head-only baseline with no replay; neither a baseline nor gap proves no earlier activity or task success. Keep the returned cursor even on an empty page: filtered-out rows can advance it. Retention is ephemeral, and resets are explicit gaps.',
      inputSchema: {
        computer_id: computerSchema,
        since: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: readAnnotations,
    },
    ({ computer_id, since, limit }, extra) =>
      metadataCall(async () => {
        const id = session.resolve(computer_id);
        const data = metadata(
          page,
          await session.api.json('GET', P.signals(id), {
            query: { since, limit },
            signal: extra.signal,
          }),
        );
        // Compare opaque checkpoints without parsing or deriving a next cursor.
        // Baselines and explicit resets describe one head; replay starts at since.
        if (
          data.computer !== id ||
          data.events.some((e) => e.computer !== id) ||
          data.baseline !== (since === undefined || since === '') ||
          (data.baseline && data.gap) ||
          (data.gap && (data.gap.computer !== id || data.gap.cursor !== data.cursor)) ||
          ((data.baseline || data.gap) &&
            (data.events.length || data.more || data.from !== data.cursor)) ||
          (!data.baseline && !data.gap && data.from !== since) ||
          (data.more && !data.events.length) ||
          data.events.length > (limit ?? 50)
        )
          throw new Error('Inconsistent signal page; no checkpoint was established.');
        return said(
          `${data.gap ? 'GAP: the checkpoint was reset. ' : ''}${data.baseline ? 'Head-only baseline; no historical replay. ' : ''}One ephemeral page; use the returned cursor, including after an empty page. These facts do not establish task success.`,
          data,
        );
      }),
  );
};
