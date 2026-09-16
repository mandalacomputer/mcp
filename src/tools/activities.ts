import { z } from 'zod';
import { said } from '../format.js';
import * as P from '../paths.js';
import { count, executionId, exitCode, label, metadata, metadataCall } from './directory.js';
import { computerSchema, readAnnotations } from './results.js';
import type { Registrar } from './types.js';

const activityId = z.string().regex(/^act_[a-f0-9]{32}$/);
const identity = { computer_id: computerSchema, activity_id: activityId };
const record = z.object({
  activity_id: activityId,
  account_id: label,
  computer_id: label,
  workspace_id: label.nullable(),
  channel: label,
  route: label,
  action: label,
  state: z.enum(['pending', 'acknowledged', 'exited', 'accepted', 'refused', 'unknown']),
  received_at: label,
  observed_at: label,
  revision: count.min(1).optional(),
  has_results: z.boolean().optional(),
  dispatched_at: label.optional(),
  elapsed_ms: count.optional(),
  reason: label.optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  exit_code: exitCode.optional(),
  execution_id: executionId.optional(),
});
const health = z.object({
  recording_started_at: label,
  earliest_retained_at: label.nullable(),
  count_truncated: z.boolean(),
  age_truncated: z.boolean(),
  capture: z.enum(['available', 'degraded']),
  completeness: z.literal('best-effort'),
  gap_at: label.nullable(),
  recovered_at: label.nullable(),
});
const page = z.object({
  items: z.array(record),
  next_cursor: label.nullable(),
  changes_cursor: label,
  gap: z.boolean(),
  health,
});
const observation = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running') }),
  z.object({ status: z.literal('exited'), exit_code: exitCode }),
]);
const stream = (sync: boolean) =>
  z.object({
    bytes: count.max(4 * 1024 * 1024),
    retained_truncated: z.boolean(),
    upstream_truncated: sync ? z.boolean() : z.null(),
  });
const link = (
  kind: 'artifact' | 'background-output' | 'synchronous-output',
  association: string,
  fields: z.ZodRawShape,
) => {
  const base = {
    id: z.string().regex(kind === 'artifact' ? /^art_[a-f0-9]{32}$/ : /^res_[a-f0-9]{32}$/),
    kind: z.literal(kind),
    association: z.literal(association),
  };
  return z.discriminatedUnion('availability', [
    z.object({ ...base, availability: z.literal('unavailable') }),
    z.object({
      ...base,
      availability: z.literal('available'),
      captured_at: label,
      expires_at: label,
      ...fields,
    }),
  ]);
};
const resultLinks = z.object({
  activity_id: activityId,
  revision: count.min(1),
  more: z.boolean(),
  items: z
    .array(
      z.union([
        link('artifact', 'caller_selected_artifact', { bytes: count }),
        link('background-output', 'background_execution_output', {
          stdout: stream(false),
          stderr: stream(false),
          diagnostic: z.object({ bytes: count.max(65536), truncated: z.boolean() }),
          observation,
        }),
        link('synchronous-output', 'synchronous_exec_response', {
          stdout: stream(true),
          stderr: stream(true),
          diagnostic: z.null(),
          observation: z.object({ status: z.literal('exited'), exit_code: exitCode }),
        }),
      ]),
    )
    .max(8),
});
const historyNote =
  'Selected, retained, best-effort request history; not all guest work or an agent identity. Accepted background work is not completed execution; a dispatched error may have had effects. Activity IDs identify requests, never idempotency keys.';

export const registerActivities: Registrar = (server, session) => {
  server.registerTool(
    'list_activities',
    {
      title: 'Read one activity history page',
      description: `${historyNote} History is newest first with a fixed watermark. Changes include late final updates to older rows. No automatic paging. A gap requires refreshing history.`,
      inputSchema: {
        computer_id: computerSchema,
        cursor: z.string().min(1).max(2048).optional(),
        changes: z.boolean().optional(),
      },
      annotations: readAnnotations,
    },
    ({ computer_id, cursor, changes }, extra) =>
      metadataCall(async () => {
        if (changes && !cursor) throw new Error('changes=true requires a cursor.');
        const id = session.resolve(computer_id);
        const data = metadata(
          page,
          await session.api.json('GET', P.activities(id), {
            query: { cursor, ...(changes ? { changes: 1 } : {}) },
            signal: extra.signal,
          }),
        );
        if (data.items.some((item) => item.computer_id !== id))
          throw new Error('Activity history did not match the requested computer.');
        return said(
          `${data.gap ? 'GAP: discard the change cursor and refresh history. ' : ''}${historyNote}`,
          data,
        );
      }),
  );
  server.registerTool(
    'get_activity',
    {
      title: 'Read one activity record',
      description: historyNote,
      inputSchema: identity,
      annotations: readAnnotations,
    },
    ({ computer_id, activity_id }, extra) =>
      metadataCall(async () => {
        const id = session.resolve(computer_id);
        const data = metadata(
          record,
          await session.api.json('GET', P.activity(id, activity_id), { signal: extra.signal }),
        );
        if (data.activity_id !== activity_id || data.computer_id !== id)
          throw new Error('Activity response did not match the requested identity.');
        return said(historyNote, data);
      }),
  );
  server.registerTool(
    'get_activity_results',
    {
      title: 'Read passive result links for an activity',
      description:
        'Metadata only: at most eight newest links. more has no cursor and does not mean all versions were returned. No content reads, guest files, captures, execution polling or downloads. An unavailable link is not empty content. Caller-selected artifact association does not prove creation or command success.',
      inputSchema: identity,
      annotations: readAnnotations,
    },
    ({ computer_id, activity_id }, extra) =>
      metadataCall(async () => {
        const data = metadata(
          resultLinks,
          await session.api.json(
            'GET',
            P.activityResults(session.resolve(computer_id), activity_id),
            { signal: extra.signal },
          ),
        );
        if (data.activity_id !== activity_id)
          throw new Error('Result links did not match the requested activity.');
        return said(
          `${data.more ? 'More versions exist; this endpoint has no continuation cursor. ' : ''}Result links are metadata only. Availability and association do not establish command success.`,
          data,
        );
      }),
  );
};
