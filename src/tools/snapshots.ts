import { z } from 'zod';
import type { Api } from '../api.js';
import { CancelledError, ConflictError, isTransientForPoll, NotFoundError } from '../errors.js';
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
import { heartbeat, POLL_MS, pollDelay, sleep } from '../poll.js';
import type { Registrar } from './types.js';

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

/** One row of `GET /snapshots`, before anything has been read off it. */
type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The state a capture that has not finished is in, and the ONLY one the poll
 * below waits out.
 *
 * Waiting for `pending` specifically is the bug the platform's own reference
 * warns about: `pending` is where a finished capture lands, but replication can
 * carry it on to `durable` between two polls, so a loop matching the literal
 * string can watch a small snapshot go past and never match. Every state that
 * is not this one is a state the snapshot can be restored, cloned and deleted
 * from.
 */
const CAPTURING = 'capturing';

/**
 * The states a capture is OVER in, and the reason this is a list of names
 * rather than "anything but {@link CAPTURING}".
 *
 * It is read in one place: the check on the acceptance body, which asks "is
 * there something to wait for". An answer nobody can classify has to mean YES
 * there — a 202 whose `state` arrives misspelt, renamed, or under another key
 * would otherwise read as a snapshot that had landed, and what came back would
 * be the placeholder: `size_bytes: 0` and an id restore, clone and delete all
 * 404 on, reported as a snapshot that can be acted on. That is the defect
 * OPL-4568 removed, reached through a typo instead of an omission and
 * reinstated by drift this server cannot see. An ABSENT state was already
 * handled; `"capturin"` is every bit as unreadable and was not.
 *
 * The POLL LOOP reads the opposite way round and is right to — a row it cannot
 * classify is not a claim, so it asks again rather than deciding, where the
 * alternative is a wait that ends on a state nobody could read. Both directions
 * are the safe one for where they sit, and they are safe in opposite
 * directions.
 *
 * The three names `web/the platform's reference` documents beside `capturing`. `deleting` is
 * among them because a row in it is a row the capture is over for, whatever
 * else is true of it. A platform that invents a fourth costs one listing: the
 * poll finds the row already there, carrying whatever state it really has, and
 * returns it at once. So this list going stale costs a round trip, and the
 * other spelling costs the bug.
 *
 * The TypeScript SDK settled here first, under `acceptedCapture` (OPL-4568,
 * `33c47b3`).
 */
const LANDED = ['pending', 'durable', 'deleting'];

/**
 * The state the platform marks a snapshot with once a deletion has detached its
 * dependents and is removing the stored objects.
 *
 * Left out of a bare listing, because a half-deleted snapshot is not one you can
 * restore or clone — so a poll that wants to SEE one has to ask for
 * `include=unfinished`. There is no state that means deleted: the row going is
 * the deletion having finished, and a row that stays in this state is one that
 * stalled.
 */
const DELETING = 'deleting';

/**
 * What one turn of a snapshot poll established about one id.
 *
 * The two waits in this file ask opposite questions of the same listing — a
 * capture waits for its row to stop reading `capturing`, a deletion waits for
 * its row to GO — and everything between the request and that question is the
 * same: the deadline, the cancellation, the failure worth riding out, the body
 * that is not a list, the listing the platform had to answer short.
 *
 * One reader for that, rather than a second copy of it (OPL-4577). The copy is
 * the part that would drift, and it is the part where drift is dangerous: both
 * waits READ ABSENCE, and they read it as opposite outcomes — a capture that
 * failed, a deletion that finished. A guard that stopped `blocked` from being
 * mistaken for `absent` in one loop and not the other would report someone's
 * snapshot deleted because a hypervisor was slow.
 *
 * `blocked` is therefore the answer to everything that did not establish
 * something, and the two loops are left with only their own question and their
 * own sentences.
 */
type Turn =
  /** A row for this id, read whole, off a listing that was complete. */
  | { kind: 'row'; row: Row }
  /** A complete, well-formed listing that did not carry this id. */
  | { kind: 'absent' }
  /** Nothing was established this turn. Ask again. */
  | { kind: 'blocked'; why: string; after?: number }
  /** The request was cancelled — by the caller, by the deadline, or by the transport. */
  | { kind: 'cancelled'; why: string }
  /** A failure that will not clear by asking again. */
  | { kind: 'broken'; why: string };

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One listing, and what it says about `sid`.
 *
 * Asked WITHOUT `allow_partial`, deliberately: the platform then answers a short
 * inventory with a 503, which arrives here as a failure to ride out rather than
 * as a 200 whose missing rows could be read as an answer. The `incomplete`
 * check below is the second line of that defence, for a deployment that sends
 * the header anyway.
 */
const snapshotTurn = async (api: Api, sid: string, unfinished: boolean): Promise<Turn> => {
  let items: unknown;
  let incomplete: number | null = null;
  try {
    ({ items, incomplete } = await api.listing<unknown>(P.SNAPSHOTS, {
      query: { include: unfinished ? 'unfinished' : undefined },
    }));
  } catch (err) {
    if (err instanceof CancelledError) return { kind: 'cancelled', why: why(err) };
    if (!isTransientForPoll(err)) return { kind: 'broken', why: why(err) };
    return { kind: 'blocked', why: why(err), after: pollDelay(err) };
  }
  if (!Array.isArray(items)) {
    const got = items === undefined ? 'no body at all' : items === null ? 'null' : typeof items;
    return { kind: 'blocked', why: `GET /snapshots answered with ${got}, not a list of snapshots` };
  }
  if (incomplete !== null) {
    return {
      kind: 'blocked',
      why: 'GET /snapshots answered short — a hypervisor did not report, so a row missing from it establishes nothing',
    };
  }
  const row = items.find((r) => isRow(r) && r.id === sid);
  if (!isRow(row)) {
    // An unreadable identity could be the target. Only a list whose rows can
    // all be identified establishes absence; a readable target still wins.
    if (items.some((r) => !isRow(r) || typeof r.id !== 'string' || !r.id.trim())) {
      return {
        kind: 'blocked',
        why: 'GET /snapshots contained rows without readable ids, so a missing snapshot establishes nothing',
      };
    }
    return { kind: 'absent' };
  }
  // A row served from the host cache because its host did not answer. It
  // carries an id and nothing else — its `state` is last-known or absent — so it
  // can confirm neither what a capture is doing nor that a deletion has not
  // finished.
  if (row.unreachable) {
    return {
      kind: 'blocked',
      why: `the hypervisor holding ${sid} did not answer, so its row could not be read`,
    };
  }
  return { kind: 'row', row };
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
        'Every snapshot on this account. `orphaned` means its computer is gone: such a snapshot can still be cloned into a new computer, but cannot be restored, because a restore puts the disk back on a source that no longer exists. Read `state` ON EVERY ROW before acting, rather than on the newest one — this is one answer per hypervisor concatenated in a fixed host order that has nothing to do with time, so a capture running on one host routinely appears after finished snapshots from another. A row reading `capturing` is not a snapshot yet: the copy is still being taken and restore, clone and delete all fail on it. It carries the id the finished snapshot will keep, so this is also the route to poll after create_snapshot: the row stops reading `capturing` in place rather than being replaced under another id, and a row that vanishes without ever leaving `capturing` is a capture that failed. `pending` is the point at which it can be acted on, and `durable` means it has reached backup storage as well.',
      inputSchema: {
        computer_id: z
          .string()
          .optional()
          .describe('Only snapshots of this computer. Omit for the whole account.'),
        include_unfinished: z
          .boolean()
          .default(false)
          .describe(
            'Also return deletions that began and did not finish. They are not usable — their state is "deleting" and nothing can be restored or cloned from one — but they still hold objects and are still billed, so this is the flag to set when the question is about storage rather than about what can be restored. It is also the flag to set when following a deletion: without it a snapshot stuck half-deleted is hidden, and a poll watching for the row to go cannot tell that from one that finished.',
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
        // reach, and the platform drops `computer_id` from such a row because
        // there is no daemon to have said what it belongs to. Filtering on
        // equality therefore deletes precisely the markers that say something
        // is missing, and then reports a count: the confident wrong number
        // about one machine that the comment above says this guards against.
        //
        // They cannot be attributed to a computer, so keeping them over-reports
        // for this one. That is the trade the platform itself makes and writes
        // down in the platform's host routing: an extra unreachable row is visible and is
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
        'Capture a computer so it can be restored or forked later. A disk snapshot is the filesystem; a memory snapshot also saves the running session, so a fork of it comes up with the same processes and windows already open. Name it after the step it is about — that name is what picks it out of the list later. THE CAPTURE OUTLIVES THE REQUEST that starts it: the platform accepts it and copies the disk afterwards, which takes minutes and scales with how much has been written. This waits for the copy to land by default and answers with the finished snapshot; pass wait: false to get the id straight back and poll list_snapshots yourself. Everything that can refuse a capture — no such computer, one already running, a memory snapshot of a computer that is not running, an allowance that will not stretch — is refused by this call, so anything else is a capture that started. A wait reports progress while it runs, so a client that sends a progressToken and sets resetTimeoutOnProgress can hold the request open; a client that cannot should pass wait: false and poll list_snapshots, rather than watch its own default timeout cancel a call while the capture goes on running.',
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
        wait: z
          .boolean()
          .default(true)
          .describe(
            'Wait for the copy to finish, and answer with the snapshot rather than with the placeholder. Set it false to get the id back at once — useful when the capture is a side errand and there is other work to do meanwhile — and then poll list_snapshots for that id, which is what this does for you.',
          ),
        timeout_s: z
          .number()
          .int()
          .min(5)
          .max(1800)
          .default(300)
          .describe(
            'How long to wait for the capture before handing back and letting you poll. Ignored when wait is false. Giving up on the wait does not stop the capture.',
          ),
      },
    },
    ({ computer_id, name, memory, wait, timeout_s }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        // One deadline for the whole call, armed before the POST, exactly as
        // move_computer arms its own: timeout_s is a promise about when this
        // comes back, and a POST left on undici's own five-minute header clock
        // could break that promise before the poll ever ran. Nothing is armed
        // when nobody is waiting — a caller who asked for the id and no wait
        // was promised no deadline, so imposing one would cancel a POST that
        // was still perfectly capable of starting a capture.
        const untilDeadline = wait ? AbortSignal.timeout(timeout_s * 1000) : undefined;
        const signal = !untilDeadline
          ? extra.signal
          : extra.signal
            ? AbortSignal.any([extra.signal, untilDeadline])
            : untilDeadline;
        const api = session.api.with(signal);
        // The 202. Its body is a Snapshot row in `state: "capturing"` — a
        // placeholder rather than a snapshot, on which restore, clone and delete
        // all answer 404 until the copy lands (OPL-4562). It is kept whatever
        // happens next, because it is the only description of this capture that
        // does not depend on a later read succeeding.
        let started: Row;
        try {
          started = await api.json<Row>('POST', P.computerAction(id, 'snapshots'), {
            body: P.snapshotBody({ memory, name }),
          });
        } catch (err) {
          // The deadline, or the caller, arriving while the POST is in flight.
          // The generic sentence for this says the request may have been
          // received and to treat what it would have changed as unknown, which
          // is true and is not enough here: a capture that started is billable,
          // takes minutes, and — because the answer that carried its id is the
          // thing that was lost — cannot be polled for at all. Worse, the
          // obvious next move is wrong. A second capture while one is running is
          // refused 409, so a model that simply retries reads that as a failure
          // on top of a capture that is fine (observed live, OPL-4577).
          if (err instanceof CancelledError) {
            return refused(
              `${why(err)}\n\nA CAPTURE OF ${id} MAY BE RUNNING. What was lost is the answer that carried ` +
                `its id, so there is nothing here to poll on — look instead: list_snapshots on ${id} shows ` +
                `a row reading "${CAPTURING}" if one started, and that row's id is the one to follow. Do ` +
                `not simply call this again; a second capture while one is running is refused, and the ` +
                `refusal will be about the capture this call may have started.`,
            );
          }
          throw err;
        }
        // The name read back rather than the one sent, because the interesting
        // case is the one that was not sent: the platform generates
        // "<computer> <timestamp>" when `name` is absent, and that generated
        // name is what a later list_snapshots will show. Saying it here is the
        // difference between a caller that can find this capture again and one
        // that has to go looking for it.
        const called =
          typeof started?.name === 'string' && started.name.trim() ? ` as "${started.name}"` : '';
        // Two sentences for the two things that can be true, and keeping them
        // apart is the whole of OPL-4568. "Snapshotted vm-1" over a 202 is the
        // defect: it is said before a byte has been copied, and a model reads it
        // as a snapshot it may now restore. So the past tense is reserved for a
        // capture this call watched land, and everything that hands back with
        // the copy still running leads with `startedLine` instead.
        const took = `Snapshotted ${id}${memory ? ' with its memory' : ''}${called}.`;
        const startedLine = `Capture of ${id}${memory ? ' with its memory' : ''} started${called}.`;
        // The id allocated before the copy begins, and the whole reason a poll
        // is possible: it is the SNAPSHOT'S own id and does not change when the
        // capture lands, so the row stops reading `capturing` in place rather
        // than being replaced by something under another id.
        const sid = typeof started?.id === 'string' && started.id.trim() ? started.id.trim() : '';
        const startedState = typeof started?.state === 'string' ? started.state : undefined;
        // How to follow it by hand — said wherever this hands back with the
        // capture still running, because "poll list_snapshots" without the two
        // rules under it is an instruction a model gets wrong in both
        // directions: by waiting for the literal `pending`, and by reading a
        // row that vanished as a row that has not appeared yet.
        const byHand =
          `Poll list_snapshots for the id ${sid}: the row stops reading "${CAPTURING}" when the capture ` +
          `lands — do not wait for "pending" specifically, since replication can carry it straight on to ` +
          `"durable" — and a row that DISAPPEARS without ever leaving "${CAPTURING}" is a capture that failed.`;

        // A capture accepted under an id nobody was told cannot be polled for,
        // and it cannot be found again either — every later call takes the id.
        // `refused`, for clone_snapshot's reason one route over: the platform
        // did something billable and the caller has no handle on it, which is
        // not a result to report as success.
        //
        // BEFORE the wait: false branch, not after it, and Codex caught that it
        // was the other way round. `wait: false` is the answer whose whole
        // content is an id — handed back without one it reported success and
        // told the caller to poll list_snapshots for "the id ", which is the
        // same nothing dressed as an instruction.
        if (!sid) {
          return refused(
            `${startedLine} THE CAPTURE IS RUNNING, but the platform sent no snapshot id back, so there ` +
              `is nothing to poll on and the snapshot cannot be named — every call that acts on one takes ` +
              `its id. list_snapshots on ${id} will show it when it lands.`,
            started,
          );
        }
        if (!wait) {
          return said(
            `${startedLine} It is NOT a snapshot yet: while its row reads "${CAPTURING}" it is a ` +
              `placeholder, and restore, clone and delete all fail on it. ${byHand}`,
            started,
          );
        }
        // Already finished when it was answered for — a `201` from a platform
        // that has not taken the 202 yet, or a capture with nothing to copy.
        // Not a state to poll out of, and a loop that did would ask for a row it
        // already holds.
        //
        // An ALLOW-LIST, for the reason {@link LANDED} gives: this asks whether
        // there is anything to wait for, and every unreadable answer — absent,
        // misspelt, renamed, moved — has to mean yes. Only a state this server
        // can read AS a landed one skips the wait.
        if (startedState !== undefined && LANDED.includes(startedState)) {
          return said(`${took} It is ${startedState} — snapshot ${sid}.`, started);
        }

        // The keepalive. Armed after the 202, because everything before it is a
        // single short request and there is nothing to report until there is a
        // capture to report on.
        const beat = heartbeat(extra, server.server);
        await beat(`Capturing ${sid} of ${id} — the copy has started.`);

        let blocked: string | undefined;
        // `untilDeadline &&` rather than `!untilDeadline?.aborted`: the early
        // return above is what guarantees it is armed here, and the optional
        // form would turn a later edit that broke that guarantee into a loop
        // with no deadline at all rather than into a visible mistake.
        while (untilDeadline && !untilDeadline.aborted) {
          // The caller giving up ends the wait. The signal aborts the request in
          // flight, but nothing about an aborted request stops the next
          // iteration from starting one.
          if (extra.signal?.aborted) {
            return refused(
              `Cancelled while waiting for the capture of ${id}. THE CAPTURE IS STILL RUNNING — nothing ` +
                `was stopped, because a disk copy already under way cannot be called back. ${byHand}`,
              started,
            );
          }
          const turn = await snapshotTurn(api, sid, false);
          if (extra.signal?.aborted) continue;
          // A body stream can fail without either signal firing, so the
          // deadline's own arrival is what tells a real timeout from an undici
          // idle abort. Same shape as the two loops in computers.ts.
          if (turn.kind === 'cancelled') {
            if (untilDeadline?.aborted) break;
            blocked = turn.why;
            await beat(`Capturing ${sid} of ${id} — the platform could not be asked: ${turn.why}`);
            await sleep(POLL_MS, signal);
            continue;
          }
          // A poll that failed for a reason worth riding out is weather; one
          // that failed for any other reason is a real failure with a capture
          // still running behind it, and a thrown error's handler has no way to
          // say so. So it is said here rather than rethrown.
          if (turn.kind === 'broken') {
            return refused(
              `${turn.why}\n\nTHE CAPTURE IS STILL RUNNING — this was the poll failing, not the ` +
                `capture. ${byHand}`,
              started,
            );
          }
          if (turn.kind === 'blocked') {
            blocked = turn.why;
            await beat(`Capturing ${sid} of ${id} — the platform could not be asked: ${turn.why}`);
            await sleep(turn.after ?? POLL_MS, signal);
            continue;
          }
          // Absence is the ONLY signal a failed capture leaves, which is what
          // makes snapshotTurn's guards load-bearing rather than tidy: a body
          // that is not a list, and a listing the platform had to answer short,
          // both come back `blocked` there rather than as this, because read as
          // "the row is not there" they would announce that somebody's backup
          // failed while it was still being taken.
          if (turn.kind === 'absent') {
            return refused(
              `THE CAPTURE OF ${id} FAILED and nothing was saved. Snapshot ${sid} is no longer listed and ` +
                `nothing took its place, which is what a capture that starts and then fails leaves behind — ` +
                `this is a failure during the copy, not a wait that ran out. The computer itself is ` +
                `untouched and can be snapshotted again.`,
              started,
            );
          }
          const row = turn.row;
          const state = typeof row.state === 'string' ? row.state : undefined;
          if (state === CAPTURING) {
            blocked = undefined;
            await beat(`Capturing ${sid} of ${id} — still copying.`);
            await sleep(POLL_MS, signal);
            continue;
          }
          // A row with no readable `state` is the platform failing to describe
          // it, and it must not be read as "not capturing, therefore landed" —
          // that sentence says a placeholder may be restored, which is the
          // defect this whole tool is here to stop. Only a state that SAYS it is
          // no longer capturing ends the wait; anything else rides out, and the
          // deadline reports that the platform could not be asked.
          if (state === undefined) {
            blocked = `the row for ${sid} carried no state, so nothing said whether the capture had landed`;
            await beat(`Capturing ${sid} of ${id} — its row carried no state to read.`);
            await sleep(POLL_MS, signal);
            continue;
          }
          return said(
            `${took} The capture landed: snapshot ${sid} reads "${state}" and can now be restored, ` +
              `cloned or deleted.`,
            row,
          );
        }
        // A refusal, for the reason move_computer's is: the wait never reached
        // what it was told to wait for. What it must not do is read as a capture
        // that failed — that is a different answer with a different id in it,
        // and the difference between calling this again and going looking for a
        // snapshot that is on its way.
        return refused(
          blocked
            ? `${startedLine} Gave up watching after ${timeout_s}s; the platform could not be asked — the ` +
                `last attempt said: ${blocked}. THE CAPTURE IS STILL RUNNING. ${byHand}`
            : `${startedLine} Still capturing after ${timeout_s}s, which a large disk takes. THE CAPTURE IS ` +
                `STILL RUNNING and nothing was changed by giving up on the wait. ${byHand}`,
          started,
        );
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
          const at = `${String(set.hour).padStart(2, '0')}:${String(set.minute).padStart(2, '0')} ${set.tz}`;
          const res = await session.api
            .with(extra.signal)
            .send('PUT', path, { body: P.scheduleBody(set) });
          // `enabled` is a required field of `set`, and it is the one that
          // decides whether backups happen at all — so the sentence has to read
          // it. "Snapshot scheduled for 03:00 UTC" over `enabled: false` tells a
          // model the opposite of what the call just did, in the line it acts
          // on, and the hour it names is real, which is what makes the wrong
          // reading easy to believe. The hour is kept on a disabled schedule, so
          // it is worth naming: a model that reads "disabled" and nothing else
          // calls this again to find out what it would have run at.
          return said(
            set.enabled
              ? `Snapshot scheduled for ${at}.`
              : `The nightly snapshot on ${id} is now DISABLED — none will be taken automatically. ${at} is the time it holds, which is when it would resume if you set it again with enabled: true. To remove the schedule rather than turn it off, call this with clear.`,
            res,
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
        'Remove a snapshot permanently. Later snapshots in the same chain are unaffected. THE DELETION OUTLIVES THE REQUEST that starts it: the platform accepts it and then detaches the dependent snapshots and removes the stored objects, which takes time that scales with the chain and with how much is stored. This waits for it by default and reports what actually happened; pass wait: false to hand back as soon as it is accepted. A 409 saying the snapshot is ALREADY BEING DELETED is progress rather than a fault — the platform is doing what you asked, and the answer is to watch that one finish, never to go and delete something else. A wait reports progress while it runs, so a client that sends a progressToken and sets resetTimeoutOnProgress can hold the request open; a client that cannot should pass wait: false and poll list_snapshots.',
      inputSchema: {
        snapshot_id: z.string().trim(),
        confirm: z.literal(true).describe('Must be true.'),
        wait: z
          .boolean()
          .default(true)
          .describe(
            'Wait for the snapshot to stop being listed, which is the only thing that means it is gone. Set it false to hand back as soon as the platform accepts the deletion, and then poll list_snapshots yourself.',
          ),
        timeout_s: z
          .number()
          .int()
          .min(5)
          .max(1800)
          .default(300)
          .describe(
            'How long to wait for the deletion before handing back. Ignored when wait is false. Giving up on the wait does not stop the deletion.',
          ),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ snapshot_id, wait, timeout_s }, extra) =>
      guarded(async () => {
        // The deadline is armed before the DELETE, as create_snapshot arms its
        // own and for the same reason: timeout_s is a promise about when this
        // comes back. Nothing is armed when nobody is waiting.
        const untilDeadline = wait ? AbortSignal.timeout(timeout_s * 1000) : undefined;
        const signal = !untilDeadline
          ? extra.signal
          : extra.signal
            ? AbortSignal.any([extra.signal, untilDeadline])
            : untilDeadline;
        const api = session.api.with(signal);
        // How to follow it by hand, said wherever this hands back with the
        // deletion still running. The polarity is the whole of it and it is the
        // opposite of a capture's: there is no state that means deleted, so the
        // row GOING is the finish, and a row that stays is one that stalled.
        // `include_unfinished` is not a nicety either — the platform marks a
        // half-finished deletion `deleting` and leaves that state out of a bare
        // listing, so without the flag a stalled deletion looks exactly like a
        // finished one.
        const byHand =
          `Poll list_snapshots with include_unfinished: true and watch for ${snapshot_id} to stop being ` +
          `listed — its absence is the deletion having finished, and there is no state that means deleted. ` +
          `A row that STAYS is one that stalled; the platform retries those itself every fifteen minutes.`;
        let accepted: unknown;
        try {
          accepted = await api.send('DELETE', P.snapshot(snapshot_id));
        } catch (err) {
          // Every refusal is still decided before the 202 — no such snapshot, a
          // capture reading through it, a clone or a migration holding it, a
          // deletion of this id already running — so a 409 here is a statement
          // about state that clears itself, and the model needs to be told
          // which way to read it rather than left to invent a way round it.
          //
          // Matched on the CLASS and never on the sentence: the platform sends
          // no `reason` for these, and keying on prose is the mistake OPL-3724
          // took out of three clients. So both readings are named and the
          // platform's own words are printed with them.
          // The deadline, or the caller, arriving while the DELETE is in
          // flight. The generic cancellation sentence says the request may have
          // been received; what it cannot say is that the work it started
          // OUTLIVES the request, so "cancelled" here reads as a deletion that
          // did not happen while the objects are being removed. Claiming less
          // than happened, which on a destructive call is its own kind of wrong
          // answer (codex review, gpt-5.6-sol).
          //
          // The retry rule is worth saying in the same breath, because it is
          // the one thing that makes this recoverable: repeating the call is
          // safe. A snapshot already being deleted answers 409, and one that is
          // gone answers 404, and this tool has a sentence for each.
          if (err instanceof CancelledError) {
            return refused(
              `${why(err)}\n\nTHE DELETION OF ${snapshot_id} MAY BE RUNNING: the request may have reached ` +
                `the platform and been accepted, and nothing about the answer being lost calls it back. ` +
                `${byHand} Calling this again is safe either way — a snapshot already being deleted ` +
                `answers a conflict, and one that is gone answers that there is nothing to delete.`,
            );
          }
          if (err instanceof ConflictError) {
            return refused(
              `${why(err)}\n\nNOTHING WAS DELETED and nothing is broken. If that says the snapshot is ` +
                `already being deleted, the platform is doing what you asked — watch it finish rather ` +
                `than deleting anything else: ${byHand} If it says something is reading through the ` +
                `snapshot — a restore, a clone, a capture chaining onto it — that finishes on its own and ` +
                `the same call works afterwards.`,
            );
          }
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
        // The 202 and its body: the snapshot's row as it stood when the deletion
        // was accepted — the row that GOES when the work finishes.
        if (!wait) {
          return said(
            `Deletion of ${snapshot_id} accepted and RUNNING — it is not gone yet, and this call did not ` +
              `wait to find out. ${byHand}`,
            accepted,
          );
        }

        const beat = heartbeat(extra, server.server);
        await beat(`Deleting ${snapshot_id} — the platform has accepted it.`);

        let blocked: string | undefined;
        let seen: string | undefined;
        while (untilDeadline && !untilDeadline.aborted) {
          if (extra.signal?.aborted) {
            return refused(
              `Cancelled while waiting for ${snapshot_id} to be deleted. THE DELETION IS STILL RUNNING — ` +
                `nothing was called back, and objects it has already removed are already gone. ${byHand}`,
              accepted,
            );
          }
          // `unfinished`, because the state a stalled deletion sits in is the
          // one a bare listing hides. Asking without it would read a snapshot
          // stuck half-deleted as a snapshot successfully deleted, which is the
          // one wrong answer this tool must not give.
          const turn = await snapshotTurn(api, snapshot_id, true);
          if (extra.signal?.aborted) continue;
          if (turn.kind === 'cancelled') {
            if (untilDeadline.aborted) break;
            blocked = turn.why;
            await beat(`Deleting ${snapshot_id} — the platform could not be asked: ${turn.why}`);
            await sleep(POLL_MS, signal);
            continue;
          }
          if (turn.kind === 'broken') {
            return refused(
              `${turn.why}\n\nTHE DELETION IS STILL RUNNING — this was the poll failing, not the ` +
                `deletion. ${byHand}`,
              accepted,
            );
          }
          if (turn.kind === 'blocked') {
            blocked = turn.why;
            await beat(`Deleting ${snapshot_id} — the platform could not be asked: ${turn.why}`);
            await sleep(turn.after ?? POLL_MS, signal);
            continue;
          }
          // The row is gone from a listing that was read whole and that ASKED
          // for the unfinished ones. Both halves are what make this sentence
          // true rather than merely likely.
          if (turn.kind === 'absent') return said(`Deleted snapshot ${snapshot_id}.`, accepted);
          blocked = undefined;
          seen = typeof turn.row.state === 'string' ? turn.row.state : undefined;
          await beat(`Deleting ${snapshot_id} — still listed${seen ? `, reading "${seen}"` : ''}.`);
          await sleep(POLL_MS, signal);
        }
        // Still listed. Three different things that can mean, and they are not
        // one sentence: the platform could not be asked, the deletion got part
        // way and stalled, or it never got started on — which is the shape the
        // one conflict that arrives AFTER the 202 leaves behind, a dependent
        // that is itself being deleted and so cannot be detached.
        return refused(
          blocked
            ? `Gave up watching after ${timeout_s}s; the platform could not be asked whether ${snapshot_id} ` +
                `is gone — the last attempt said: ${blocked}. THE DELETION IS STILL RUNNING. ${byHand}`
            : seen === DELETING
              ? `${snapshot_id} is still listed after ${timeout_s}s and reads "${DELETING}": the deletion ` +
                `started and has not finished. Nothing was undone by giving up on the wait, and the ` +
                `platform retries a stalled deletion itself every fifteen minutes — so this usually needs ` +
                `watching rather than repeating. ${byHand}`
              : `${snapshot_id} is still listed after ${timeout_s}s${seen ? `, reading "${seen}"` : ''} — ` +
                `the deletion has not reached the point of marking it "${DELETING}". That is what a big ` +
                `chain looks like early on, and it is also what the one conflict that arrives after the ` +
                `deletion is accepted looks like: a dependent snapshot that is ITSELF being deleted cannot ` +
                `be detached, so this one waits for that one. Nothing was destroyed either way. ${byHand}`,
          accepted,
        );
      }),
  );
};
