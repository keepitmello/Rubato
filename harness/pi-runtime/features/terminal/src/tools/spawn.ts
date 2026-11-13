import { existsSync } from "node:fs";
import { getShellConfig } from "../host/shell.ts";
import type { CreatedTerminalSession } from "../manager.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";
import type { TerminalToolContext } from "./context.ts";

/**
 * Agent commands run one step below normal CPU priority. Every conversation shares the engine's
 * one thread, so a heavy build at the same priority starved it and froze all of them; on an idle
 * machine niceness changes nothing, and under load the person's apps and the engine go first.
 */
export const AGENT_COMMAND_NICE = 10;
const NICE_BIN = "/usr/bin/nice";

function yielding(shell: string, args: string[]): { command: string; args: string[] } {
	if (process.platform === "win32" || !existsSync(NICE_BIN)) return { command: shell, args };
	return { command: NICE_BIN, args: ["-n", String(AGENT_COMMAND_NICE), shell, ...args] };
}

export interface SpawnRequest {
	readonly command: string;
	readonly cols: number;
	readonly rows: number;
	/** Kill deadline in ms for foreground runs; omit for background sessions. */
	readonly timeoutMs?: number;
	/** Working directory override (execute-time `ctx.cwd`); falls back to the tool context cwd. */
	readonly cwd?: string;
	/** Environment overrides merged over `ctx.getEnv()` (foreground non-interactive env). */
	readonly envOverrides?: Readonly<Record<string, string>>;
}

/**
 * Resolve the configured shell (honoring `SENPI_GIT_BASH_PATH` + shell kind) and spawn a
 * terminal session that runs `command` through it. For stdin-transport shells (legacy WSL
 * bash `-s`) the command is written to the PTY after start; otherwise it rides in argv.
 */
export async function spawnCommandSession(
	ctx: TerminalToolContext,
	request: SpawnRequest,
): Promise<CreatedTerminalSession> {
	const shell = getShellConfig(ctx.shellPath);
	const useStdin = shell.commandTransport === "stdin";
	const launch = yielding(shell.shell, useStdin ? [...shell.args] : [...shell.args, request.command]);
	const cwd = request.cwd ?? ctx.cwd;

	const created = await ctx.manager.create(shell.shell, {
		command: launch.command,
		args: launch.args,
		cwd,
		env: { ...ctx.getEnv(), ...request.envOverrides } as Record<string, string | undefined>,
		cols: request.cols,
		rows: request.rows,
		timeoutMs: request.timeoutMs,
	});
	created.runtime.spawned = { command: request.command, cwd };

	if (useStdin) {
		created.runtime.session.write(`${request.command}\n`);
	}
	return created;
}

/** Snapshot the human-facing exit status of a finished session. */
export function describeExit(runtime: TerminalRuntimeSession): string | null {
	const exit = runtime.exitResult;
	if (!exit) return null;
	if (exit.timedOut) return "timed_out";
	if (exit.cancelled) return "killed";
	if (exit.exitCode === 0) return "completed";
	if (exit.exitCode !== null) return `exited_${exit.exitCode}`;
	if (exit.signal) return `signal_${exit.signal}`;
	return "exited";
}
