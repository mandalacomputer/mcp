import { z } from 'zod';
import { NotFoundError } from '../errors.js';
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

/**
 * The sentence in front of a retention window, for the reason every tool here
 * leads with one: the model reads the text, and three integers in a JSON blob
 * do not say what they select.
 *
 * Says what SURVIVES rather than restating the numbers. A tier at zero is left
 * out entirely rather than printed as "0 monthly", which reads like a promise
 * about monthlies; and an all-zero window — what an account with no active
 * subscription reads — is stated as the plan granting no retained history,
 * without claiming anything about what happens to snapshots already taken. The
 * platform's own reference stops in the same place and for the same reason.
 */
const retentionLine = (r: unknown): string => {
  const v = (r ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  const parts = [
    n(v.daily) && `${n(v.daily)} daily`,
    n(v.weekly) && `${n(v.weekly)} weekly`,
    n(v.monthly) && `${n(v.monthly)} monthly`,
  ].filter(Boolean);
  if (!parts.length) {
    return 'This plan grants no retained automatic history. Snapshots you take by hand are unaffected — they are never removed automatically.';
  }
  return (
    `Automatic snapshots are kept: ${parts.join(', ')}. ` +
    'That is the newest automatic snapshot in each of the last N periods THAT HAVE ONE — periods ' +
    'containing a capture, not periods on the calendar, cut in UTC. Snapshots you take by hand are ' +
    'never aged out.'
  );
};

export const registerSnapshots: Registrar = (server, session, opts) => {
  // The lifecycle tools these descriptions point at, named only where they are
  // registered. Under MANDALA_NO_LIFECYCLE, delete_computer, clone_snapshot and
  // delete_snapshot are withheld — and a name in a surviving tool's description
  // is the same idea by a different route as a name in the tool list: the model
  // reads it and tries it. The server instructions were already parameterised on
  // this; these were not.
  const purgeWith = opts.lifecycle
    ? 'Read this before purging snapshots with delete_computer: the fingerprint is what binds the purge to the snapshots you were shown, so one that arrived after you looked cannot be swept up in it.'
    : 'The fingerprint binds a purge to the snapshots you were shown, so one that arrived after you looked cannot be swept up in it. This server cannot purge them — it was started with the lifecycle tools withheld — so the count and the size are all this answers.';
  server.registerTool(
    'list_snapshots',
    {
      title: 'List snapshots',
      description:
        'Every snapshot on this account. `orphaned` means its computer is gone: such a snapshot can still be cloned into a new computer, but cannot be restored, because a restore puts the disk back on a source that no longer exists. Read `state` before acting on a row: a capture still being taken is listed FIRST and is not a snapshot yet — it reads `capturing` and its id begins `cap-`, and restore, clone and delete all fail on one. `pending` is the point at which it can be acted on, and `durable` means it has reached backup storage as well.',
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
        const malformed = items.filter(
          (item) => item === null || typeof item !== 'object' || Array.isArray(item),
        ).length;
        const all = items.filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === 'object' && !Array.isArray(item),
        );
        const warning =
          incompleteWarning('snapshots', incomplete) +
          (malformed
            ? `WARNING: ignored ${malformed} malformed snapshot entr${malformed === 1 ? 'y' : 'ies'} from the platform.\n\n`
            : '');
        if (!all.length && malformed) {
          return refused(
            `${warning}No valid snapshots remained. This is not an empty snapshot inventory — do not draw conclusions from the malformed listing.`,
            items,
          );
        }
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
        // A filter that was GIVEN and trims to nothing is refused, not dropped.
        // `"   "` used to fall through to the unfiltered list, so a caller who
        // asked about one computer was handed the whole account's inventory
        // with nothing saying the filter had been ignored — the one shape of
        // wrong answer a listing must not produce. Every other id path treats
        // whitespace as absent and then REFUSES; this is that rule, here.
        const filterId = computer_id?.trim();
        if (computer_id !== undefined && !filterId) {
          return refused(
            'computer_id was given but is blank, and a blank filter would have listed every snapshot on ' +
              'the account as though it belonged to one computer. Pass a real computer_id, or omit it ' +
              'entirely to ask for the whole account.',
          );
        }
        const rows = filterId
          ? all.filter((s) => s.computer_id === filterId || s.unreachable)
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
      description: `How many snapshots a computer has, what they weigh, and the fingerprint that names that exact set. ${purgeWith}`,
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
        const count =
          typeof held.count === 'number' ? `${held.count} snapshot(s)` : 'an unknown count';
        const size =
          typeof held.size_bytes === 'number'
            ? `${(held.size_bytes / 1e9).toFixed(2)} GB`
            : 'an unknown total size';
        const next = !opts.lifecycle
          ? 'This server cannot purge them — it was started with the lifecycle tools withheld.'
          : held.fingerprint
            ? 'To delete them along with the computer, pass this fingerprint to delete_computer as `expect`.'
            : 'The platform did not provide a fingerprint, so they cannot be safely purged with delete_computer; retry snapshot_holdings.';
        return said(`${id} holds ${count}, ${size}. ${next}`, held);
      }),
  );

  server.registerTool(
    'create_snapshot',
    {
      title: 'Snapshot a computer',
      description:
        'Capture a computer so it can be restored or forked later. A disk snapshot is the filesystem; a memory snapshot also saves the running session, so a fork of it comes up with the same processes and windows already open. Name it after the step it is about — that name is what picks it out of the list later.',
      inputSchema: {
        ...idArg,
        name: z
          .string()
          .optional()
          .describe(
            // Two sentences rather than a name substituted into one. The
            // three-tool list carries "all take an id" and "the last of
            // those" — grammar and a referent that both break when the list
            // is one item, and the unrecoverable-wrong-guess warning is about
            // delete_snapshot, which is not registered here to warn about
            // (/code-review, OPL-4244).
            opts.lifecycle
              ? 'What this capture is of: "before the upgrade", "clean install", "reproduces the bug". It is the only place the reason for taking it can be written down — restore_snapshot, clone_snapshot and delete_snapshot all take an id, so a set of captures of one computer is otherwise told apart by timestamp alone, and the wrong guess on the last of those is unrecoverable. Omit it and the platform names the snapshot after the computer and the time, which says when but never why.'
              : 'What this capture is of: "before the upgrade", "clean install", "reproduces the bug". It is the only place the reason for taking it can be written down — restore_snapshot takes an id and nothing else, so a set of captures of one computer is otherwise told apart by timestamp alone, and restoring the wrong one overwrites a disk. Omit it and the platform names the snapshot after the computer and the time, which says when but never why.',
          ),
        memory: z
          .boolean()
          .default(false)
          .describe(
            'Include the running session. A memory snapshot is a saved machine, so it only loads back into the shape it came off: resize the computer afterwards and the restore is refused, because the vCPU count and the memory size are part of the state rather than decoration around it. Clone it instead in that case, which restores the disk and boots fresh.',
          ),
      },
    },
    ({ computer_id, name, memory }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api
          .with(extra.signal)
          .json<Record<string, unknown>>('POST', P.computerAction(id, 'snapshots'), {
            body: P.snapshotBody({ memory, name }),
          });
        // The name read back rather than the one sent, because the interesting
        // case is the one that was not sent: the platform generates
        // "<computer> <timestamp>" when `name` is absent, and that generated
        // name is what a later list_snapshots will show. Saying it here is the
        // difference between a caller that can find this capture again and one
        // that has to go looking for it.
        const called = typeof res?.name === 'string' && res.name.trim() ? ` as "${res.name}"` : '';
        return said(`Snapshotted ${id}${memory ? ' with its memory' : ''}${called}.`, res);
      }),
  );

  server.registerTool(
    'restore_snapshot',
    {
      title: 'Restore a snapshot',
      description: `Put a snapshot back onto the computer it came from, discarding everything on that disk since. Refused on an orphaned snapshot${opts.lifecycle ? ' — clone_snapshot is what works there' : ', and this server cannot fork one either: it was started with the lifecycle tools withheld'}. It leaves the computer RUNNING whatever state it was in: restoring a stopped one boots it, which is a start like any other and is charged. A disk snapshot comes back to a fresh boot, a memory one to the captured session, and either way a suspended session the computer was holding is discarded with the disk it was saved against.`,
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
    'snapshot_schedule',
    {
      title: 'Read or set the nightly snapshot',
      description:
        'When the platform takes this computer\'s automatic snapshot. Reading takes no arguments; setting takes an hour. There is deliberately no "last run" here — snapshots carry real capture times, and that is what a freshness check should read. This says when they are TAKEN and not how long they survive: `get_retention` is the other half, and it is what tells you whether the snapshots this schedule takes will still be there next month.',
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

  server.registerTool(
    'get_retention',
    {
      title: 'Read how long automatic snapshots are kept',
      description:
        "The plan's retention window — the other half of `snapshot_schedule`, which says when snapshots are taken and deliberately has no field for how long they survive. Read it before promising anyone that a backup will still be there, and before taking a snapshot you mean to keep. Takes no arguments: the window belongs to the ACCOUNT, not to a computer, though each computer keeps its own set under it. ONLY AUTOMATIC SNAPSHOTS ARE AGED OUT — one you took yourself with `create_snapshot` is never removed automatically, which is how you keep something past the window.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    (_args, extra) =>
      guarded(async () => {
        const body = await session.api.with(extra.signal).json('GET', P.RETENTION);
        return said(retentionLine(body), body);
      }),
  );

  // clone_snapshot brings a billable machine into existence as surely as
  // create_computer does, and delete_snapshot destroys bytes as surely as
  // delete_computer does, so both sit behind the gate those two sit behind.
  //
  // clone_snapshot was on the wrong side of it, which left MANDALA_NO_LIFECYCLE
  // withholding every way of making a computer except this one — an operator
  // who had turned creation off still had a tool that made computers, and the
  // first they would learn of it is an invoice.
  if (!opts.lifecycle) return;

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
        if (!c.id) {
          return refused(
            `The platform accepted the clone of ${snapshot_id} but sent no computer id back, so the copy cannot be identified. It may exist and be billable — list_computers will say. The selected computer is unchanged.`,
            withoutCredentials(c),
          );
        }
        if (select && c.id) session.bind(c.id, c.resolution);
        return said(
          `Forked ${snapshot_id} into ${describe(c)}${select && c.id ? ', and selected it' : ''}.`,
          withoutCredentials(c),
        );
      }),
  );

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
        try {
          await session.api.with(extra.signal).send('DELETE', P.snapshot(snapshot_id));
        } catch (err) {
          // A 404 means the snapshot is not there, which is the state this call
          // was asking for. `idempotentHint` above invites a client to retry a
          // lost 2xx, and `#fetch` throws on every non-OK — so that invited
          // retry came back `isError` saying the delete had FAILED, about bytes
          // the first attempt had already destroyed. delete_computer carries the
          // same hint and special-cases 404 for exactly this reason; this is
          // that handler, one route over.
          if (!(err instanceof NotFoundError)) throw err;
          // Not reported as "Deleted", for delete_computer's reason: a 404 is
          // equally the answer for an id that was never on this account, and
          // "deleted" said over a typo leaves a caller believing a snapshot is
          // gone while the real one is still held and still billed. Both
          // readings are named, and the one call that settles which is named
          // with them.
          return said(
            `Nothing was deleted: the platform has no snapshot with the id ${snapshot_id} on this account. ` +
              'Either it was already destroyed — if this is a retry, the first call is the one that did it — ' +
              'or the id is not one on this account, in which case NO snapshot of yours has been touched and ' +
              'a real one may still be held under the id you meant. list_snapshots says which of the two ' +
              'this is.',
          );
        }
        return said(`Deleted snapshot ${snapshot_id}.`);
      }),
  );
};
