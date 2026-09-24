import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/** Tags describe capabilities, not whether calling a tool is safe. */
export const TOOL_TAGS = {
  account: ['get_account'],
  agent: ['run_agent', 'run_agent_chat'],
  activities: ['list_activities', 'get_activity', 'get_activity_results'],
  signals: ['read_signals'],
  artifacts: ['publish_artifact', 'get_artifact', 'read_artifact', 'delete_artifact'],
  computers: [
    'list_computers',
    'get_computer',
    'use_computer',
    'wait_for_computer',
    'get_desktop_url',
    'list_sizes',
  ],
  events: ['wait_for_event', 'poll_events', 'wait_for_file_change'],
  executions: ['get_execution', 'read_execution_output'],
  files: ['list_directory', 'read_file', 'write_file', 'wait_for_file_change'],
  guest: [
    'exec',
    'exec_poll',
    'exec_kill',
    'open_url',
    'list_windows',
    'window_action',
    'read_clipboard',
    'write_clipboard',
  ],
  input: [
    'screenshot',
    'click',
    'type_text',
    'press_key',
    'scroll',
    'drag',
    'move_mouse',
    'mouse_button',
    'cursor_position',
    'wait',
  ],
  lifecycle: [
    'create_computer',
    'start_computer',
    'stop_computer',
    'suspend_computer',
    'restart_computer',
    'update_computer',
    'clone_computer',
    'delete_computer',
    'move_computer',
    'list_moves',
  ],
  results: [
    'get_activity_results',
    'retain_execution_output',
    'get_result',
    'read_result_output',
    'delete_result',
  ],
  snapshots: [
    'list_snapshots',
    'snapshot_holdings',
    'create_snapshot',
    'restore_snapshot',
    'clone_snapshot',
    'snapshot_schedule',
    'get_retention',
    'delete_snapshot',
  ],
  templates: [
    'list_templates',
    'get_template_schema',
    'check_template',
    'publish_template',
    'get_template',
    'retire_template',
    'build_template',
    'list_builds',
    'get_build',
    'watch_build',
  ],
  secrets: [
    'get_computer_secrets',
    'set_computer_secrets',
    'list_secrets',
    'get_secret',
    'create_secret',
    'replace_secret',
    'delete_secret',
  ],
  ssh: ['list_ssh_keys', 'add_ssh_key', 'remove_ssh_key', 'get_computer_ssh', 'set_computer_ssh'],
  usage: ['get_usage'],
  webhooks: [
    'list_webhooks',
    'create_webhook',
    'get_webhook',
    'update_webhook',
    'rotate_webhook_secret',
    'test_webhook',
    'list_webhook_deliveries',
    'delete_webhook',
  ],
} as const;

export type ToolTag = keyof typeof TOOL_TAGS;
export type ToolFilters = {
  /** Keep only tools whose existing readOnlyHint is exactly true. */
  readOnly?: boolean;
  /** Union of these tags; absent or empty means all tags. Names are lowercase. */
  tags?: readonly string[];
};

export const VALID_TAGS = Object.keys(TOOL_TAGS).sort() as ToolTag[];

function validateTags(tags: readonly string[]): ToolTag[] {
  const names = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  for (const name of names) {
    if (!Object.hasOwn(TOOL_TAGS, name)) {
      throw new Error(
        `Unknown MANDALA_TAGS tag "${name}". Valid tags (lowercase only): ${VALID_TAGS.join(', ')}`,
      );
    }
  }
  return names as ToolTag[];
}

export function parseToolTags(raw: string | undefined): ToolTag[] {
  return validateTags(raw?.split(',') ?? []);
}

/** Validate before constructing the session; never infer read-only from a name or verb. */
export function toolFilter(cfg: ToolFilters): {
  filtered: boolean;
  allows: (name: string, annotations?: ToolAnnotations) => boolean;
} {
  if (cfg.readOnly !== undefined && typeof cfg.readOnly !== 'boolean') {
    throw new Error('readOnly must be a boolean');
  }
  const tags = validateTags(cfg.tags ?? []);
  const selected = new Set<string>(tags.flatMap((tag) => [...TOOL_TAGS[tag]]));
  const known = new Set<string>(Object.values(TOOL_TAGS).flat());
  const readOnly = cfg.readOnly === true;
  return {
    filtered: readOnly || tags.length > 0,
    allows: (name, annotations) => {
      // Even unfiltered startup must fail when a new tool lacks a tag, instead
      // of silently hiding it only for clients who use filters.
      if (!known.has(name)) throw new Error(`Tool "${name}" has no tag in TOOL_TAGS`);
      return (
        (!tags.length || selected.has(name)) && (!readOnly || annotations?.readOnlyHint === true)
      );
    },
  };
}
