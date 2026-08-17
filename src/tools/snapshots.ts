import { z } from 'zod';
import { describe, guarded, json, said, unwrapComputer, withoutCredentials } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

export const registerSnapshots: Registrar = (server, session, opts) => {
  server.registerTool(
    'list_snapshots',
    {
      title: 'List snapshots',
      description:
        'Every snapshot on this account. `orphaned` means its computer is gone: such a snapshot can still be cloned into a new computer, but cannot be restored, because a restore puts the disk back on a source that no longer exists.',
      inputSchema: {
        computer_id: z
          .string()
          .optional()
          .describe('Only snapshots of this computer. Omit for the whole account.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id }) =>
      guarded(async () => {
        // One route and a filter here, still, now that OPL-3636 has put
        // `GET computers/:id/snapshots` on this surface. That route is not a
        // narrower version of this one — it answers a count, a byte total and a
        // fingerprint, and never the snapshots themselves. Listing one
        // computer's snapshots is this route and a filter, and always was.
        // See snapshot_holdings for the other question.
        const all = (await session.api.json<Record<string, unknown>[]>('GET', P.SNAPSHOTS)) ?? [];
        if (!computer_id) return json(all);
        return json(all.filter((s) => s.computer_id === computer_id));
      }),
  );

  server.registerTool(
    'snapshot_holdings',
    {
      title: 'What a computer would leave behind',
      description:
        'How many snapshots a computer has, what they weigh, and the fingerprint that names that exact set. Read this before purging snapshots with delete_computer: the fingerprint is what binds the purge to the snapshots you were shown, so one that arrived after you looked cannot be swept up in it.',
      inputSchema: { ...idArg },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const held = await session.api.json<{
          count?: number;
          size_bytes?: number;
          fingerprint?: string;
        }>('GET', P.computerAction(id, 'snapshots'));
        const size = ((held.size_bytes ?? 0) / 1e9).toFixed(2);
        return said(
          `${id} holds ${held.count ?? 0} snapshot(s), ${size} GB. ` +
            'To delete them along with the computer, pass this fingerprint to delete_computer as `expect`.',
          held,
        );
      }),
  );

  server.registerTool(
    'create_snapshot',
    {
      title: 'Snapshot a computer',
      description:
        'Capture a computer so it can be restored or forked later. A disk snapshot is the filesystem; a memory snapshot also saves the running session, so a fork of it comes up with the same processes and windows already open.',
      inputSchema: {
        ...idArg,
        memory: z
          .boolean()
          .default(false)
          .describe(
            "Include the running session. A memory snapshot records the screen resolution and the host's machine type, so it will only load onto a matching one.",
          ),
      },
    },
    ({ computer_id, memory }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api.json('POST', P.computerAction(id, 'snapshots'), {
          body: P.snapshotBody(memory),
        });
        return said(`Snapshotted ${id}${memory ? ' with its memory' : ''}.`, res);
      }),
  );

  server.registerTool(
    'restore_snapshot',
    {
      title: 'Restore a snapshot',
      description:
        'Put a snapshot back onto the computer it came from, discarding everything on that disk since. Refused on an orphaned snapshot — clone_snapshot is what works there.',
      inputSchema: {
        snapshot_id: z.string(),
        confirm: z
          .literal(true)
          .describe("Must be true. This overwrites the source computer's current disk."),
      },
      annotations: { destructiveHint: true },
    },
    ({ snapshot_id }) =>
      guarded(async () => {
        const res = await session.api.json('POST', P.snapshotAction(snapshot_id, 'restore'));
        return said(`Restored ${snapshot_id}.`, res);
      }),
  );

  server.registerTool(
    'clone_snapshot',
    {
      title: 'Fork a snapshot into a new computer',
      description:
        'Build a new computer from a snapshot, leaving the original untouched. This is the fork half of snapshot-and-fork, and the only thing that works on an orphaned snapshot.',
      inputSchema: {
        snapshot_id: z.string(),
        name: z.string().optional().describe('A name for the new computer.'),
        select: z
          .boolean()
          .default(true)
          .describe("Make the new computer this session's selected one."),
      },
    },
    ({ snapshot_id, name, select }) =>
      guarded(async () => {
        const c = unwrapComputer(
          await session.api.json('POST', P.snapshotAction(snapshot_id, 'clone'), {
            body: name === undefined ? {} : { name },
          }),
        );
        if (select && c.id) session.bind(c.id, c.resolution);
        return said(
          `Forked ${snapshot_id} into ${describe(c)}${select && c.id ? ', and selected it' : ''}.`,
          withoutCredentials(c),
        );
      }),
  );

  server.registerTool(
    'snapshot_schedule',
    {
      title: 'Read or set the nightly snapshot',
      description:
        'When the platform takes this computer\'s automatic snapshot. Reading takes no arguments; setting takes an hour. There is deliberately no "last run" here — snapshots carry real capture times, and that is what a freshness check should read.',
      inputSchema: {
        ...idArg,
        set: z
          .object({
            enabled: z.boolean(),
            hour: z.number().int().min(0).max(23),
            minute: z.number().int().min(0).max(59).default(0),
            tz: z.string().default('UTC').describe('An IANA zone, e.g. "America/New_York".'),
          })
          .optional()
          .describe('Omit to read the current schedule. Include to replace it.'),
        clear: z.boolean().default(false).describe('Remove the schedule entirely.'),
      },
    },
    ({ computer_id, set, clear }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const path = P.computerAction(id, 'schedule');
        if (clear) return said('Schedule cleared.', await session.api.json('DELETE', path));
        if (set) {
          return said(
            `Snapshot scheduled for ${String(set.hour).padStart(2, '0')}:${String(set.minute).padStart(2, '0')} ${set.tz}.`,
            await session.api.json('PUT', path, { body: P.scheduleBody(set) }),
          );
        }
        return json(await session.api.json('GET', path));
      }),
  );

  // Deleting bytes somebody may be relying on is the same kind of act as
  // deleting a computer, so it sits behind the same gate.
  if (!opts.lifecycle) return;

  server.registerTool(
    'delete_snapshot',
    {
      title: 'Delete a snapshot',
      description:
        'Remove a snapshot permanently. Later snapshots in the same chain are unaffected.',
      inputSchema: {
        snapshot_id: z.string(),
        confirm: z.literal(true).describe('Must be true.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ snapshot_id }) =>
      guarded(async () => {
        await session.api.json('DELETE', P.snapshot(snapshot_id));
        return said(`Deleted snapshot ${snapshot_id}.`);
      }),
  );
};
