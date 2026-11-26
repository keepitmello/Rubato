/**
 * Wake-source liveness contract shared with the goal builtin.
 *
 * The goal builtin delays its hidden continuation while any live wake source
 * can still wake the session. Each emitter publishes a full per-source
 * snapshot on every liveness transition and once on `session_start`.
 *
 * The event name is duplicated here on purpose: senpi-codemode is a separate
 * package and must not import across the packages/coding-agent boundary, so
 * the sentinel test pins this literal to the exact cross-package contract.
 */
export const WAKE_SOURCE_STATE_EVENT = "wake_source_state";

/** Source key identifying detached eval cells in the per-source snapshot. */
export const SENPI_CODEMODE_WAKE_SOURCE = "senpi-codemode";

/** One detached cell as broadcast on the wake-source state event. */
export interface WakeSourceStateItem {
	readonly id: string;
	readonly description: string;
	/** Epoch milliseconds when the channel registered; lets consumers render their own elapsed labels. */
	readonly startedAtMs: number;
}

export interface WakeSourceState {
	readonly source: string;
	readonly activeCount: number;
	/** Work that promises a completion: goal timers recheck liveness without starting a model turn. */
	readonly awaitedCount?: number;
	/** A background server cannot hold a goal forever. Null/absent means wait for actual delivery. */
	readonly awaitedUntilMs?: number | null;
	readonly items?: readonly WakeSourceStateItem[];
}
