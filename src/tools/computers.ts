import { z } from 'zod';
import { isTransient } from '../errors.js';
import { describe, guarded, json, said, unwrapComputer, withoutCredentials } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const POWER_DESCRIPTIONS: Record<string, string> = {
  start:
    'Boot a computer, or resume a suspended one — a resume restores the saved session, same processes and windows, in about a second.',
  stop: 'Shut a computer down. Discards a saved session if there is one. The disk is kept.',
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
    () => guarded(async () => json(await session.api.json('GET', P.TEMPLATES))),
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
            'Accept a short list when a hypervisor cannot be reached. Off by default: a short list reads exactly like the missing computers were deleted.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ allow_partial }) =>
      guarded(async () => {
        const list =
          (await session.api.json<unknown[]>('GET', P.COMPUTERS, {
            query: { allow_partial: allow_partial ? 1 : undefined },
          })) ?? [];
        if (!list.length) {
          return said(
            'No computers on this account yet. create_computer makes one; list_templates says what from.',
          );
        }
        const lines = list.map((c) => `- ${describe(c as never)}`).join('\n');
        return said(
          `${list.length} computer(s):\n${lines}`,
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
    ({ computer_id }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const c = unwrapComputer(await session.api.json('GET', P.computer(id)));
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
    ({ computer_id }) =>
      guarded(async () => {
        // Read it before binding. Binding an id the platform does not recognise
        // would send every subsequent call to a 404 with no clue why, and the
        // read costs one round trip against a session that will make hundreds.
        const c = unwrapComputer(await session.api.json('GET', P.computer(computer_id)));
        session.bind(computer_id, c.resolution);
        return said(
          `Selected ${describe(c)}. Later calls need no computer_id.` +
            (c.status === 'running'
              ? ''
              : `\n\nIt is ${c.status ?? 'not running'} — start_computer before driving it.`),
          withoutCredentials(c),
        );
      }),
  );

  // Power. Not behind the lifecycle gate: a server that may only attach to
  // computers somebody else made still has to be able to bring one up, and a
  // stopped computer refuses every other tool here.
  for (const action of ['start', 'stop', 'suspend', 'restart'] as const) {
    server.registerTool(
      `${action}_computer`,
      {
        title: `${action[0].toUpperCase()}${action.slice(1)} a computer`,
        description: POWER_DESCRIPTIONS[action],
        inputSchema: { ...idArg },
      },
      ({ computer_id }) =>
        guarded(async () => {
          const id = session.resolve(computer_id);
          const c = unwrapComputer(await session.api.json('POST', P.computerAction(id, action)));
          session.noteResolution(id, c.resolution);
          return said(`${action}: ${describe(c)}`, withoutCredentials(c));
        }),
    );
  }

  server.registerTool(
    'update_computer',
    {
      title: 'Rename or resize a computer',
      description:
        "Change a computer's name, its size, or its idle window. The platform refuses these in combination on purpose — a resize needs the computer stopped and the other two do not, so one request cannot honour both without applying half of it.",
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
          .nullable()
          .optional()
          .describe(
            "Minutes untouched before the host suspends it. null follows the host's own window; send this on its own.",
          ),
      },
    },
    ({ computer_id, ...fields }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        // `null` is meaningful for idle_suspend_min and must survive the filter;
        // every other absent field is dropped so the platform leaves it alone.
        const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        if (!Object.keys(body).length) {
          return said(
            'Nothing to change — give at least one of name, cpu, ram_mb, disk_gb, idle_suspend_min.',
          );
        }
        const c = unwrapComputer(await session.api.json('PATCH', P.computer(id), { body }));
        session.noteResolution(id, c.resolution);
        return said(describe(c), withoutCredentials(c));
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
    ({ computer_id, until, timeout_s }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const deadline = Date.now() + timeout_s * 1000;
        let last = '';
        while (Date.now() < deadline) {
          const c = unwrapComputer(await session.api.json('GET', P.computer(id)));
          session.noteResolution(id, c.resolution);
          last = c.status ?? 'unknown';
          if (last === 'build-failed') {
            return said(
              `Build failed: ${c.build?.source ?? 'no detail given'}. This does not resolve on its own.`,
              c,
            );
          }
          // Neither of the next two resolves on its own, so spinning on either
          // burns the whole timeout waiting for something nobody is going to do.
          if (last === 'suspended') {
            return said(
              `${id} is suspended, and that state does not clear by itself. start_computer resumes the saved session in about a second.`,
              c,
            );
          }
          if (last === 'stopped') {
            return said(`${id} is stopped. start_computer boots it.`, c);
          }
          if (last === 'running') {
            if (until === 'running') return said(`Running: ${describe(c)}`, c);
            // "The guest is up" is not a status the platform reports, so it is
            // asked rather than waited for: a trivial exec either answers, or
            // refuses with the 409 that says the agent is not up yet.
            try {
              await session.api.json('POST', P.computerAction(id, 'exec'), {
                body: P.execBody({ command: 'true', timeout_s: 5 }),
              });
              return said(`Guest is answering: ${describe(c)}`, c);
            } catch (err) {
              if (!isTransient(err)) throw err;
            }
          }
          await sleep(2000);
        }
        return said(
          `Gave up after ${timeout_s}s; ${id} was last seen ${last}. Nothing was changed — call again to keep waiting.`,
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
    ({ computer_id, control }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const c = unwrapComputer(await session.api.json('GET', P.computer(id)));
        const vnc = c.vnc as Record<string, string> | undefined;
        if (!vnc) {
          return said(
            `No desktop credentials on ${id} right now. The platform omits them when the computer is not running, or when its hypervisor could not be reached — a URL built over nothing looks exactly like a working one until it is used.`,
          );
        }
        return control
          ? said(
              'Full control — keyboard, pointer and clipboard. Treat this link as a password for that desktop; it ends when the computer restarts.',
              { url: vnc.url },
            )
          : said(
              'Watch-only. The platform drops input on this socket, so it is safe to hand to somebody.',
              { view_url: vnc.view_url, embed_url: vnc.embed_url },
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
        template: z
          .string()
          .optional()
          .describe(
            'From list_templates, e.g. "base" for Linux/Xfce. Defaults to the platform default.',
          ),
        cpu: z.number().int().min(1).optional(),
        ram_mb: z.number().int().min(512).optional(),
        disk_gb: z.number().int().min(1).optional(),
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
    (args) =>
      guarded(async () => {
        const c = unwrapComputer(
          await session.api.json('POST', P.COMPUTERS, { body: P.createBody(args) }),
        );
        if (c.id) session.bind(c.id, c.resolution);
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
    ({ computer_id, name }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const c = unwrapComputer(
          await session.api.json('POST', P.computerAction(id, 'clone'), {
            body: name === undefined ? {} : { name },
          }),
        );
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
        'Destroy a computer and its disk. Irreversible. Its snapshots are deliberately kept and become orphans, which can still be cloned but not restored.',
      inputSchema: {
        computer_id: z
          .string()
          .describe(
            'Required in full, even when one is selected — a delete is not a call to infer a target for.',
          ),
        confirm: z
          .literal(true)
          .describe('Must be true. This destroys the disk and everything on it.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ computer_id }) =>
      guarded(async () => {
        await session.api.json('DELETE', P.computer(computer_id));
        session.unbind(computer_id);
        return said(`Deleted ${computer_id}. Its disk is gone; any snapshots it had remain.`);
      }),
  );
};
