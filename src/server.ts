import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  type JSONRPCMessage,
  ListToolsRequestSchema,
  McpError,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Session, type SessionConfig } from './session.js';
import { type ToolFilters, toolFilter } from './tool-filters.js';
import { registerAccount } from './tools/account.js';
import { registerActivities } from './tools/activities.js';
import { RUN_AGENT_ANNOTATIONS, registerAgent } from './tools/agent.js';
import { registerArtifacts } from './tools/artifacts.js';
import { registerChat } from './tools/chat.js';
import { registerComputers } from './tools/computers.js';
import { registerCredentialGateway } from './tools/credentialgateway.js';
import { registerCredits } from './tools/credits.js';
import { registerDirectory } from './tools/directory.js';
import { registerEvents } from './tools/events.js';
import { registerExecutions } from './tools/executions.js';
import { registerGuest } from './tools/guest.js';
import { registerInput } from './tools/input.js';
import { registerOperations } from './tools/operations.js';
import { registerPublicUrls } from './tools/publicurls.js';
import { registerResults } from './tools/results.js';
import { registerRuns } from './tools/runs.js';
import { registerSecrets } from './tools/secrets.js';
import { registerSignals } from './tools/signals.js';
import { registerSnapshots } from './tools/snapshots.js';
import { registerSSH } from './tools/ssh.js';
import { registerTemplates } from './tools/templates.js';
import { registerThreads } from './tools/threads.js';
import type { ToolOptions } from './tools/types.js';
import { registerWebhooks } from './tools/webhooks.js';
import { SERVER_VERSION } from './version.js';

export { SERVER_VERSION };
export const SERVER_NAME = 'mandala-computer';

/**
 * The most array elements and object members one tool call's arguments may
 * hold, counted before any schema runs.
 *
 * A schema only bounds what it declares: an array with no maximum, and every
 * element of it that is wrong, is validated in full and leaves an issue per
 * element, so a body of millions of small invalid entries cost far more to
 * refuse than it cost to send. Over HTTP one process serves every session. The
 * largest legitimate arguments are a chat transcript, and the platform refuses
 * one over 1 MiB, which no ordinary transcript fills with this many.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 100_000;

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

1. ${lifecycle ? 'use_computer (or create_computer) binds' : 'use_computer binds'} a machine to this session. Most computer tools can then leave computer_id out; workspace moves require it explicitly.
2. wait_for_computer with until="guest" before the first screenshot or exec. A computer that reports "running" is a VM the hypervisor has started; the desktop inside it comes up seconds later.
3. screenshot, look, act, screenshot again. The desktop does not tell you whether a click landed — the only way to know is to look. Take a fresh screenshot after anything you expect to change the screen.
4. Coordinates are the pixels of the full-size capture. Use the capture size returned with screenshot; it can differ from the computer record's "resolution". To crop a frame you measured, pass its capture name with region. If it has expired, take a new screenshot and remeasure the region.

Things that are true here and are not obvious:

- exec runs as root with NO display. A GUI application started without desktop: true cannot draw. open_url is the reliable way to put a web page on the screen.
- Anything slower than a few seconds wants exec with background: true — a build or an install run in the foreground comes back as a timeout with the work still going and its output unreadable. Sixteen of them run at once per computer, and a slot is held until its command exits; exec_kill on a pid you no longer need is what frees one.
- The computer says what it is doing, so you do not have to look in order to find out. wait_for_event blocks until something is reported — a background command exiting, a window opening, the desktop coming up, the machine going idle — and poll_events hands you whatever was reported while you were busy with something else. The stream is held open between your turns, so nothing that happens between two calls is missed and a wait that times out has cost you nothing. Use these in place of a screenshot loop: a screenshot is for seeing what the screen LOOKS like, not for finding out whether anything changed.
- Waiting for a FILE is its own call, because a directory has to be nominated before the machine reports anything under it: wait_for_file_change takes an absolute directory in the guest, makes sure the guest is genuinely watching it, and then blocks until something under it is created, changed or deleted. Use it for a build's output or a download landing, in place of running ls in a loop. Nominate the narrowest directory you care about — a home directory under a build reports one "too much changed" marker instead of the changes — and read that marker as "list the directory again", not as a failure.
- list_windows tells you what is on the screen as data. It is how you distinguish an application that failed to start from one that has not painted yet, which a screenshot alone cannot do.
- A computer suspends itself when nobody uses it — 30 minutes by default. Input, exec and file transfers all count as use and resume it. Screenshots deliberately do not, so a loop that only watches can see its own machine go down.
- Who you are is checked again while a call is in flight, not only when it starts, so a long call can be refused after part of its work is already done. A 401 or a 403 means the credential or the role behind it stopped being accepted: re-authenticate, or say what was refused. Do not resend it, and never resend one that creates, starts, moves, writes or deletes without first checking what took effect. A 402 is the plan as it stands now rather than a fault on the computer, and waiting does not change it. Any of the three can arrive with completed work attached — read that before deciding what is left to do.
- A 409 is not one thing, and retrying blindly is how a turn gets burned. Some describe a passing state and clear on their own — a guest still booting, a guest agent busy with another call — and the answer says so. The rest describe a DECISION about what you asked for — a size the host cannot run, a computer that has to be stopped first, a label already taken — and those answer the same way forever. A 409 that does not say it will clear is one of those: read the message, which usually says what to do instead, rather than sending it again. A 400 never clears.
- Growing a computer past what its host can run is the refusal worth knowing by name: update_computer says a move is possible, and move_computer is how you take that up. It moves the machine to different hardware and copies its disk, so say what it costs before you call it.`;

const filteredInstructions = `Mandala Computer gives you access to a Linux desktop in the cloud.

This session exposes a filtered set of tools. Use only the tools in its tool list; some desktop workflows may be unavailable. Pass computer_id explicitly on computer-specific calls unless a computer was already bound to this session. A running VM does not imply that its guest desktop is ready.

Read each available tool's description before calling it. Read-only access follows the tool's readOnlyHint annotation: a read that can resume a computer is not read-only. A running computer consumes running capacity, and passive observation does not prevent idle suspension.

Who you are is checked again while a call is in flight. A 401 or 403 means the credential or role stopped being accepted; a 402 means the current plan refuses the work. Do not resend these calls. Inspect any completed work attached before deciding what remains. A 409 may describe either a temporary condition or a decision that will not change on retry; read its message, and treat one that does not say it will clear as one that will not. A 400 never clears.`;

/**
 * Whether a session built from this config would offer run_agent on the
 * account's AI credits, if `GET /credits` said they could pay (OPL-5866) — and
 * so whether that read is worth making at all. Not with a model key, which
 * always wins, and not when the filters withhold run_agent anyway.
 */
export function offersFundedAgent(cfg: ToolFilters & { modelKey?: string }): boolean {
  return !cfg.modelKey && toolFilter(cfg).allows('run_agent', RUN_AGENT_ANNOTATIONS);
}

/**
 * A tool's input schema, made to refuse any key it does not declare.
 *
 * The SDK accepts either a field map or a Zod schema. A field map becomes an
 * object that strips unknown keys, and so does a plain `z.object`: the listed
 * JSON Schema still says `additionalProperties: false`, but the call goes
 * ahead with the unknown key silently dropped. That turned a misspelt
 * `workspace_id` into a secret stored account-wide, a misspelt `resume_only`
 * into a full start, and a misspelt flag on a delete into a delete. Every schema leaves here strict.
 *
 * Anything that cannot be made strict here is refused at registration, so a
 * tool added later cannot reintroduce the stripping by its shape: a schema that
 * is not an object, and one that passes unknown keys through or has a
 * catch-all. A refined object is still an object, and making it strict keeps
 * its refinements.
 */
export function strictInput(name: string, schema: unknown): z.ZodType {
  if (schema === undefined) {
    throw new Error(`Tool ${name} declares no input schema; give it one, even if empty.`);
  }
  if (!(schema instanceof z.ZodType)) {
    return z.strictObject(schema as z.ZodRawShape);
  }
  if (schema instanceof z.ZodObject) {
    // A strict object's catch-all is `never`; a loose one's is `unknown`; a
    // stripping one has none.
    const { catchall } = schema._zod.def;
    if (catchall instanceof z.ZodNever) return schema;
    if (catchall instanceof z.ZodUnknown) {
      throw new Error(`Tool ${name}'s input schema passes unknown keys through.`);
    }
    if (catchall !== undefined) {
      throw new Error(`Tool ${name}'s input schema has a catch-all; it must refuse unknown keys.`);
    }
    // The method rather than z.strictObject(schema.shape): it copies the whole
    // definition, refinements included, where rebuilding from the shape would
    // drop them.
    return schema.strict();
  }
  throw new Error(`Tool ${name}'s input schema must be a strict object.`);
}

/**
 * The refusal for a `tools/call` whose arguments carry an own `__proto__` key,
 * or `undefined` for any other message.
 *
 * The one undeclared argument {@link strictInput} never sees: the SDK parses
 * the request envelope before any tool schema runs, and that parse drops a
 * top-level `__proto__` key without a word, so a call carrying one went ahead
 * as though it had not (Codex, round 5 on #213). Refused here, before the SDK,
 * in the words the SDK uses for every other unknown argument. Only for a tool
 * this session registers: anything else gets the SDK's own answer.
 */
export function protoKeyRefusal(
  message: JSONRPCMessage,
  registered: ReadonlySet<string>,
): JSONRPCMessage | undefined {
  const m = message as { method?: unknown; id?: unknown; params?: unknown };
  if (m.method !== 'tools/call' || (typeof m.id !== 'string' && typeof m.id !== 'number'))
    return undefined;
  const params = m.params as { name?: unknown; arguments?: unknown } | null | undefined;
  if (!params || typeof params !== 'object') return undefined;
  const { name, arguments: args } = params;
  if (typeof name !== 'string' || !registered.has(name)) return undefined;
  if (!args || typeof args !== 'object' || !Object.hasOwn(args, '__proto__')) return undefined;
  return {
    jsonrpc: '2.0',
    id: m.id,
    result: {
      content: [
        {
          type: 'text',
          text: `MCP error ${ErrorCode.InvalidParams}: Input validation error: Invalid arguments for tool ${name}: Unrecognized key: "__proto__"`,
        },
      ],
      isError: true,
    },
  };
}

/** Array elements plus object members in `value`, counting no further than one past `max`. */
function elementCount(value: unknown, max: number): number {
  let count = 0;
  const stack = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    // for...in rather than Object.values, which would copy every member of a
    // huge object before the count could stop.
    if (Array.isArray(node)) {
      for (const child of node) {
        if (++count > max) return count;
        if (child !== null && typeof child === 'object') stack.push(child);
      }
      continue;
    }
    for (const key in node) {
      if (!Object.hasOwn(node, key)) continue;
      if (++count > max) return count;
      const child = (node as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') stack.push(child);
    }
  }
  return count;
}

/**
 * Whether the `tools/call` requests in an HTTP batch hold more than
 * {@link MAX_TOOL_INPUT_ELEMENTS} argument elements between them.
 *
 * Each call is counted on its own as it arrives, but a batch's calls are all
 * dispatched before any is answered, so their validations run side by side:
 * a hundred calls just under the budget cost a hundred times what one is
 * allowed to. The whole batch is held to the one budget instead.
 */
export function batchOverBudget(messages: readonly unknown[]): boolean {
  let left = MAX_TOOL_INPUT_ELEMENTS;
  for (const message of messages) {
    const m = message as { method?: unknown; params?: unknown } | null;
    if (!m || typeof m !== 'object' || m.method !== 'tools/call') continue;
    const params = m.params as { arguments?: unknown } | null | undefined;
    if (!params || typeof params !== 'object') continue;
    left -= elementCount(params.arguments, left);
    if (left < 0) return true;
  }
  return false;
}

/**
 * The refusal for a `tools/call` whose arguments hold more than
 * {@link MAX_TOOL_INPUT_ELEMENTS} elements, or `undefined` for any other
 * message.
 *
 * The SDK applies the same budget, but only once it has parsed the request
 * envelope twice, and that parse visits and copies every top-level argument,
 * so a flat object of millions of keys was paid for in full before the budget
 * refused it. Counted here, before the SDK, in the SDK's own words. Any tool
 * name, registered or not: the envelope is parsed before the name is looked up.
 */
export function oversizedArgumentsRefusal(message: JSONRPCMessage): JSONRPCMessage | undefined {
  const m = message as { method?: unknown; id?: unknown; params?: unknown };
  if (m.method !== 'tools/call' || (typeof m.id !== 'string' && typeof m.id !== 'number'))
    return undefined;
  const params = m.params as { name?: unknown; arguments?: unknown } | null | undefined;
  if (!params || typeof params !== 'object') return undefined;
  if (elementCount(params.arguments, MAX_TOOL_INPUT_ELEMENTS) <= MAX_TOOL_INPUT_ELEMENTS)
    return undefined;
  // Nothing has checked the name yet, and coercing an object to a string can
  // throw, which would take the rest of an HTTP batch down with this answer.
  const tool = typeof params.name === 'string' ? `tool ${params.name}` : 'this tool call';
  return {
    jsonrpc: '2.0',
    id: m.id,
    result: {
      content: [
        {
          type: 'text',
          text: `MCP error ${ErrorCode.InvalidParams}: Invalid arguments for ${tool}: arguments contain more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
        },
      ],
      isError: true,
    },
  };
}

export type ServerConfig = SessionConfig &
  ToolFilters &
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
  const filter = toolFilter(cfg);
  const session = new Session(cfg);
  const opts: ToolOptions = { lifecycle: cfg.lifecycle ?? true };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { logging: {}, tools: {} },
      instructions: filter.filtered ? filteredInstructions : instructions(opts.lifecycle),
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
    },
  );

  // A cancelled Streamable HTTP response can let transport.handleRequest()
  // settle while the tool callback is still awaiting platform work. Wrap tool
  // registration once so the HTTP session lease follows that real lifetime.
  // Withheld tools never reach the SDK registry or acquire an activity lease.
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  let registered = false;
  const names = new Set<string>();
  server.registerTool = ((...args: unknown[]) => {
    const [name, config] = args as [
      string,
      { annotations?: ToolAnnotations; inputSchema?: unknown },
    ];
    if (!filter.allows(name, config.annotations)) return;
    // Every tool refuses an argument it does not know (OPL-5975). Done here,
    // once, rather than trusted to each registration, because the SDK turns a
    // plain field map into an object that STRIPS unknown keys while the listed
    // schema says `additionalProperties: false` — so a misspelt flag was
    // dropped and the call went ahead without it.
    args[1] = { ...config, inputSchema: strictInput(name, config.inputSchema) };
    if (cfg.activity) {
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
    }
    // The SDK's own tools/list and tools/call handlers are left in place.
    // From @modelcontextprotocol/sdk 1.32.2 they are installed when the server
    // is constructed (because `tools` is a declared capability) and never
    // again, so removing them here left a fresh install with no tools at all
    // (OPL-6241). Earlier versions install them on this first registration.
    const tool = register(...args);
    registered = true;
    names.add(name);
    return tool;
  }) as typeof server.registerTool;

  registerAccount(server, session, opts);
  registerComputers(server, session, opts);
  registerOperations(server, session, opts);
  registerInput(server, session, opts);
  registerGuest(server, session, opts);
  registerExecutions(server, session, opts);
  registerResults(server, session, opts);
  registerArtifacts(server, session, opts);
  registerSnapshots(server, session, opts);
  registerTemplates(server, session, opts);
  registerEvents(server, session, opts);
  registerWebhooks(server, session, opts);
  registerSSH(server, session, opts);
  registerPublicUrls(server, session, opts);
  registerCredentialGateway(server, session, opts);
  registerSecrets(server, session, opts);
  registerCredits(server, session, opts);
  registerAgent(server, session, opts);
  registerRuns(server, session, opts);
  registerThreads(server, session, opts);
  registerDirectory(server, session, opts);
  registerActivities(server, session, opts);
  registerSignals(server, session, opts);
  registerChat(server, session, opts);

  // The SDK installs its tool handlers either at construction or on the first
  // registration, depending on its version. An empty selection still needs a
  // valid tools/list response and a clear refusal for calls, so these replace
  // whichever the SDK did or did not install.
  if (!registered) {
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    server.server.setRequestHandler(CallToolRequestSchema, () => {
      throw new McpError(ErrorCode.InvalidParams, 'No tools are available in this session');
    });
  }

  // A top-level `__proto__` argument is dropped by the SDK's own parse of the
  // request, before any tool schema can refuse it, and arguments over the
  // element budget are parsed in full before the SDK counts them, so both are
  // refused on the way in (see protoKeyRefusal and oversizedArgumentsRefusal). Wrapped as the transport starts, which is after
  // the server has installed its message handler and before any message.
  const connect = server.connect.bind(server);
  server.connect = (transport: Transport) => {
    const start = transport.start.bind(transport);
    transport.start = async () => {
      const deliver = transport.onmessage;
      if (deliver) {
        transport.onmessage = (message, extra) => {
          const refusal = oversizedArgumentsRefusal(message) ?? protoKeyRefusal(message, names);
          if (refusal) {
            transport.send(refusal).catch(() => undefined);
            return;
          }
          deliver(message, extra);
        };
      }
      return start();
    };
    return connect(transport);
  };

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
