import type { ExtensionContext } from "./host-sdk.ts";
import { sanitizeTerminalOutput } from "./output-format.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import type { NotifyMode } from "./settings.ts";
import { describeExit } from "./tools/spawn.ts";

/**
 * One-shot runs. Completions still wake them: the run stays alive while terminal work is
 * pending (`rubato.terminal.pending-work`), so the wake arrives as a follow-up turn.
 */
export const NON_INTERACTIVE_MODES = new Set(["print", "json"]);
export const TERMINAL_NOTIFICATION_CUSTOM_TYPE = "senpi-terminal:notification";

export interface TerminalNotifierDeps {
	/** Deliver a model-visible notification without rendering synthetic user input. */
	readonly sendMessage: (
		message: { customType: string; content: string; display: boolean },
		options: { triggerTurn: boolean; deliverAs: "steer" | "followUp" },
	) => void;
	readonly getContext: () => ExtensionContext | undefined;
	readonly getMode: () => NotifyMode;
}

/** Max chars of sanitized final output embedded in a completion notification; bash_output reads the rest. */
export const NOTICE_TAIL_MAX_CHARS = 600;

export interface TerminalNotificationDelivery {
	/** `quiet` records the notice in the conversation without starting a turn; the next turn reads it. */
	readonly send: (content: string, options?: { readonly forceWake?: boolean; readonly quiet?: boolean }) => void;
}

/** Shared terminal-notification guard and notify-mode mapping. */
export function getTerminalNotificationDelivery(
	deps: TerminalNotifierDeps,
	customType = TERMINAL_NOTIFICATION_CUSTOM_TYPE,
): TerminalNotificationDelivery | undefined {
	const mode = deps.getMode();
	if (mode === "off") return undefined;
	const ctx = deps.getContext();
	if (!ctx || !ctx.model) return undefined;
	return {
		send: (content, options) =>
			deps.sendMessage(
				{ customType, content, display: false },
				{
					triggerTurn: options?.quiet !== true,
					deliverAs: mode === "wake" || options?.forceWake === true ? "steer" : "followUp",
				},
			),
	};
}

function buildNotice(id: string, runtime: TerminalRuntimeSession): string {
	const status = describeExit(runtime) ?? "exited";
	const code = runtime.exitResult?.exitCode;
	const codeText = code === null || code === undefined ? "" : ` (exit code ${code})`;
	const tail = sanitizeTerminalOutput(runtime.fullOutput()).trimEnd();
	let tailSection = "";
	if (tail.length > 0) {
		const truncated = tail.length > NOTICE_TAIL_MAX_CHARS;
		const shown = truncated ? tail.slice(tail.length - NOTICE_TAIL_MAX_CHARS) : tail;
		const note = truncated
			? `\n[last ${NOTICE_TAIL_MAX_CHARS} chars; bash_output reads more]`
			: "";
		tailSection = `\nFinal output:\n${shown}${note}`;
	}
	return `<system-reminder>Background terminal session ${id} finished: ${status}${codeText}.${tailSection}</system-reminder>`;
}

/**
 * Notifies the agent once when a background session completes.
 *
 * Guards (todo 23): never wakes without an active model (would spin an auth-less turn);
 * `notify:"off"` suppresses entirely; each session id fires at most once. `wake` steers
 * immediately; `next-turn` queues a follow-up. One-shot runs are woken too: they stay alive
 * until this completion has been delivered.
 */
export class TerminalNotifier {
	private readonly notified = new Set<string>();
	private readonly deps: TerminalNotifierDeps;

	constructor(deps: TerminalNotifierDeps) {
		this.deps = deps;
	}

	notifyCompletion(id: string, runtime: TerminalRuntimeSession): void {
		if (this.notified.has(id)) return;
		if (runtime.killedByAgent) {
			this.notified.add(id);
			return;
		}
		const delivery = getTerminalNotificationDelivery(this.deps);
		if (!delivery) return;

		this.notified.add(id);
		delivery.send(buildNotice(id, runtime));
	}
}
