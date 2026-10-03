import { execFileSync } from "node:child_process";
import type { LiveCommandWatch } from "../monitor-registry.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";

const SHELL_KEYWORDS = new Set(["while", "until", "if", "then", "do", "else", "elif", "!", "{", "time", "command", "nohup"]);
/** pgrep options (procps and BSD) that consume the next word as their argument. */
const PGREP_OPTIONS_WITH_ARGUMENT = new Set(["d", "F", "g", "G", "J", "M", "N", "P", "r", "s", "t", "u", "U"]);
const PGREP_LONG_OPTIONS_WITH_ARGUMENT = new Set([
	"--delimiter",
	"--pgroup",
	"--group",
	"--parent",
	"--session",
	"--terminal",
	"--euid",
	"--uid",
	"--pidfile",
	"--ns",
	"--nslist",
	"--runstates",
	"--signal",
]);

interface Word {
	readonly text: string;
	/** The word contains an unquoted or double-quoted expansion, so its runtime value is unknown. */
	readonly expands: boolean;
}

/** Split a shell command into simple commands of words; quoting is honored, anything unclear stays literal. */
function simpleCommands(command: string): Word[][] {
	const commands: Word[][] = [];
	let words: Word[] = [];
	let text = "";
	let expands = false;
	let inWord = false;
	const endWord = () => {
		if (inWord) words.push({ text, expands });
		text = "";
		expands = false;
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length > 0) commands.push(words);
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		if (char === "'") {
			const close = command.indexOf("'", i + 1);
			if (close < 0) return [];
			text += command.slice(i + 1, close);
			inWord = true;
			i = close;
		} else if (char === '"') {
			let j = i + 1;
			for (; j < command.length && command[j] !== '"'; j++) {
				if (command[j] === "\\" && j + 1 < command.length) {
					text += command[++j];
					continue;
				}
				if (command[j] === "$" || command[j] === "`") expands = true;
				text += command[j];
			}
			if (j >= command.length) return [];
			inWord = true;
			i = j;
		} else if (char === "\\" && i + 1 < command.length) {
			text += command[++i];
			inWord = true;
		} else if (char === "$" && command[i + 1] === "(") {
			endCommand();
			i++;
		} else if (";&|()`\n".includes(char)) {
			endCommand();
		} else if (char === " " || char === "\t") {
			endWord();
		} else {
			if (char === "$") expands = true;
			text += char;
			inWord = true;
		}
	}
	endCommand();
	return commands;
}

/** The pattern of one `pgrep` invocation when it matches full command lines (-f), else undefined. */
function fullMatchPattern(args: readonly Word[]): string | undefined {
	let full = false;
	for (let i = 0; i < args.length; i++) {
		const word = args[i] as Word;
		const arg = word.text;
		if (/^\d*[<>]/.test(arg)) {
			if (/^\d*[<>]+&?$/.test(arg)) i++;
			continue;
		}
		if (arg === "--") {
			const next = args[i + 1];
			return full && next && !next.expands ? next.text : undefined;
		}
		if (arg.startsWith("--")) {
			if (arg === "--full") full = true;
			else if (!arg.includes("=") && PGREP_LONG_OPTIONS_WITH_ARGUMENT.has(arg)) i++;
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k] as string;
				if (letter === "f") full = true;
				if (PGREP_OPTIONS_WITH_ARGUMENT.has(letter)) {
					if (k === arg.length - 1) i++;
					break;
				}
			}
			continue;
		}
		return full && !word.expands && arg.length > 0 ? arg : undefined;
	}
	return undefined;
}

/**
 * Patterns the command hands to `pgrep -f` in command position. Text that only mentions pgrep
 * (an argument to printf, a quoted string) and patterns built from expansions are not read.
 */
export function pgrepFullPatterns(command: string): string[] {
	const patterns: string[] = [];
	for (const words of simpleCommands(command)) {
		let start = 0;
		while (start < words.length && SHELL_KEYWORDS.has((words[start] as Word).text)) start++;
		const name = words[start]?.text.split("/").pop();
		if (name !== "pgrep") continue;
		const pattern = fullMatchPattern(words.slice(start + 1));
		if (pattern !== undefined) patterns.push(pattern);
	}
	return patterns;
}

/** Reads the live process table; undefined when the platform lacks the tools or they fail. */
export interface ProcessProbe {
	/** Pids whose full command line matches the pattern, as `pgrep -f` itself decides. */
	matchingPids(pattern: string): number[] | undefined;
	/** Parent pid and command line of every process. */
	processTable(): Map<number, { readonly ppid: number; readonly command: string }> | undefined;
}

export const systemProcessProbe: ProcessProbe = {
	matchingPids(pattern) {
		try {
			const out = execFileSync("pgrep", ["-f", "--", pattern], { encoding: "utf8", timeout: 2_000 });
			return out.split(/\s+/).filter(Boolean).map(Number);
		} catch (error) {
			// pgrep exits 1 when nothing matches; anything else means the probe is unavailable.
			return (error as { status?: number }).status === 1 ? [] : undefined;
		}
	},
	processTable() {
		try {
			const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
				encoding: "utf8",
				timeout: 2_000,
				maxBuffer: 16 * 1024 * 1024,
			});
			const table = new Map<number, { ppid: number; command: string }>();
			for (const line of out.split("\n")) {
				const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
				if (match) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] as string });
			}
			return table;
		} catch {
			return undefined;
		}
	},
};

export interface HeldBySession {
	readonly pattern: string;
	readonly pid: number;
	readonly command: string;
	/** The session that process roots, when its command line still identifies it. */
	readonly session: { readonly id: string; readonly monitorId: string | undefined } | undefined;
}

/** `ps` prints argv joined by spaces and control characters escaped (`\012`). */
function normalizeCommandLine(text: string): string {
	return text.replace(/\\0\d\d|\s+/g, " ").trim();
}

/**
 * Every session this agent spawns is a direct child of this process, and lives exactly as long
 * as that child. When the OS `pgrep -f` matches such a child, a watch waiting for the pattern to
 * disappear cannot fire before that session ends: a background bash then already wakes the agent
 * with its completion, and another watcher would hold this one (and be held by it) until their
 * deadlines. Matching is left to pgrep itself, so POSIX regex classes and `exec`'d command lines
 * are judged as they really run; a nohup'd process outlives its launching shell and is reparented
 * away, so waiting on it stays allowed. Without a usable probe nothing is refused.
 */
export function findSessionHeldByPattern(
	command: string,
	sessions: readonly { readonly id: string; readonly runtime: TerminalRuntimeSession }[],
	watches: readonly LiveCommandWatch[],
	probe: ProcessProbe = systemProcessProbe,
	selfPid: number = process.pid,
): HeldBySession | undefined {
	const patterns = pgrepFullPatterns(command);
	if (patterns.length === 0) return undefined;
	let table: ReturnType<ProcessProbe["processTable"]> | null = null;
	for (const pattern of patterns) {
		const pids = probe.matchingPids(pattern);
		if (!pids || pids.length === 0) continue;
		table ??= probe.processTable();
		if (!table) return undefined;
		for (const pid of pids) {
			const entry = table.get(pid);
			if (!entry || entry.ppid !== selfPid) continue;
			const line = normalizeCommandLine(entry.command);
			const owner = sessions.find((session) => {
				const spawned = session.runtime.spawned;
				if (!spawned || session.runtime.exited) return false;
				const asked = normalizeCommandLine(spawned.command);
				return line === asked || line.endsWith(` ${asked}`);
			});
			return {
				pattern,
				pid,
				command: entry.command,
				session: owner && {
					id: owner.id,
					monitorId: watches.find((watch) => watch.id === owner.id)?.monitorId,
				},
			};
		}
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
