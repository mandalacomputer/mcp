import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_BASE_URL } from './api.js';
import { createServer, type ServerConfig } from './server.js';

/**
 * The local install: one process, one key, spawned by the MCP client.
 *
 * Nothing is hosted and nothing is operated — the client starts this as a
 * subprocess and talks to it over stdin and stdout. Which is also why nothing
 * here may ever write to stdout: that stream is the protocol, and one stray
 * console.log is a parse error at the other end. Diagnostics go to stderr.
 */
export async function runStdio(cfg: ServerConfig): Promise<void> {
  const server = createServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The end of the client, and therefore the end of this process.
  //
  // The SDK's transport does not do it. `StdioServerTransport.start()` registers
  // `data` and `error` on stdin and nothing else, so stdin reaching EOF — the
  // ordinary way an MCP client goes away, since it closes the pipe rather than
  // sending a shutdown — never calls `close()`, never fires the server's
  // `onclose`, and so never runs the `session.events.closeAll()` that
  // `createServer` hangs there. The HTTP transport was given that teardown in so
  // many words; stdio had nothing.
  //
  // What is left behind is not a tidiness problem. A `poll_events` opens a
  // websocket to the platform that outlives the tool call by design, and an open
  // socket holds the event loop by itself — so the process stays up after its
  // client is gone, reconnecting and talking to the platform with the user's
  // API key, until something kills it. Measured: a child was still alive and
  // still holding the socket ten seconds after its stdin closed.
  //
  // `once` on both spellings because they are not the same event and either can
  // be the one that arrives: `end` is the stream reaching EOF, `close` is the
  // handle going away, and a pipe whose writer dies can produce the second
  // without the first. `server.close()` closes the transport, which is what
  // reaches `onclose`.
  const shutdown = () => void server.close().catch(() => {});
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  console.error(
    `mandala-computer-mcp on stdio → ${new URL(cfg.baseUrl ?? DEFAULT_BASE_URL).origin}`,
  );
}
