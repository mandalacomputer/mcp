import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { refused } from '../format.js';

/**
 * The saved profile's default workspace from `mandala workspaces use`, applied
 * to a tool call that leaves `workspace_id` out: the secret tools,
 * create_computer and list_computers, as the TS CLI's `secrets`,
 * `computers create` and `computers list` apply it. Only the local server
 * started from a saved profile has one (see SessionConfig.defaultWorkspace);
 * every other session sees none of this, and its tools behave as before.
 */
export type ScopeSession = {
  readonly defaultWorkspace?: { id: string; name: string } | null;
  readonly defaultWorkspaceUnreadable?: string;
};

/** The three questions a tool asks of a call's workspace_id, for one session. */
export function profileDefault(session: ScopeSession) {
  return {
    /** A left-out workspace_id: the saved profile's default, where there is one. */
    scoped: (workspace_id: string | undefined) =>
      workspace_id ?? session.defaultWorkspace?.id ?? undefined,
    /**
     * A tool that writes, called without workspace_id while defaults.json
     * cannot be read: the profile's default is unknown, and the call would
     * otherwise act account-wide, the widest scope. Refused before any
     * request; the reading tools go on account-wide.
     */
    unknownDefault: (workspace_id: string | undefined): CallToolResult | undefined =>
      workspace_id === undefined && session.defaultWorkspaceUnreadable !== undefined
        ? refused(
            `Nothing was sent: ~/.mandala/defaults.json cannot be read (${session.defaultWorkspaceUnreadable}), so the saved profile's default workspace is unknown and this would otherwise act account-wide. Pass workspace_id explicitly, or fix or delete the file and restart this server.`,
          )
        : undefined,
    /** Said beside a workspace the default chose, so a caller knows why it was used. */
    byDefault: (workspace_id: string | undefined) =>
      workspace_id === undefined && session.defaultWorkspace
        ? " (the saved profile's default from mandala workspaces use)"
        : '',
  };
}

/**
 * What a left-out workspace_id means, said in the tool's schema: the local
 * server started from a saved profile falls back to that profile's default
 * workspace. `otherwise` is what the tool does with no default, and
 * `unreadable` what it does when defaults.json cannot be read. Every other
 * session (an explicit or environment key, and every hosted one) gets ''.
 */
export function scopeDefault(session: ScopeSession, otherwise: string, unreadable: string): string {
  const d = session.defaultWorkspace;
  if (d === undefined) return '';
  const here = session.defaultWorkspaceUnreadable
    ? `unknown, because ~/.mandala/defaults.json cannot be read: ${unreadable}`
    : d
      ? `workspace ${d.name} (${d.id})`
      : otherwise;
  return ` Default when left out: the saved profile's workspace from \`mandala workspaces use\`, else ${otherwise} — here ${here}.`;
}
