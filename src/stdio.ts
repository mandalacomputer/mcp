import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
  console.error(
    `mandala-computer-mcp on stdio → ${new URL(cfg.baseUrl ?? 'https://app.mandala.computer/api/v1').origin}`,
  );
}
