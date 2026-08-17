import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from '../session.js';

/** Knobs that change which tools exist, rather than what they do. */
export type ToolOptions = {
  /**
   * Whether this server may make and destroy computers.
   *
   * A knob rather than a constant because creation from inside an agent loop is
   * where a runaway turns into an invoice. The tools are registered by default —
   * a one-line install that cannot produce a desktop is not much of a demo — but
   * an operator standing this up for somebody else can turn them off, and then
   * they are absent from the tool list rather than present and refusing. A tool
   * a model can see is a tool it will try.
   */
  lifecycle: boolean;
};

export type Registrar = (server: McpServer, session: Session, opts: ToolOptions) => void;
