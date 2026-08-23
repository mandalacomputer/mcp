import { z } from 'zod';
import { CancelledError, isTransientForPoll, MoveRequiredError } from '../errors.js';
import {
  type Computer,
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
 * A pause that ends early when the caller gives up.
 *
 * The wait loops check the signal at the top of each turn, so a sleep that
 * ignored it would still hold a cancelled call for its remaining seconds.
 */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * The answer to a wait the caller ended.
 *
 * `refused`, not `said`: the wait never reached what it was told to wait for,
 * and a caller reading `isError` to decide whether the step worked would
 * otherwise be unable to tell a cancellation from a computer that came up.
 */
const cancelled = (id: string, last: string) =>
  refused(`Cancelled after waiting for ${id}; it was last seen ${last}. Nothing was changed.`);

/**
 * What a move looks like on the wire (OPL-3766).
 *
 * Mirrors the platform's `Move` schema, which mirrors moveView in its lib/moves
 * — deliberately not the whole row: `from_host` and `to_host` are recorded there
 * and never sent, because which machine a computer is on is the platform's
 * business and not a tenant's.
 */
type Move = {
  computer_id: string;
  state: string;
  detail?: string;
  live: boolean;
  cpu?: number;
  ram_mb?: number;
  disk_gb?: number;
  started_at?: string;
  finished_at?: string;
};

const movesOf = (body: unknown): Move[] => {
  const list = (body as { moves?: unknown } | null)?.moves;
  return Array.isArray(list) ? (list as Move[]) : [];
};

/**
 * The resize refusal that is an OFFER, turned into a next step (OPL-3775).
 *
 * The platform's own sentence first, because it is the one that says what will
 * not fit and what moving costs — written for whoever has to agree to it. What
 * this adds is the two things that sentence cannot know: that retrying is
 * pointless, and the name of the tool that takes the offer up.
 *
 * Both halves matter. Without the first, a model reads 409, reads "worth
 * retrying" in every other refusal it has met, and loops. Without the second it
 * has been told a way out exists and has nothing to call — which is the whole
 * defect this closes, and which is worse for a model than for a person, since a
 * person can go and look at the dashboard.
 */
const moveOffered = (id: string, err: MoveRequiredError) =>
  refused(
    err.movePossible
      ? `${err.message}\n\nThis does not clear by itself: retrying the same resize gets the same answer for ` +
          `as long as ${id} is on that host. move_computer applies exactly this size and moves the computer ` +
          `to a host in the region that can run it. Say what that costs before you call it — the computer's ` +
          `disk is copied to different hardware, and it has to be stopped first.`
      : `${err.message}\n\nThis does not clear by itself, and there is nothing to move to: no host in this ` +
          `region can run that size at all. Ask for less RAM.`,
  );

/** The size a move is applying, for a line a person can read. */
const moveShape = (m: Move) =>
  [m.cpu && `${m.cpu} vCPU`, m.ram_mb && `${m.ram_mb} MB RAM`, m.disk_gb && `${m.disk_gb} GB disk`]
    .filter(Boolean)
    .join(' · ') || 'no change';

/** One row of list_moves. */
const moveLine = (m: Move) =>
  `${m.computer_id}: ${m.state}${m.live ? ' (running)' : ''} — ${moveShape(m)}${m.detail ? ` — ${m.detail}` : ''}`;

/**
 * A move that has stopped, read as the four different things it can be.
 *
 * The states are not four flavours of the same outcome and reading them that way
 * is the mistake worth designing against, because the recovery differs and two
 * of them are not failures at all:
 *
 *   done    the computer is on the new host at the new size. Success.
 *   moved   the computer IS on another host, at its OLD size. The move landed
 *           and the resize did not. Not "the move failed" — saying so would send
 *           a caller looking for a machine that is no longer where it was — and
 *           recoverable with an ordinary update_computer, because it is now on a
 *           host that can run the size.
 *   failed  nothing happened. The computer is where it was, untouched.
 *   lost    we stopped watching. It may well have completed; go and look.
 *
 * `moved`, `failed` and `lost` are refusals so that a caller reading `isError`
 * to decide whether its resize happened gets the right answer — and `moved`
 * carries the loudest instruction of the three, because it is the one where the
 * computer has genuinely changed and the caller might not notice.
 */
const finishedMove = (id: string, m: Move) => {
  const detail = m.detail ? ` ${m.detail}` : '';
  if (m.state === 'done') return said(`${id} moved and is now ${moveShape(m)}.`, m);
  if (m.state === 'moved') {
    return refused(
      `${id} MOVED to another host but was NOT resized — it is still at its old size.${detail} The move ` +
        `itself is done and does not need repeating; it is now on a host that can run the size, so ` +
        `update_computer resizes it where it is.`,
      m,
    );
  }
  if (m.state === 'failed') {
    return refused(
      `${id} was not moved and was not resized — it is where it was, untouched.${detail}`,
      m,
    );
  }
  return refused(
    `The move of ${id} stopped being watched, so we cannot say whether it finished.${detail} Read ` +
      `get_computer to see which size it is at now before doing anything else.`,
    m,
  );
};

const POWER_DESCRIPTIONS: Record<string, string> = {
  start:
    'Boot a computer, or resume a suspended one — a resume restores the saved session, same processes and windows, in about a second.',
  stop: 'Shut a computer down: the guest is asked, and given time to do it. Discards a saved session if there is one. The disk is kept. `force` pulls the power instead, for a guest that will not come down on its own.',
  suspend:
    "Write the guest's RAM to disk and give the host its memory back. A pause, not a stop: start_computer resumes the same session.",
  restart:
    'Reset the computer. Refused while a session is suspended, since it would have to guess whether you meant to resume or discard it.',
};

export const registerComputers: Registrar = (server, session, opts) => {
  server.registerTool(
    'list_templates',
    {
      title: 'List templates',
      description:
        'The base images a computer can be created from — name, OS, and the default CPU, RAM and disk each one implies.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    (_args, extra) =>
      guarded(async () => json(await session.api.with(extra.signal).json('GET', P.TEMPLATES))),
  );

  server.registerTool(
    'list_sizes',
    {
      title: 'List sizes',
      description:
        'The named sizes a computer can be launched at — each a template plus a CPU/RAM/disk shape. These are the shapes the platform keeps pre-booted, so create_computer with a `size` is typically answered in about a second where a custom shape boots cold. `allowed` says whether this account’s plan admits a row; when false, `cheapest_plan` names the plan that would.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    (_args, extra) =>
      guarded(async () => json(await session.api.with(extra.signal).json('GET', P.SIZES))),
  );

  server.registerTool(
    'list_computers',
    {
      title: 'List computers',
      description:
        'Every computer on this account. Desktop credentials are deliberately not included — use get_desktop_url for those.',
      inputSchema: {
        allow_partial: z
          .boolean()
          .optional()
          .describe(
            'Accept a short list when a hypervisor cannot be reached, instead of the 503 the platform answers by default. The answer then says it is short — a short list reads exactly like the missing computers were deleted.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ allow_partial }, extra) =>
      guarded(async () => {
        // listing, not json: with allow_partial the platform will hand over an
        // inventory it knows is short, and says so in X-GC-Incomplete. Reading
        // the body and dropping the header turns "here is part of the fleet"
        // into "here is the fleet".
        const { items, incomplete } = await session.api
          .with(extra.signal)
          .listing<unknown[]>(P.COMPUTERS, {
            query: { allow_partial: allow_partial ? 1 : undefined },
          });
        // Checked rather than asserted. `listing<unknown[]>` is a claim about
        // what the platform sends, not a guarantee — a proxy or a future
        // paginated envelope answers with an object, and `.length` on that is
        // `undefined`, which reads as an empty account: the duplicate-create the
        // rest of this handler goes to some length to prevent, arrived at from
        // the other side.
        //
        // An absent body is the same mistake in its quietest form. `listing`
        // returns `undefined` for a 204 or a zero-length 200 — a gateway
        // answering with nothing at all — and `items ?? []` would turn that
        // silence into the very sentence below about an account with no
        // computers in it. The platform sending no inventory is not the
        // platform sending an empty one, and only one of the two is an
        // invitation to create.
        if (!Array.isArray(items)) {
          const got =
            items === undefined ? 'no body at all' : items === null ? 'null' : typeof items;
          return refused(
            `GET /computers answered with ${got}, not a list of computers. This is not an empty account — do not create a computer on the strength of it.`,
            items,
          );
        }
        const malformed = items.filter(
          (item) => item === null || typeof item !== 'object' || Array.isArray(item),
        ).length;
        const list = items.filter(
          (item): item is Computer =>
            item !== null && typeof item === 'object' && !Array.isArray(item),
        );
        const warning =
          incompleteWarning('computers', incomplete) +
          (malformed
            ? `WARNING: ignored ${malformed} malformed computer entr${malformed === 1 ? 'y' : 'ies'} from the platform.\n\n`
            : '');
        if (!list.length) {
          if (malformed) {
            return refused(
              `${warning}No valid computers remained. This is not an empty account — do not create a computer on the strength of a malformed listing.`,
              items,
            );
          }
          // Two different empty answers, and telling them apart is the whole
          // point of reading the header. A workspace-scoped key gets no
          // unreachable placeholder rows at all — the platform withholds them
          // rather than name computers in other workspaces — so header-present
          // with nothing in the array is the ORDINARY shape of an outage for
          // such a key, not a rare one.
          //
          // Saying "no computers yet, create one" there is the duplicate-create
          // this warning exists to prevent: the model is told in one sentence
          // that an unknown number are missing and in the next that the account
          // is empty, and only one of those suggests an action.
          if (incomplete !== null) {
            return said(
              `${warning}No computers came back from the part of the fleet that answered. This is NOT an empty account — do not create a computer on the strength of it. Retry in a moment.`,
            );
          }
          return said(
            'No computers on this account yet. create_computer makes one; list_templates says what from.',
          );
        }
        const lines = list.map((c) => `- ${describe(c as never)}`).join('\n');
        return said(
          `${warning}${list.length} computer(s):\n${lines}`,
          list.map((c) => withoutCredentials(c as never)),
        );
      }),
  );

  server.registerTool(
    'get_computer',
    {
      title: 'Get a computer',
      description:
        'Everything the platform knows about one computer: status, size, and the screen resolution every click and screenshot is measured in.',
      inputSchema: { ...idArg },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const c = unwrapComputer(await session.api.with(extra.signal).json('GET', P.computer(id)));
        session.noteResolution(id, c.resolution);
        return said(describe(c), withoutCredentials(c));
      }),
  );

  server.registerTool(
    'use_computer',
    {
      title: 'Select a computer',
      description:
        'Bind a computer to this session, so every later call can leave computer_id out. Answers with its status and screen resolution.',
      inputSchema: {
        computer_id: z.string().describe('The id from list_computers.'),
      },
    },
    ({ computer_id }, extra) =>
      guarded(async () => {
        const selectionVersion = session.beginSelection(computer_id);
        try {
          // Read it before binding. Binding an id the platform does not recognise
          // would send every subsequent call to a 404 with no clue why, and the
          // read costs one round trip against a session that will make hundreds.
          const c = unwrapComputer(
            await session.api.with(extra.signal).json('GET', P.computer(computer_id)),
          );
          // The id the platform echoed back, not the one that was typed. They can
          // differ — `P.segment` trims before the call, so " vm-1 " reaches the
          // API as vm-1 — and `unbind` and `noteResolution` compare with `===`,
          // so binding the untrimmed form leaves a later delete_computer("vm-1")
          // unable to clear the selection it just destroyed. The other two bind
          // sites already use `c.id`.
          if (!session.bindIfCurrent(c.id ?? computer_id, c.resolution, selectionVersion)) {
            return refused(
              `${c.id ?? computer_id} was deleted while it was being selected. The session selection was not changed.`,
            );
          }
          return said(
            `Selected ${describe(c)}. Later calls need no computer_id.` +
              (c.status === 'running'
                ? ''
                : `\n\nIt is ${c.status ?? 'not running'} — start_computer before driving it.`),
            withoutCredentials(c),
          );
        } finally {
          session.endSelection(computer_id);
        }
      }),
  );

  // Power. Not behind the lifecycle gate: a server that may only attach to
  // computers somebody else made still has to be able to bring one up, and a
  // stopped computer refuses every other tool here.
  //
  // Four tools around one request, and stop registered on its own below it:
  // stop is the only power action with a second argument to take, and folding
  // an optional one into the loop would leave the other three advertising a
  // parameter their route does not read.
  const power = (
    action: string,
    computer_id: string | undefined,
    extra: { signal?: AbortSignal },
    opts: { query?: Record<string, string | undefined>; note?: string } = {},
  ) =>
    guarded(async () => {
      const id = session.resolve(computer_id);
      const c = unwrapComputer(
        await session.api
          .with(extra.signal)
          .json('POST', P.computerAction(id, action), { query: opts.query }),
      );
      session.noteResolution(id, c.resolution);
      return said(`${action}: ${describe(c)}${opts.note ?? ''}`, withoutCredentials(c));
    });

  for (const action of ['start', 'suspend', 'restart'] as const) {
    server.registerTool(
      `${action}_computer`,
      {
        title: `${action[0].toUpperCase()}${action.slice(1)} a computer`,
        description: POWER_DESCRIPTIONS[action],
        inputSchema: { ...idArg },
      },
      ({ computer_id }, extra) => power(action, computer_id, extra),
    );
  }

  server.registerTool(
    'stop_computer',
    {
      title: 'Stop a computer',
      description: POWER_DESCRIPTIONS.stop,
      inputSchema: {
        ...idArg,
        force: z
          .boolean()
          .optional()
          .describe(
            'Pull the power instead of asking, the way holding the button in does. Anything the guest had not written to disk is lost, so this is the second attempt and not the first: stop it politely, and reach for `force` when what comes back is a computer still running — a hung X session, a modal "unsaved changes" dialog, or a service that ignores SIGTERM will refuse the polite stop identically every time it is asked.',
          ),
      },
    },
    ({ computer_id, force }, extra) =>
      power('stop', computer_id, extra, {
        // The platform's schema for this one is `enum: ['true']` — a string,
        // with no false in it — so an unforced stop omits the parameter rather
        // than sending `force=false`, the way `allow_partial` and
        // `snapshots=delete` are omitted here already.
        query: { force: force ? 'true' : undefined },
        // Said in the answer and not only in the schema, because the two stops
        // are indistinguishable afterwards: both leave a stopped computer with
        // its disk, and only one of them threw away what was in RAM. A
        // transcript that does not say which happened is a transcript nobody
        // can debug the missing work from.
        note: force
          ? '\n\nThe power was pulled rather than asked for: whatever the guest had not written to disk is gone.'
          : undefined,
      }),
  );

  server.registerTool(
    'update_computer',
    {
      title: 'Rename or resize a computer',
      description:
        "Change a computer's name, its size, or its idle window. The platform refuses these in combination on purpose — a resize needs the computer stopped and the other two do not, so one request cannot honour both without applying half of it. A SUSPENDED computer counts as stopped for a resize, and its saved desktop cannot survive one: the vCPU count and the memory size are part of the saved state, so it is discarded and the next start is a cold boot. Resume it and finish what is open before resizing, or say so before you do it.",
      inputSchema: {
        ...idArg,
        name: z.string().optional(),
        cpu: z.number().int().min(1).optional().describe('Needs the computer stopped.'),
        ram_mb: z.number().int().min(512).optional().describe('Needs the computer stopped.'),
        disk_gb: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Needs the computer stopped. Disks grow only.'),
        idle_suspend_min: z
          .number()
          .int()
          .min(0)
          .nullable()
          .optional()
          .describe(
            "Minutes untouched before the host suspends it. null follows the host's own window; send this on its own.",
          ),
      },
    },
    ({ computer_id, ...fields }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        // `null` is meaningful for idle_suspend_min and must survive the filter;
        // every other absent field is dropped so the platform leaves it alone.
        const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        if (!Object.keys(body).length) {
          return refused(
            'Nothing to change — give at least one of name, cpu, ram_mb, disk_gb, idle_suspend_min.',
          );
        }
        let c: Computer;
        try {
          c = unwrapComputer(
            await session.api.with(extra.signal).json('PATCH', P.computer(id), { body }),
          );
        } catch (err) {
          // The one refusal on this route that is an offer rather than an end
          // (OPL-3775). Caught here and nowhere else because this is the only
          // route that produces it, and because the next step names a tool —
          // which the error class, shared with every embedder, has no business
          // knowing about.
          if (err instanceof MoveRequiredError) return moveOffered(id, err);
          throw err;
        }
        session.noteResolution(id, c.resolution);
        return said(describe(c), withoutCredentials(c));
      }),
  );

  server.registerTool(
    'move_computer',
    {
      title: 'Move a computer to a host that can run a bigger size',
      description:
        'Grow a computer past what its current host can run, by moving it to another host in the same region first. Only call this after update_computer has refused a resize and said a move is possible: it is the second half of that refusal and nothing else. THIS MOVES THE MACHINE TO DIFFERENT HARDWARE and copies its disk to get there — say so before you call it. The computer must be STOPPED (suspended is not stopped here: a saved desktop only loads on the host that wrote it, so resume and stop it, or discard the session). One move runs per account at a time. Everything is decided again when this runs, so it can still refuse. Waits for the outcome and reports it; list_moves reads it if the wait runs out.',
      inputSchema: {
        ...idArg,
        // Required, unlike every other field here, and unlike the same argument
        // on update_computer. A move exists to escape a RAM ceiling: the
        // platform fills an omitted ram_mb from the computer's current size and
        // then refuses the move for not needing one, so a call without it can
        // only ever be refused. Requiring it here turns a guaranteed 409 into a
        // schema the model cannot get wrong.
        ram_mb: z
          .number()
          .int()
          .min(512)
          .describe('The size that did not fit. Must be MORE than the computer has now.'),
        cpu: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Applied with the move. Omit to leave alone.'),
        disk_gb: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Applied with the move, after the copy. Disks grow only.'),
        timeout_s: z
          .number()
          .int()
          .min(5)
          .max(900)
          .default(300)
          .describe(
            'How long to wait for the move to finish before handing back and letting you poll.',
          ),
      },
    },
    ({ computer_id, ram_mb, cpu, disk_gb, timeout_s }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const body = {
          ram_mb,
          ...(cpu !== undefined && { cpu }),
          ...(disk_gb !== undefined && { disk_gb }),
        };

        // One deadline for the whole call, armed before the POST rather than
        // after it, for the reason wait_for_computer gives: timeout_s is a
        // promise about when this comes back, and a per-poll timer bounds how
        // often it asks instead.
        const untilDeadline = AbortSignal.timeout(timeout_s * 1000);
        const signal = extra.signal
          ? AbortSignal.any([extra.signal, untilDeadline])
          : untilDeadline;
        const api = session.api.with(signal);

        // The 202. Its body is the move as it stood the moment it was accepted,
        // and it is kept because it is the only description of this move that
        // does not depend on a later read succeeding.
        const started = (await api.json('POST', P.computerAction(id, 'move'), { body })) as Move;

        let last: Move = started;
        let blocked: string | undefined;
        while (!untilDeadline.aborted) {
          if (extra.signal?.aborted) {
            return refused(
              `Cancelled while waiting for ${id} to move. THE MOVE IS STILL RUNNING — nothing was stopped, ` +
                `because a disk crossing between two hosts cannot be called back. list_moves says where it ` +
                `got to.`,
              last,
            );
          }
          let mine: Move | undefined;
          try {
            mine = movesOf(await api.json('GET', P.MOVES)).find((m) => m.computer_id === id);
          } catch (err) {
            if (extra.signal?.aborted) continue;
            if (err instanceof CancelledError) {
              if (untilDeadline.aborted) break;
              blocked = err.message;
              await sleep(2000, signal);
              continue;
            }
            // The poll reads the control plane's own table, so the statuses
            // worth riding out are the ones that mean "ask again" — exactly
            // wait_for_computer's list. Anything else is a real failure, and
            // the move is still running behind it, which a thrown error's
            // handler has no way to say. So it is said here.
            if (!isTransientForPoll(err)) {
              return refused(
                `${err instanceof Error ? err.message : String(err)}\n\nTHE MOVE IS STILL RUNNING — this ` +
                  `was the poll failing, not the move. list_moves says where it got to.`,
                last,
              );
            }
            blocked = err instanceof Error ? err.message : String(err);
            await sleep(2000, signal);
            continue;
          }
          blocked = undefined;
          // A move that is no longer listed is one the platform reaped, and it
          // reaps for one reason: the computer was deleted. Not a state to keep
          // polling for.
          if (!mine) {
            return refused(
              `The move of ${id} is no longer listed. That happens when the computer is deleted — check ` +
                `list_computers.`,
              last,
            );
          }
          last = mine;
          if (!mine.live) return finishedMove(id, mine);
          await sleep(2000, signal);
        }
        return refused(
          blocked
            ? `Gave up watching after ${timeout_s}s; the platform could not be asked — the last attempt said: ` +
                `${blocked}. THE MOVE IS STILL RUNNING. list_moves says where it got to.`
            : `Still moving after ${timeout_s}s, which a large disk takes. THE MOVE IS STILL RUNNING and ` +
                `nothing was changed by giving up on the wait. list_moves says where it got to.`,
          last,
        );
      }),
  );

  server.registerTool(
    'list_moves',
    {
      title: 'List moves in progress and their outcomes',
      description:
        'Every move on this account: the ones running and the ones that finished in the last day. Read this after move_computer if the wait ran out, and read it when a move is refused because another computer on the account is already being moved — only one runs at a time, and this says which one and how far along. `live` is the flag to poll on.',
      inputSchema: {},
    },
    (_args, extra) =>
      guarded(async () => {
        const moves = movesOf(await session.api.with(extra.signal).json('GET', P.MOVES));
        if (!moves.length) return said('No moves on this account.', []);
        return said(moves.map(moveLine).join('\n'), moves);
      }),
  );

  server.registerTool(
    'wait_for_computer',
    {
      title: 'Wait for a computer to be ready',
      description:
        'Poll until the computer is running, or until the software inside it answers. Use "guest" before exec, files or windows, and before expecting a screenshot to show a desktop rather than a boot screen.',
      inputSchema: {
        ...idArg,
        until: z
          .enum(['running', 'guest'])
          .default('guest')
          .describe(
            '"running" is the hypervisor reporting the VM up. "guest" is the software inside it answering, which is what exec and a painted desktop actually need.',
          ),
        timeout_s: z.number().int().min(5).max(900).default(180),
      },
    },
    ({ computer_id, until, timeout_s }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        // timeout_s used to gate only the top of the loop, which bounds how
        // often this asks and not how long any one ask may take. Node's fetch
        // has no response deadline of its own beyond undici's five-minute
        // header timeout, so a single stalled poll could hold a wait told to
        // give up in thirty seconds for minutes past its word — and the tool's
        // whole contract is that it comes back when it said it would.
        //
        // One signal for the whole wait rather than one per poll: the deadline
        // is a property of the wait, and arming a fresh timer on every turn
        // would leave hundreds of them live across a fifteen-minute window.
        const untilDeadline = AbortSignal.timeout(timeout_s * 1000);
        const signal = extra.signal
          ? AbortSignal.any([extra.signal, untilDeadline])
          : untilDeadline;
        const api = session.api.with(signal);
        let last = 'unknown';
        // Kept so the give-up message can name it. A hypervisor that was
        // unreachable for the whole window is the single most useful thing to
        // report, and swallowing every transient would end the wait saying only
        // that the status was never seen.
        let blocked: string | undefined;
        while (!untilDeadline.aborted) {
          // The caller giving up ends the wait. The signal aborts the request
          // in flight, but nothing about an aborted request stops the next
          // iteration from starting one — so a cancelled call would go on
          // polling the platform for the rest of its timeout_s, up to fifteen
          // minutes of traffic on behalf of nobody.
          if (extra.signal?.aborted) return cancelled(id, last);
          // The status read is exactly as transient-prone as the guest probe
          // below it — a hypervisor that cannot be reached answers 503, which
          // is the ordinary weather of a machine still coming up. Letting that
          // out would abort the one tool whose entire job is to keep asking.
          let c: Computer;
          try {
            c = unwrapComputer(await api.json('GET', P.computer(id)));
          } catch (err) {
            // The caller's own signal is checked first, and by identity rather
            // than by reading the error: the request is now bound to two
            // deadlines, and only one of them means anybody stopped caring.
            if (extra.signal?.aborted) return cancelled(id, last);
            // A body stream can also fail without either signal firing (an
            // undici idle timeout is an AbortError). That is a transport
            // failure, not a cancellation, and is retried below as transient.
            // Only the deadline signal proves the wait's own timer arrived.
            if (err instanceof CancelledError) {
              if (untilDeadline.aborted) {
                blocked = `the status read was still in flight when the ${timeout_s}s deadline arrived`;
                break;
              }
              blocked = err.message;
              await sleep(2000, signal);
              continue;
            }
            if (!isTransientForPoll(err)) throw err;
            blocked = err instanceof Error ? err.message : String(err);
            await sleep(2000, signal);
            continue;
          }
          blocked = undefined;
          session.noteResolution(id, c.resolution);
          last = c.status ?? 'unknown';
          if (last === 'build-failed') {
            // `refused`, for the reason `cancelled` is: the wait never reached
            // what it was told to wait for, and this one never will. A caller
            // reading `isError` to decide whether to go on would otherwise see
            // a build that failed and a guest that answered as the same result.
            //
            // `build.source` is what the machine was built *from*, not why the
            // build failed — printed bare after "Build failed:" it reads as the
            // reason and names an image instead of a cause. `start_error` is
            // the field that carries a diagnostic, so prefer it and label the
            // source as the source when that is all there is.
            const why = c.start_error
              ? `: ${c.start_error}`
              : c.build?.source
                ? ` (built from ${c.build.source}) — the platform gave no reason`
                : ' — the platform gave no reason';
            return refused(
              `Build failed${why}. This does not resolve on its own.`,
              withoutCredentials(c),
            );
          }
          // Neither of the next two resolves on its own, so spinning on either
          // burns the whole timeout waiting for something nobody is going to do.
          if (last === 'suspended') {
            return refused(
              `${id} is suspended, and that state does not clear by itself. start_computer resumes the saved session in about a second.`,
              withoutCredentials(c),
            );
          }
          if (last === 'stopped') {
            return refused(`${id} is stopped. start_computer boots it.`, withoutCredentials(c));
          }
          if (last === 'running') {
            if (until === 'running') return said(`Running: ${describe(c)}`, withoutCredentials(c));
            // "The guest is up" is not a status the platform reports, so it is
            // asked rather than waited for: a trivial exec either answers, or
            // refuses with the 409 that says the agent is not up yet.
            try {
              await api.send('POST', P.computerAction(id, 'exec'), {
                body: P.execBody({ command: 'true', timeout_s: 5 }),
              });
              return said(`Guest is answering: ${describe(c)}`, withoutCredentials(c));
            } catch (err) {
              // The same two deadlines as the status read above, and for the
              // same reason: this catch used to judge the error alone, so a
              // cancellation during the guest probe left the wait throwing what
              // read as a platform outage instead of saying the caller had
              // hung up. Half the loop knew to check the signal and half did
              // not, which is the worse of the two ways to be inconsistent.
              if (extra.signal?.aborted) return cancelled(id, last);
              if (err instanceof CancelledError) {
                if (untilDeadline.aborted) {
                  blocked = `the guest probe was still in flight when the ${timeout_s}s deadline arrived`;
                  break;
                }
                blocked = err.message;
                await sleep(2000, signal);
                continue;
              }
              if (!isTransientForPoll(err)) throw err;
            }
          }
          await sleep(2000, signal);
        }
        // Also a refusal: the deadline passed without the condition being met,
        // which is the same shape of answer as a cancellation and not the same
        // as success. The message still says to call again, because the state
        // it was waiting on may yet arrive.
        return refused(
          blocked
            ? `Gave up after ${timeout_s}s; the platform could not be asked about ${id} for the whole wait — the last attempt said: ${blocked}. Nothing was changed — call again to keep waiting.`
            : `Gave up after ${timeout_s}s; ${id} was last seen ${last}. Nothing was changed — call again to keep waiting.`,
        );
      }),
  );

  server.registerTool(
    'get_desktop_url',
    {
      title: 'Get a link to watch the desktop',
      description:
        "A URL that opens this computer's live desktop in a browser. Watch-only by default. These are credentials in a link: anyone holding one has that desktop until the computer restarts.",
      inputSchema: {
        ...idArg,
        control: z
          .boolean()
          .default(false)
          .describe(
            'Return the full-control URL instead of the watch-only one. It carries a token that is root-equivalent on that machine — the watch-only socket has input dropped by the platform, not merely hidden by the client.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id, control }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const c = unwrapComputer(await session.api.with(extra.signal).json('GET', P.computer(id)));
        const vnc = c.vnc as Record<string, string> | undefined;
        if (!vnc) {
          // `refused`: the caller asked for a URL and there is none. Said as a
          // success, an orchestrator reading `isError` cannot tell a link from
          // the absence of one, and hands the next step a sentence where it
          // expected an address.
          return refused(
            `No desktop credentials on ${id} right now. The platform omits them when the computer is not running, or when its hypervisor could not be reached — a URL built over nothing looks exactly like a working one until it is used.`,
          );
        }
        // A `vnc` object that is missing the requested key is the same answer as
        // no `vnc` at all, and has to read like it. `JSON.stringify` drops an
        // undefined value rather than recording it, so handing the object
        // straight over would print `{}` underneath a sentence promising full
        // control of the machine — the reader is told a link was given and
        // shown nothing to reconcile that against.
        const links = control
          ? { url: vnc.url }
          : { view_url: vnc.view_url, embed_url: vnc.embed_url };
        if (!Object.values(links).some(Boolean)) {
          return refused(
            `The platform is holding desktop credentials for ${id} but sent no ${control ? 'control' : 'watch-only'} URL among them. ${control ? 'Ask without control: true for the watch-only link.' : 'Try again in a moment, or ask with control: true.'}`,
          );
        }
        return control
          ? said(
              'Full control — keyboard and pointer, but NOT the clipboard: the platform does not run the ' +
                'channel QEMU carries VNC cut text on, so text pasted into this socket is dropped silently ' +
                'and telling somebody to paste into it does not work. Move text with run_command and ' +
                'desktop: true instead. Reading is `xclip -o -selection clipboard`. A write needs BOTH ' +
                'setsid, so the holder outlives the command (an X selection belongs to a live process), ' +
                'and the output redirected, or the resident xclip holds the pipe the guest agent is ' +
                'reading and the command runs to its full timeout before answering. Send the text base64 ' +
                'rather than quoted — an apostrophe in what you are pasting would end the shell word — ' +
                'and poll rather than reading straight back, because being granted a selection is ' +
                'asynchronous and the next read can still be the old clipboard — bounded, a few seconds, ' +
                "since the redirection also swallows xclip's own errors and a guest without it never " +
                'changes the selection at all. Quote the base64 exactly as shown: GNU base64 wraps at 76 ' +
                'columns, and inside the quotes those newlines are harmless (base64 -d takes them) while ' +
                'UNQUOTED one of them would end the pipeline and leave an empty clipboard behind a ' +
                'command that answered 200. ' +
                "`printf %s '<BASE64>' | base64 -d | setsid xclip -selection clipboard >/dev/null 2>&1 &`. " +
                'Treat this link as a password for that desktop; it ends when the computer restarts.',
              links,
            )
          : said(
              'Watch-only. The platform drops input on this socket, so it is safe to hand to somebody.',
              links,
            );
      }),
  );

  // Making and destroying machines. Registered by default — a one-line install
  // that cannot produce a desktop is not much of a demo — and absent rather
  // than present-and-refusing when an operator turns them off, because a tool a
  // model can see is a tool it will try. See ToolOptions.lifecycle.
  if (!opts.lifecycle) return;

  server.registerTool(
    'create_computer',
    {
      title: 'Create a computer',
      description:
        'Build a new cloud desktop and select it for this session. Creating and running a computer costs money on this account.',
      inputSchema: {
        name: z.string().optional().describe('A label. The platform picks one if you do not.'),
        size: z
          .string()
          .optional()
          .describe(
            'A named size from list_sizes, e.g. "large" — the fast path, since these are the shapes the platform keeps pre-booted. It sets template, cpu, ram_mb and disk_gb together, so send it alone or the explicit fields alone, never both.',
          ),
        template: z
          .string()
          .optional()
          .describe(
            'From list_templates, e.g. "base" for Linux/Xfce. Defaults to the platform default.',
          ),
        cpu: z.number().int().min(1).optional(),
        ram_mb: z.number().int().min(512).optional(),
        disk_gb: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "The template's own disk is a FLOOR, not a default — read it from list_templates. A smaller number is raised to it silently and the account is charged the raised figure, so asking for less than the template needs spends more of the plan's disk pool than the number here suggests and can be refused outright.",
          ),
        resolution: z
          .string()
          .optional()
          .describe(
            'WIDTHxHEIGHT or WIDTHxHEIGHTxDEPTH, 640x480 to 3840x2160, even numbers. Create-time only — the display is a QEMU property and there is no route that changes it later. Defaults to 1280x800x24.',
          ),
        start: z.boolean().optional().describe('Boot it immediately. True by default.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    (args, extra) =>
      guarded(async () => {
        const c = unwrapComputer(
          await session.api
            .with(extra.signal)
            .json('POST', P.COMPUTERS, { body: P.createBody(args) }),
        );
        // Selection and the sentence claiming it are the same decision. Bound
        // conditionally and reported unconditionally, a create that came back
        // without an id left this session pointing at whatever it held before
        // while telling the model the new machine was selected — so the next
        // call drove the old computer, or none.
        if (!c.id) {
          return refused(
            `Created ${describe(c)}, but the platform sent no id back, so nothing was selected and this session is still bound to whatever it was before. The machine may exist and be billable — list_computers will say.`,
            withoutCredentials(c),
          );
        }
        session.bind(c.id, c.resolution);
        // A create whose guest was made and then would not boot is not an
        // error: the machine exists and is billable, so it comes back stopped
        // with the reason on it. Saying so plainly is the difference between a
        // model retrying the start and a model creating a second computer.
        const note = c.start_error
          ? `Created ${describe(c)}, but it did not start: ${c.start_error}\nThe computer exists and is selected. start_computer often works on a second attempt.`
          : `Created and selected ${describe(c)}.`;
        return said(note, withoutCredentials(c));
      }),
  );

  server.registerTool(
    'clone_computer',
    {
      title: 'Clone a computer',
      description:
        'Copy a computer to a new one — the fork half of snapshot-and-fork. The copy inherits the resolution, because its disk carries a desktop laid out at that size.',
      inputSchema: {
        ...idArg,
        name: z.string().optional().describe('A name for the copy.'),
      },
    },
    ({ computer_id, name }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const c = unwrapComputer(
          await session.api.with(extra.signal).json('POST', P.computerAction(id, 'clone'), {
            body: name === undefined ? {} : { name },
          }),
        );
        if (!c.id) {
          return refused(
            `The platform accepted the clone of ${id} but sent no id back, so the copy cannot be identified. It may exist and be billable — list_computers will say. The original stays selected.`,
            withoutCredentials(c),
          );
        }
        return said(
          `Cloned ${id} to ${describe(c)}. The original stays selected; use_computer to switch.`,
          withoutCredentials(c),
        );
      }),
  );

  server.registerTool(
    'delete_computer',
    {
      title: 'Delete a computer',
      description:
        'Destroy a computer and its disk. Irreversible. Its snapshots are kept by default and become orphans, which can still be cloned but not restored. To destroy those too, read snapshot_holdings first and pass its fingerprint as `expect`.',
      inputSchema: {
        computer_id: z
          .string()
          .describe(
            'Required in full, even when one is selected — a delete is not a call to infer a target for.',
          ),
        confirm: z
          .literal(true)
          .describe('Must be true. This destroys the disk and everything on it.'),
        delete_snapshots: z
          .boolean()
          .default(false)
          .describe(
            'Also destroy every snapshot of this computer. Requires `expect`. Opt-in because the wrong answer here is unrecoverable: a snapshot kept by mistake costs storage, one destroyed by mistake costs the disk it was the last copy of.',
          ),
        expect: z
          .string()
          .optional()
          .describe(
            'The fingerprint from snapshot_holdings. The purge is refused unless it still names the same set, so a capture that finished after you looked cannot be swept up in a decision that was never about it.',
          ),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ computer_id, delete_snapshots, expect }, extra) =>
      guarded(async () => {
        // The platform makes `expect` optional, for callers that cannot read the
        // holdings and so were never shown a set to be held to. An MCP caller
        // can read them — snapshot_holdings is right there — so here it is
        // required, and the refusal names the tool that produces it.
        //
        // Not fetched on the caller's behalf, which was the tempting shortcut
        // and is the wrong one. A fingerprint read a millisecond before the
        // delete binds the purge to whatever the set is now, not to what anyone
        // agreed to — and the race checkExpectation exists for is exactly that:
        // a capture that finishes between the decision and the click, then gets
        // destroyed by a confirmation that predates it.
        const fingerprint = expect?.trim() || undefined;
        if (delete_snapshots && !fingerprint) {
          return refused(
            'Refusing to purge snapshots without a fingerprint. Call snapshot_holdings on this computer, ' +
              'check that the count and size are what you meant to destroy, and pass its fingerprint as `expect`. ' +
              'Nothing has been deleted.',
          );
        }
        const res = await session.api
          .with(extra.signal)
          .send<{ snapshots_deleted?: number }>('DELETE', P.computer(computer_id), {
            query: {
              snapshots: delete_snapshots ? 'delete' : undefined,
              expect: delete_snapshots ? fingerprint : undefined,
            },
          });
        session.unbind(computer_id);
        // A count only when the platform sent one. `?? 0` here would turn "it
        // did not say" into the affirmative claim that nothing was destroyed —
        // a false statement about an irreversible act, in the tool that goes to
        // the most trouble of any here not to misrepresent one.
        const purged =
          res?.snapshots_deleted === undefined
            ? 'its snapshots'
            : `${res.snapshots_deleted} of its snapshot(s)`;
        return said(
          delete_snapshots
            ? `Deleted ${computer_id} and ${purged}.`
            : `Deleted ${computer_id}. Its disk is gone; any snapshots it had remain, as orphans that can be cloned but not restored.`,
        );
      }),
  );
};
