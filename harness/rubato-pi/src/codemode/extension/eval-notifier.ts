import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { EvalDetachedCellNotification, EvalDetachedCellNotifier } from "../tool/detached-cell-manager.ts";

const NON_INTERACTIVE_MODES = new Set(["print", "json"]);

export type EvalNotifyMode = "wake" | "next-turn" | "off";

export const DETACHED_EVAL_MESSAGE_TYPE = "senpi-codemode:detached-eval";

/** Provider retry suffixes after the first line must not create a second wake. */
export function detachedNotificationKey(cellId: string): string {
	return cellId.split(/\r?\n/, 1)[0]?.trim() || cellId;
}

export function sessionIdFromEvent(event: unknown): string | undefined {
	if (typeof event === "object" && event !== null && "sessionId" in event && typeof event.sessionId === "string") {
		return event.sessionId;
	}
	return undefined;
}

export function sessionFileFromContext(ctx: { sessionManager?: { getSessionFile?: () => string } } | undefined): string | undefined {
	const file = ctx?.sessionManager?.getSessionFile?.();
	return typeof file === "string" && file.length > 0 ? file : undefined;
}

/** True when session_start is re-entering the already-running chat, not a new one. */
export function isSameCodemodeSession(
	current: { readonly sessionFile?: string; readonly sessionId: string } | undefined,
	incoming: { readonly sessionFile?: string; readonly sessionId?: string },
): boolean {
	if (current === undefined) return false;
	if (current.sessionFile && incoming.sessionFile) return current.sessionFile === incoming.sessionFile;
	return incoming.sessionId !== undefined && incoming.sessionId === current.sessionId;
}

export interface EvalNotifierCustomMessage {
	readonly customType: typeof DETACHED_EVAL_MESSAGE_TYPE;
	readonly content: string;
	readonly display: false;
}

export interface EvalNotifierDeps {
	readonly sendMessage: (
		message: EvalNotifierCustomMessage,
		options?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean },
	) => void;
	readonly getContext: () => ExtensionContext | undefined;
	readonly getMode: () => EvalNotifyMode;
}

/** Session-scoped completion injector with the same no-spin guards as terminal notifications. */
export class EvalNotifier implements EvalDetachedCellNotifier {
	readonly #deps: EvalNotifierDeps;
	readonly #notified = new Set<string>();

	constructor(deps: EvalNotifierDeps) {
		this.#deps = deps;
	}

	/** Starts a fresh session generation without suppressing reused tool-call ids. */
	reset(): void {
		this.#notified.clear();
	}

	notify(cells: readonly EvalDetachedCellNotification[]): void {
		const mode = this.#deps.getMode();
		if (mode === "off") return;
		const ctx = this.#deps.getContext();
		if (ctx === undefined || NON_INTERACTIVE_MODES.has(ctx.mode) || ctx.model === undefined) return;
		const pending = cells.filter((cell) => !this.#notified.has(detachedNotificationKey(cell.cellId)));
		if (pending.length === 0) return;
		for (const cell of pending) this.#notified.add(detachedNotificationKey(cell.cellId));
		// sendUserMessage records a user turn and the TUI labels it Steering.
		// Custom messages join the current assistant turn instead.
		this.#deps.sendMessage(
			{
				customType: DETACHED_EVAL_MESSAGE_TYPE,
				content: pending.map((cell) => cell.content).join("\n\n"),
				display: false,
			},
			{
				triggerTurn: true,
				deliverAs: mode === "wake" ? "steer" : "followUp",
			},
		);
	}
}
