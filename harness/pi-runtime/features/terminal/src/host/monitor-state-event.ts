export const TERMINAL_MONITOR_STATE_EVENT = "terminal_monitor_state";
export const WAKE_SOURCE_STATE_EVENT = "wake_source_state";
/** Answered for a client that shows an idle session as still at work (extension-rpc); see pending-work.ts. */
export const TERMINAL_AWAITED_WAKES_REQUEST = "rubato.terminal.awaited-wakes";

export interface WakeSourceStateItem {
	readonly id: string;
	readonly description?: string;
	readonly startedAtMs?: number;
}
