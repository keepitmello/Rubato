import type { LiveCommandWatch } from "../monitor-registry.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";

/**
 * Patterns a command hands to `pgrep -f` (full command-line match). Flags may be clustered
 * (`-fl`) or split (`-f -n`); a pattern without `-f` matches process names only and is skipped.
 */
export function pgrepFullPatterns(command: string): string[] {
	const patterns: string[] = [];
	const call = /\bpgrep((?:\s+-[A-Za-z]+)*)\s+(?:"([^"]*)"|'([^']*)'|([^\s"';|&)<>]+))/g;
	for (const match of command.matchAll(call)) {
		const flags = match[1] ?? "";
		if (!/-[A-Za-z]*f/.test(flags)) continue;
		const pattern = match[2] ?? match[3] ?? match[4] ?? "";
		if (pattern.length > 0) patterns.push(pattern);
	}
	return patterns;
}

function patternMatches(pattern: string, commandLine: string): boolean {
	try {
		return new RegExp(pattern).test(commandLine);
	} catch {
		return commandLine.includes(pattern);
	}
}

export interface HeldBySession {
	readonly pattern: string;
	readonly id: string;
	/** The live session is itself a monitor (its "mon_" id), rather than a background bash. */
	readonly monitorId: string | undefined;
	readonly command: string;
}

/**
 * A `pgrep -f` pattern that matches one of this agent's own live sessions cannot see that
 * session go away before it exits: the session's shell carries the pattern in its argv. A watch
 * built on it waits on that session, which is either a background bash whose completion already
 * wakes the agent, or another watcher, in which case the two hold each other until their deadlines.
 */
export function findSessionHeldByPattern(
	command: string,
	sessions: readonly { readonly id: string; readonly runtime: TerminalRuntimeSession }[],
	watches: readonly LiveCommandWatch[],
): HeldBySession | undefined {
	const patterns = pgrepFullPatterns(command);
	if (patterns.length === 0) return undefined;
	for (const session of sessions) {
		const spawned = session.runtime.spawned;
		if (!spawned || session.runtime.exited) continue;
		const pattern = patterns.find((candidate) => patternMatches(candidate, spawned.command));
		if (pattern === undefined) continue;
		const watch = watches.find((candidate) => candidate.id === session.id);
		return { pattern, id: session.id, monitorId: watch?.monitorId, command: spawned.command };
	}
	return undefined;
}

/** A live watch running the same command, cwd, filter and persistence would deliver the same events. */
export function findSameWatch(
	watches: readonly LiveCommandWatch[],
	request: {
		readonly command: string;
		readonly cwd: string;
		readonly filter: RegExp | undefined;
		readonly persistent: boolean;
	},
): LiveCommandWatch | undefined {
	return watches.find(
		(watch) =>
			!watch.runtime.exited &&
			watch.runtime.spawned?.command === request.command &&
			watch.runtime.spawned.cwd === request.cwd &&
			watch.filter?.source === request.filter?.source &&
			watch.persistent === request.persistent,
	);
}
