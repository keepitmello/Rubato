import type { TerminalRuntimeSession } from "./runtime-session.ts";

export const INTERMEDIATE_WAKE_LIMIT = 3;
export const WAKE_LIMIT_NOTICE =
	"Intermediate wake limit reached. Further progress and wait checks are recorded without waking; the actual job's completion or failure still wakes you. Do not recreate a watcher or sleep-wait to poll it.";

type Subject = object | string;
export type WakeDecision = "allow" | "last" | "quiet";

/**
 * Counts intermediate wakes against the work being watched, not the disposable watcher.
 * Owned by the session bundle, so tool calls, rearming, time and extension reload cannot refill it.
 * Only a new person input resets it; a new job has its own identity.
 */
export class IntermediateWakeBudget {
	#objects = new WeakMap<object, number>();
	#strings = new Map<string, number>();

	reset(): void {
		this.#objects = new WeakMap();
		this.#strings.clear();
	}

	finish(subjects: readonly Subject[]): void {
		for (const subject of subjects) {
			if (typeof subject === "string") this.#strings.delete(subject);
			else this.#objects.delete(subject);
		}
	}

	#count(subject: Subject): number {
		return typeof subject === "string" ? this.#strings.get(subject) ?? 0 : this.#objects.get(subject) ?? 0;
	}

	canTake(subjects: readonly Subject[], limit = INTERMEDIATE_WAKE_LIMIT): boolean {
		return subjects.every(subject => this.#count(subject) < limit);
	}

	take(subjects: readonly Subject[], limit = INTERMEDIATE_WAKE_LIMIT): WakeDecision {
		const unique = [...new Set(subjects)];
		if (!this.canTake(unique, limit)) return "quiet";
		let last = false;
		for (const subject of unique) {
			const next = this.#count(subject) + 1;
			if (typeof subject === "string") this.#strings.set(subject, next);
			else this.#objects.set(subject, next);
			last ||= next >= limit;
		}
		return last ? "last" : "allow";
	}
}

/** A wait's observers share the actual background jobs' identities, even across bash and monitor. */
export function intermediateWakeSubjects(runtime: TerminalRuntimeSession | undefined, id: string): readonly Subject[] {
	if (runtime?.waitingOn !== undefined) {
		return runtime.waitingOn.length > 0 ? runtime.waitingOn : ["unbound-terminal-waits"];
	}
	// Recreating the same command changes its terminal id, not its allowance.
	if (runtime?.spawned) return [JSON.stringify(["watch", runtime.spawned.cwd, runtime.spawned.command])];
	return [`monitor:${id}`];
}
