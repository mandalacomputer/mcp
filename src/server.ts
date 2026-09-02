import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Session, type SessionConfig } from './session.js';
import { registerAgent } from './tools/agent.js';
import { registerComputers } from './tools/computers.js';
import { registerEvents } from './tools/events.js';
import { registerGuest } from './tools/guest.js';
import { registerInput } from './tools/input.js';
import { registerSnapshots } from './tools/snapshots.js';
import { registerTemplates } from './tools/templates.js';
import type { ToolOptions } from './tools/types.js';
import { registerWebhooks } from './tools/webhooks.js';

export const SERVER_NAME = 'mandala-computer';
export const SERVER_VERSION = '0.1.1';

/**
 * Told to the client on connect, and shown to the model before any tool is
 * called. It is the only place to say the things that are true of the whole
 * server rather than of one tool — chiefly that a screenshot is how you find
 * out what happened, because nothing on a desktop reports back on its own.
 *
 * Built from `lifecycle` rather than written out flat, because under
 * MANDALA_NO_LIFECYCLE `create_computer` is not registered at all — and the
 * reason it is withheld rather than left to refuse is that a tool a model can
 * see is a tool it will try. Naming it in the very first line of the
 * instructions gave the model the same idea by a different route, in the one
 * text it reads before it has a tool list to check against.
 */
const instructions = (lifecycle: boolean) =>
  `Mandala Computer gives you a real Linux desktop in the cloud that you can see and drive.

How to work with one:

1. ${lifecycle ? 'use_computer (or create_computer) binds' : 'use_computer binds'} a machine to this session. Every other tool then leaves computer_id out.
2. wait_for_computer with until="guest" before the first screenshot or exec. A computer that reports "running" is a VM the hypervisor has started; the desktop inside it comes up seconds later.
3. screenshot, look, act, screenshot again. The desktop does not tell you whether a click landed — the only way to know is to look. Take a fresh screenshot after anything you expect to change the screen.
4. Coordinates are the pixels of the full-size screenshot, and the screen size is on the computer record as "resolution".

Things that are true here and are not obvious:

- exec runs as root with NO display. A GUI application started without desktop: true cannot draw. open_url is the reliable way to put a web page on the screen.
- Anything slower than a few seconds wants exec with background: true — a build or an install run in the foreground comes back as a timeout with the work still going and its output unreadable. Sixteen of them run at once per computer, and a slot is held until its command exits; exec_kill on a pid you no longer need is what frees one.
- The computer says what it is doing, so you do not have to look in order to find out. wait_for_event blocks until something is reported — a background command exiting, a window opening, the desktop coming up, the machine going idle — and poll_events hands you whatever was reported while you were busy with something else. The stream is held open between your turns, so nothing that happens between two calls is missed and a wait that times out has cost you nothing. Use these in place of a screenshot loop: a screenshot is for seeing what the screen LOOKS like, not for finding out whether anything changed.
- Waiting for a FILE is its own call, because a directory has to be nominated before the machine reports anything under it: wait_for_file_change takes an absolute directory in the guest, makes sure the guest is genuinely watching it, and then blocks until something under it is created, changed or deleted. Use it for a build's output or a download landing, in place of running ls in a loop. Nominate the narrowest directory you care about — a home directory under a build reports one "too much changed" marker instead of the changes — and read that marker as "list the directory again", not as a failure.
- list_windows tells you what is on the screen as data. It is how you distinguish an application that failed to start from one that has not painted yet, which a screenshot alone cannot do.
- A computer suspends itself when nobody uses it — 30 minutes by default. Input, exec and file transfers all count as use and resume it. Screenshots deliberately do not, so a loop that only watches can see its own machine go down.
- A 409 is not one thing, and retrying blindly is how a turn gets burned. Most describe a passing state and clear on their own: a guest still booting, a guest agent busy with another call. Some describe a DECISION about what you asked for — a size the host cannot run, a computer that has to be stopped first — and those answer the same way forever; the message says which, and usually says what to do instead. A 400 never clears.
- Growing a computer past what its host can run is the refusal worth knowing by name: update_computer says a move is possible, and move_computer is how you take that up. It moves the machine to different hardware and copies its disk, so say what it costs before you call it.`;

export type ServerConfig = SessionConfig &
  Partial<ToolOptions> & {
    /** Internal HTTP hook: hold a session active for the real tool callback lifetime. */
    activity?: () => () => void;
  };

/**
 * One MCP server over one account's API key.
 *
 * Built per session rather than once per process, because the HTTP transport
 * gives every caller their own key and their own selected computer. The stdio
 * transport builds exactly one and that is the same thing with n=1.
 */
export function createServer(cfg: ServerConfig): McpServer {
  const session = new Session(cfg);
  const opts: ToolOptions = { lifecycle: cfg.lifecycle ?? true };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} }, instructions: instructions(opts.lifecycle) },
  );

  // A cancelled Streamable HTTP response can let transport.handleRequest()
  // settle while the tool callback is still awaiting platform work. Wrap tool
  // registration once so the HTTP session lease follows that real lifetime.
  // Stdio has no hook and pays no cost beyond this branch.
  if (cfg.activity) {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    server.registerTool = ((...args: unknown[]) => {
      const handlerIndex = args.length - 1;
      const handler = args[handlerIndex] as (...handlerArgs: unknown[]) => unknown;
      args[handlerIndex] = async (...handlerArgs: unknown[]) => {
        const release = cfg.activity?.();
        try {
          return await handler(...handlerArgs);
        } finally {
          release?.();
        }
      };
      return register(...args);
    }) as typeof server.registerTool;
  }

  registerComputers(server, session, opts);
  registerInput(server, session, opts);
  registerGuest(server, session, opts);
  registerSnapshots(server, session, opts);
  registerTemplates(server, session, opts);
  registerEvents(server, session, opts);
  registerWebhooks(server, session, opts);
  registerAgent(server, session, opts);

  // The event sockets outlive every tool call by design (OPL-3926), so nothing
  // in a tool can be the thing that closes them. This is the end of the
  // session, which is the lifetime they actually have — without it an HTTP
  // transport whose client went away leaves a websocket per computer open,
  // reconnecting, for as long as the process lives.
  const closed = server.server.onclose;
  server.server.onclose = () => {
    session.events.closeAll();
    closed?.();
  };

  return server;
}
