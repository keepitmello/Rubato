import { DEFAULT_MONITOR_TIMEOUT_MS } from "./tools/monitor.ts";

export { TERMINAL_AWAITED_WAKES_REQUEST } from "./host/monitor-state-event.ts";

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
	readonly description?: string;
}

export interface HeldMonitor {
	readonly id: string;
	readonly startedAtMs: number;
	readonly persistent: boolean;
	/** Its events have already reached the agent (MonitorNotifier.hasReported). */
	readonly reported: boolean;
	readonly description?: string;
}

export interface TerminalPendingWork {
	readonly active: number;
	readonly undelivered: number;
}

/**
 * Terminal work whose completion will still wake the session: background sessions that notify
 * on exit, monitors that have not reported yet, plus monitor events queued for the next
 * coalesced delivery. Nothing is pending when notifications cannot reach the agent
 * (`notify: "off"`, no model).
 *
 * A monitor holds the run only until its first event reaches the agent. After that the agent
 * has had the turn the monitor was set up to give it, and a watch such as `tail -f <log>` never
 * exits by itself, so holding on would idle the run until the watcher's deadline. Its later
 * events still arrive while other work holds the run; re-arming a paused monitor holds again.
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
		(entry) =>
			!entry.reported && (!entry.persistent || input.nowMs < entry.startedAtMs + PERSISTENT_MONITOR_HOLD_MS),
	).length;
	return { active: backgrounds + monitors, undelivered: input.queuedMonitorEvents ? 1 : 0 };
}

export interface AwaitedWake {
	readonly id: string;
	readonly description: string;
}

const AWAITED_LABEL_MAX = 80;

function awaitedLabel(id: string, description: string | undefined): string {
	const line = (description ?? "").split("\n").find((part) => part.trim())?.trim() || id;
	return line.length > AWAITED_LABEL_MAX ? `${line.slice(0, AWAITED_LABEL_MAX - 1)}…` : line;
}

/**
 * The waits an idle agent ended its turn on: a background session killed at its own deadline
 * and a monitor that has a deadline and has not reported. Each of them wakes the agent soon,
 * so a client may keep the turn open instead of announcing it done. A session with no deadline
 * (a dev server) and a persistent watch are left out: the agent may leave them running and
 * have finished. Nothing is awaited when notifications cannot reach the agent.
 */
export function terminalAwaitedWakes(input: {
	readonly delivers: boolean;
	readonly backgrounds: readonly HeldBackground[];
	readonly monitors: readonly HeldMonitor[];
}): AwaitedWake[] {
	if (!input.delivers) return [];
	return [
		// A monitor's description is written for a reader; a session's is often its command.
		...input.monitors.filter((entry) => !entry.persistent && !entry.reported),
		...input.backgrounds.filter((entry) => entry.bounded),
	].map((entry) => ({ id: entry.id, description: awaitedLabel(entry.id, entry.description) }));
}
