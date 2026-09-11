export const TERMINAL_MONITOR_STATE_EVENT = "terminal_monitor_state";
export const WAKE_SOURCE_STATE_EVENT = "wake_source_state";

export interface WakeSourceStateItem {
	readonly id: string;
	readonly description?: string;
	readonly startedAtMs?: number;
}
