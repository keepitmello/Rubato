import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { EvalDetachedCellNotification, EvalDetachedCellNotifier } from "../tool/detached-cell-manager.ts";

const NON_INTERACTIVE_MODES = new Set(["print", "json"]);

export type EvalNotifyMode = "wake" | "next-turn" | "off";

export const DETACHED_EVAL_MESSAGE_TYPE = "senpi-codemode:detached-eval";

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
		const pending = cells.filter((cell) => !this.#notified.has(cell.cellId));
		if (pending.length === 0) return;
		for (const cell of pending) this.#notified.add(cell.cellId);
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
