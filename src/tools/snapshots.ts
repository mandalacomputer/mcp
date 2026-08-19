import { z } from 'zod';
import {
  describe,
  guarded,
  incompleteWarning,
  json,
  refused,
  said,
  unwrapComputer,
  withoutCredentials,
} from '../format.js';
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
        include_unfinished: z
          .boolean()
          .default(false)
          .describe(
            'Also return deletions that began and did not finish. They are not usable — their state is "deleting" and nothing can be restored or cloned from one — but they still hold objects and are still billed, so this is the flag to set when the question is about storage rather than about what can be restored.',
          ),
        allow_partial: z
          .boolean()
          .optional()
          .describe(
            'Accept a short list when a hypervisor cannot be reached, instead of the 503 the platform answers by default. The answer then says it is short.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id, include_unfinished, allow_partial }, extra) =>
      guarded(async () => {
        // One route and a filter here, still, now that OPL-3636 has put
        // `GET computers/:id/snapshots` on this surface. That route is not a
        // narrower version of this one — it answers a count, a byte total and a
        // fingerprint, and never the snapshots themselves. Listing one
        // computer's snapshots is this route and a filter, and always was.
        // See snapshot_holdings for the other question.
        //
        // `listing` rather than `json`, and that matters more here than it looks.
        // Without allow_partial the platform answers a short inventory with a
        // 503, so the filter below can never quietly narrow one — but with it,
        // a short list arrives as a 200 and the only thing saying so is
        // X-GC-Incomplete. Filtering that to one computer and reporting the
        // count would turn "some hosts did not answer" into a confident wrong
        // number about a single machine.
        const { items, incomplete } = await session.api
          .with(extra.signal)
          .listing<Record<string, unknown>[]>(P.SNAPSHOTS, {
            query: {
              include: include_unfinished ? 'unfinished' : undefined,
              allow_partial: allow_partial ? 1 : undefined,
            },
          });
        // The same check list_computers makes, for the same reason and one
        // consequence milder: an object body sends `.filter` below into a
        // TypeError, and an absent one — a 204, or a gateway answering 200 with
        // nothing — becomes a confident "0 snapshot(s)" about a machine whose
        // inventory never arrived.
        if (!Array.isArray(items)) {
          const got =
            items === undefined ? 'no body at all' : items === null ? 'null' : typeof items;
          return refused(
            `GET /snapshots answered with ${got}, not a list of snapshots. This is not an empty list — do not conclude anything about what exists from it.`,
            items,
          );
        }
        const all = items;
        const warning = incompleteWarning('snapshots', incomplete);
        // The filter keeps the unreachable placeholders, and that is not a
        // nicety. A partial listing does not merely omit rows — the platform
        // APPENDS one `{id, unreachable: true}` stub per snapshot it could not
        // reach, and publicSnapshot drops `computer_id` from such a row because
        // there is no daemon to have said what it belongs to. Filtering on
        // equality therefore deletes precisely the markers that say something
        // is missing, and then reports a count: the confident wrong number
        // about one machine that the comment above says this guards against.
        //
        // They cannot be attributed to a computer, so keeping them over-reports
        // for this one. That is the trade the platform itself makes and writes
        // down in lib/hostroute: an extra unreachable row is visible and is
        // corrected by the next complete answer, while a withheld one makes a
        // row vanish mid-outage, which is the failure worth preventing.
        const rows = computer_id
          ? all.filter((s) => s.computer_id === computer_id || s.unreachable)
          : all;
        const stubs = rows.filter((s) => s.unreachable).length;
        const note = stubs
          ? ` ${stubs} of these could not be read and are listed by id alone; they may or may not belong to this computer.`
          : '';
        return said(`${warning}${rows.length} snapshot(s).${note}`, rows);
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
    ({ computer_id }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const held = await session.api.with(extra.signal).json<{
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
    ({ computer_id, memory }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api
          .with(extra.signal)
          .json('POST', P.computerAction(id, 'snapshots'), {
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
    ({ snapshot_id }, extra) =>
      guarded(async () => {
        // An acknowledgement, which /api/v1 is free to send as a 204 — and
        // `said` already omits the body when there is none to repeat.
        const res = await session.api
          .with(extra.signal)
          .send('POST', P.snapshotAction(snapshot_id, 'restore'));
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
    ({ snapshot_id, name, select }, extra) =>
      guarded(async () => {
        const c = unwrapComputer(
          await session.api
            .with(extra.signal)
            .json('POST', P.snapshotAction(snapshot_id, 'clone'), {
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
    ({ computer_id, set, clear }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const path = P.computerAction(id, 'schedule');
        // Acting on half a contradictory request is worse than refusing it: the
        // schedule the caller sent would be dropped without mention, and the
        // answer would say "Schedule cleared" — true, and not what was asked
        // for. The platform makes the same call one tier down, refusing a
        // rename and a resize in one request rather than picking one.
        if (set && clear) {
          return refused(
            'Send `set` or `clear`, not both — they ask for opposite things and nothing was changed.',
          );
        }
        if (clear)
          return said(
            'Schedule cleared.',
            await session.api.with(extra.signal).send('DELETE', path),
          );
        if (set) {
          return said(
            `Snapshot scheduled for ${String(set.hour).padStart(2, '0')}:${String(set.minute).padStart(2, '0')} ${set.tz}.`,
            await session.api.with(extra.signal).send('PUT', path, { body: P.scheduleBody(set) }),
          );
        }
        return json(await session.api.with(extra.signal).json('GET', path));
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
    ({ snapshot_id }, extra) =>
      guarded(async () => {
        await session.api.with(extra.signal).send('DELETE', P.snapshot(snapshot_id));
        return said(`Deleted snapshot ${snapshot_id}.`);
      }),
  );
};
