import { DEFAULT_MONITOR_TIMEOUT_MS } from "./tools/monitor.ts";

/** Answered for a one-shot run deciding whether it may exit (extension-rpc `*.pending-work`). */
export const TERMINAL_PENDING_WORK_REQUEST = "rubato.terminal.pending-work";

/**
 * A background session with no kill deadline (`run_in_background`) holds a one-shot run for
 * at most the bash tool's default kill deadline: a dev server left running must not keep the
 * process alive forever, and a long build still gets the time a foreground command would.
 */
export const UNBOUNDED_BACKGROUND_HOLD_MS = 1_800_000;
/**
 * A persistent monitor has no deadline of its own; in a one-shot run it holds only as long
 * as a default monitor would live. Its events still arrive while anything else holds the run.
 */
export const PERSISTENT_MONITOR_HOLD_MS = DEFAULT_MONITOR_TIMEOUT_MS;

export interface HeldBackground {
	readonly id: string;
	readonly startedAtMs: number;
	/** The session is killed at its own deadline, so its exit notification always comes. */
	readonly bounded: boolean;
}

export interface HeldMonitor {
	readonly id: string;
	readonly startedAtMs: number;
	readonly persistent: boolean;
}

export interface TerminalPendingWork {
	readonly active: number;
	readonly undelivered: number;
}

/**
 * Terminal work whose completion will still wake the session: background sessions and monitors
 * that notify on exit, plus monitor events queued for the next coalesced delivery. Nothing is
 * pending when notifications cannot reach the agent (`notify: "off"`, no model).
 */
export function terminalPendingWork(input: {
	readonly delivers: boolean;
	readonly backgrounds: readonly HeldBackground[];
	readonly monitors: readonly HeldMonitor[];
	readonly queuedMonitorEvents: boolean;
	readonly nowMs: number;
}): TerminalPendingWork {
	if (!input.delivers) return { active: 0, undelivered: 0 };
	const backgrounds = input.backgrounds.filter(
		(entry) => entry.bounded || input.nowMs < entry.startedAtMs + UNBOUNDED_BACKGROUND_HOLD_MS,
	).length;
	const monitors = input.monitors.filter(
		(entry) => !entry.persistent || input.nowMs < entry.startedAtMs + PERSISTENT_MONITOR_HOLD_MS,
	).length;
	return { active: backgrounds + monitors, undelivered: input.queuedMonitorEvents ? 1 : 0 };
}
