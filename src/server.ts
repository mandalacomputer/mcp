import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Session, type SessionConfig } from './session.js';
import { registerAgent } from './tools/agent.js';
import { registerComputers } from './tools/computers.js';
import { registerGuest } from './tools/guest.js';
import { registerInput } from './tools/input.js';
import { registerSnapshots } from './tools/snapshots.js';
import type { ToolOptions } from './tools/types.js';

export const SERVER_NAME = 'mandala-computer';
export const SERVER_VERSION = '0.1.0';

/**
 * Told to the client on connect, and shown to the model before any tool is
 * called. It is the only place to say the things that are true of the whole
 * server rather than of one tool — chiefly that a screenshot is how you find
 * out what happened, because nothing on a desktop reports back on its own.
 */
const INSTRUCTIONS = `Mandala Computer gives you a real Linux desktop in the cloud that you can see and drive.

How to work with one:

1. use_computer (or create_computer) binds a machine to this session. Every other tool then leaves computer_id out.
2. wait_for_computer with until="guest" before the first screenshot or exec. A computer that reports "running" is a VM the hypervisor has started; the desktop inside it comes up seconds later.
3. screenshot, look, act, screenshot again. The desktop does not tell you whether a click landed — the only way to know is to look. Take a fresh screenshot after anything you expect to change the screen.
4. Coordinates are the pixels of the full-size screenshot, and the screen size is on the computer record as "resolution".

Things that are true here and are not obvious:

- exec runs as root with NO display. A GUI application started without desktop: true cannot draw. open_url is the reliable way to put a web page on the screen.
- Anything slower than a few seconds wants exec with background: true — a build or an install run in the foreground comes back as a timeout with the work still going and its output unreadable.
- list_windows tells you what is on the screen as data. It is how you distinguish an application that failed to start from one that has not painted yet, which a screenshot alone cannot do.
- A computer suspends itself when nobody uses it — 30 minutes by default. Input, exec and file transfers all count as use and resume it. Screenshots deliberately do not, so a loop that only watches can see its own machine go down.
- A 409 usually clears on its own (a guest still booting, a busy guest agent). A 400 never does.`;

export type ServerConfig = SessionConfig & Partial<ToolOptions>;

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
    { capabilities: { logging: {} }, instructions: INSTRUCTIONS },
  );

  registerComputers(server, session, opts);
  registerInput(server, session, opts);
  registerGuest(server, session, opts);
  registerSnapshots(server, session, opts);
  registerAgent(server, session, opts);

  return server;
}
