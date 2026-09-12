import { defineService } from '@earendil-works/chord';

// The published 0.85.1 server routes services, but coding-agent's experimental
// service implementations are source-only. Keep this adaptation at this boundary.
export const Directory = defineService('rubato.session-directory.v1');
export const Management = defineService('rubato.session-management.v1');
export const Control = defineService('rubato.session-control.v1');
export const INPUT_COMMANDS = new Set(['prompt', 'steer', 'follow_up']);
export const COMMANDS = new Set([
  ...INPUT_COMMANDS, 'abort', 'clear_queue', 'get_state', 'get_messages', 'get_entries',
  'get_tree', 'get_session_stats', 'get_available_models', 'get_available_thinking_levels',
  'get_commands', 'get_last_assistant_text', 'set_model', 'set_thinking_level',
  'set_session_name', 'set_auto_compaction', 'set_auto_retry', 'abort_retry',
  'set_steering_mode', 'set_follow_up_mode', 'compact',
]);
export const UI_METHODS = new Set(['select', 'confirm', 'input', 'editor']);
export const json = (value) => JSON.parse(JSON.stringify(value));
