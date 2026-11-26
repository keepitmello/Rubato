import type { MonitorEvent } from "./monitor-registry.ts";
import { getTerminalNotificationDelivery, type TerminalNotifierDeps } from "./notify.ts";
import { sanitizeTerminalOutput } from "./output-format.ts";
import type { MonitorDeliverySettings } from "./settings.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import { IntermediateWakeBudget, intermediateWakeSubjects, INTERMEDIATE_WAKE_LIMIT, WAKE_LIMIT_NOTICE, type WakeDecision } from "./wake-budget.ts";

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
const QUEUE_OVERHEAD_CHARS = 512;
const MONITOR_NOTIFICATION_CUSTOM_TYPE = "senpi-monitor:notification";

export interface MonitorNotificationScheduler {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
}

const systemScheduler: MonitorNotificationScheduler = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface MonitorNotifierDeps extends TerminalNotifierDeps {
	readonly getSettings: () => MonitorDeliverySettings;
	/** Pause the monitors contributing to a shared wake-budget exhaustion. */
	readonly pauseMonitors: (ids: readonly string[]) => readonly string[];
	readonly scheduler?: MonitorNotificationScheduler;
	readonly getRuntime?: (id: string) => TerminalRuntimeSession | undefined;
	readonly onDelivery?: () => void;
}

interface Overflow {
	readonly id: string;
	count: number;
}

function boundedPositiveInt(value: number, fallback: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function resolveSettings(settings: MonitorDeliverySettings): MonitorDeliverySettings {
	return {
		coalesceWindowMs: boundedPositiveInt(settings.coalesceWindowMs, 2000, 1, 60_000),
		rateLimitMs: boundedPositiveInt(settings.rateLimitMs, 5000, 1, 3_600_000),
		maxLinesPerInjection: boundedPositiveInt(settings.maxLinesPerInjection, 50, 1, 200),
		maxCharsPerInjection: boundedPositiveInt(settings.maxCharsPerInjection, 4096, 512, 16_384),
		wakeBudget: boundedPositiveInt(settings.wakeBudget, INTERMEDIATE_WAKE_LIMIT, 1, INTERMEDIATE_WAKE_LIMIT),
	};
}

function eventBody(event: MonitorEvent): string {
	const value = event.type === "line" ? event.line : event.summary;
	return sanitizeTerminalOutput(value)
		.replace(/[\r\n]+/g, " ")
		.trimEnd();
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 3)}...`;
}

function formatEvents(events: readonly MonitorEvent[]): string {
	const groups = new Map<string, { description: string; bodies: string[] }>();
	for (const event of events) {
		const group = groups.get(event.id) ?? { description: event.description, bodies: [] };
		group.bodies.push(eventBody(event));
		groups.set(event.id, group);
	}
	return [...groups.values()]
		.map((group) => `Monitor event(${group.description}): ${group.bodies.join("\n")}`)
		.join("\n");
}

/**
 * Session-scoped monitor delivery queue. It preserves the terminal runtime as the authoritative,
 * bounded event history while retaining only one capped coalescing batch for chat injection.
 */
export class MonitorNotifier {
	readonly #deps: MonitorNotifierDeps;
	readonly #scheduler: MonitorNotificationScheduler;
	#events: MonitorEvent[] = [];
	#eventChars = 0;
	#overflow = new Map<string, Overflow>();
	#lastInjectionAt = new Map<string, number>();
	#lastInjectedBatch = new Map<string, string>();
	/** Monitors that have reported to the agent since they were created or last re-armed. */
	#reported = new Set<string>();
	#timer: unknown;
	#scheduledAt: number | undefined;
	readonly #wakeBudget: IntermediateWakeBudget;

	constructor(deps: MonitorNotifierDeps) {
		this.#deps = deps;
		this.#scheduler = deps.scheduler ?? systemScheduler;
		this.#wakeBudget = deps.wakeBudget ?? new IntermediateWakeBudget();
	}

	notifyEvent(event: MonitorEvent): void {
		if (event.type === "summary") {
			this.#lastInjectionAt.delete(event.id);
			this.#lastInjectedBatch.delete(event.id);
		}
		if (!getTerminalNotificationDelivery(this.#deps, MONITOR_NOTIFICATION_CUSTOM_TYPE)) return;
		const settings = resolveSettings(this.#deps.getSettings());
		const rendered = `Monitor event(${event.description}): ${eventBody(event)}`;
		const queueLimit = Math.max(1, settings.maxCharsPerInjection - QUEUE_OVERHEAD_CHARS);
		if (
			event.type !== "summary" &&
			(this.#events.length >= settings.maxLinesPerInjection || this.#eventChars + rendered.length > queueLimit)
		) {
			this.#recordOverflow(event.id);
		} else {
			this.#events.push(event);
			this.#eventChars += rendered.length;
		}
		this.#schedule(settings.coalesceWindowMs);
	}

	/** Events accepted for the next coalesced delivery and not yet sent. */
	hasQueuedEvents(): boolean {
		return this.#events.length > 0 || this.#overflow.size > 0;
	}

	/**
	 * Whether this monitor's events have reached the agent since it was created or re-armed.
	 * A monitor that has reported no longer holds a one-shot run open (pending-work.ts).
	 */
	hasReported(id: string): boolean {
		return this.#reported.has(id);
	}

	/** Only the person's new instruction refills intermediate wakes; tool calls are not progress. */
	notePersonInput(): void {
		this.#wakeBudget.reset();
	}

	/** Clear delivery bookkeeping for monitors explicitly resumed by the registry. */
	resume(ids: readonly string[]): void {
		for (const id of ids) {
			this.#lastInjectionAt.delete(id);
			this.#lastInjectedBatch.delete(id);
			this.#reported.delete(id);
		}
	}

	rearm(id: string): void {
		this.resume([id]);
	}

	dispose(): void {
		if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#scheduledAt = undefined;
		this.#events = [];
		this.#eventChars = 0;
		this.#overflow.clear();
		this.#lastInjectedBatch.clear();
		this.#reported.clear();
	}

	#recordOverflow(id: string): void {
		const overflow = this.#overflow.get(id) ?? { id, count: 0 };
		overflow.count++;
		this.#overflow.set(id, overflow);
	}

	#schedule(delayMs: number): void {
		const due = this.#scheduler.now() + delayMs;
		if (this.#timer !== undefined && this.#scheduledAt !== undefined && this.#scheduledAt <= due) return;
		if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
		this.#scheduledAt = due;
		this.#timer = this.#scheduler.setTimeout(() => this.#flush(), delayMs);
	}

	#flush(): void {
		this.#timer = undefined;
		this.#scheduledAt = undefined;
		const delivery = getTerminalNotificationDelivery(this.#deps, MONITOR_NOTIFICATION_CUSTOM_TYPE);
		if (!delivery) {
			this.dispose();
			return;
		}

		const settings = resolveSettings(this.#deps.getSettings());
		const now = this.#scheduler.now();
		const pendingIds = new Set([...this.#events.map((event) => event.id), ...this.#overflow.keys()]);
		if (pendingIds.size === 0) return;
		const summaryIds = new Set(this.#events.filter((event) => event.type === "summary").map((event) => event.id));
		const ready = new Set(
			[...pendingIds].filter((id) => {
				if (summaryIds.has(id)) return true;
				const last = this.#lastInjectionAt.get(id);
				return last === undefined || now - last >= settings.rateLimitMs;
			}),
		);
		if (ready.size === 0) {
			this.#scheduleNextRateLimit(pendingIds, now, settings);
			return;
		}

		const fingerprints = this.#batchFingerprints(ready);
		const suppressedIds = new Set(
			[...fingerprints]
				.filter(([id, fingerprint]) => this.#lastInjectedBatch.get(id) === fingerprint)
				.map(([id]) => id),
		);
		const injectedIds = new Set([...ready].filter((id) => !suppressedIds.has(id)));
		const selected = this.#events.filter((event) => injectedIds.has(event.id));
		const deferred = this.#events.filter((event) => !ready.has(event.id));
		if (injectedIds.size === 0) {
			this.#discardSuppressed(deferred, now, settings);
			return;
		}
		const overflowCount = [...this.#overflow.values()]
			.filter((overflow) => injectedIds.has(overflow.id))
			.reduce((total, overflow) => total + overflow.count, 0);
		const decisions = new Map<string, WakeDecision>();
		const subjects = new Map<object | string, WakeDecision>();
		for (const id of injectedIds) {
			const events = selected.filter(event => event.id === id);
			const runtime = this.#deps.getRuntime?.(id);
			// A real job's outcome stays deliverable. The end of a disposable wait is only
			// another progress check on the still-running job, not that job's completion.
			if (events.some(event => event.type === "summary" && !event.cutShort) && runtime?.waitingOn === undefined) {
				this.#wakeBudget.finish(intermediateWakeSubjects(runtime, id));
				decisions.set(id, "allow");
				continue;
			}
			if (events.length > 0 && events.every(event => event.overtaken || (event.type === "summary" && event.cutShort && this.#reported.has(id)))) {
				decisions.set(id, "quiet");
				continue;
			}
			const group = intermediateWakeSubjects(runtime, id);
			// An exhausted job must not spend another job's allowance on a batch that
			// will stay quiet. Shared subjects already charged in this batch count once.
			if (!this.#wakeBudget.canTake(group.filter(subject => !subjects.has(subject)), settings.wakeBudget)) {
				decisions.set(id, "quiet");
				continue;
			}
			const taken = group.map(subject => {
				let decision = subjects.get(subject);
				if (decision === undefined) {
					decision = this.#wakeBudget.take([subject], settings.wakeBudget);
					subjects.set(subject, decision);
				}
				return decision;
			});
			decisions.set(id, taken.includes("quiet") ? "quiet" : taken.includes("last") ? "last" : "allow");
		}
		// A watch that already reported and then only hit its deadline or got killed brings no news:
		// waking an idle session for it buys a turn that says "nothing to do". Neither does a wait
		// whose background session already ended and woke the agent itself.
		const quiet = injectedIds.size > 0 && [...injectedIds].every(id => decisions.get(id) === "quiet");
		const reachesBudget = [...decisions.values()].includes("last");
		const pauseNotice = reachesBudget
			? WAKE_LIMIT_NOTICE
			: "";
		const content = this.#buildMessage(selected, overflowCount, pauseNotice, settings.maxCharsPerInjection);

		delivery.send(content, quiet ? { quiet: true } : reachesBudget ? { forceWake: true } : undefined);
		for (const id of injectedIds) {
			this.#reported.add(id);
			this.#lastInjectionAt.set(id, now);
			this.#overflow.delete(id);
			const fingerprint = fingerprints.get(id);
			if (fingerprint === undefined) this.#lastInjectedBatch.delete(id);
			else this.#lastInjectedBatch.set(id, fingerprint);
		}
		this.#deps.onDelivery?.();
		this.#events = deferred;
		this.#eventChars = deferred.reduce(
			(total, event) => total + `Monitor event(${event.description}): ${eventBody(event)}`.length,
			0,
		);
		this.#deps.pauseMonitors([...decisions].filter(([, decision]) => decision !== "allow").map(([id]) => id));
		const remainingIds = new Set([...this.#events.map((event) => event.id), ...this.#overflow.keys()]);
		if (remainingIds.size > 0) this.#scheduleNextRateLimit(remainingIds, now, settings);
	}

	#scheduleNextRateLimit(ids: ReadonlySet<string>, now: number, settings: MonitorDeliverySettings): void {
		const nextAt = Math.min(...[...ids].map((id) => (this.#lastInjectionAt.get(id) ?? now) + settings.rateLimitMs));
		this.#schedule(Math.max(1, nextAt - now));
	}

	/** A ready monitor whose line-only batch matches its previous injection carries no new information. */
	#batchFingerprints(ids: ReadonlySet<string>): Map<string, string> {
		const fingerprints = new Map<string, string>();
		for (const id of ids) {
			if ((this.#overflow.get(id)?.count ?? 0) > 0) continue;
			const batch = this.#events.filter((event) => event.id === id);
			if (batch.length === 0 || batch.some((event) => event.type !== "line")) continue;
			fingerprints.set(id, batch.map(eventBody).join("\n"));
		}
		return fingerprints;
	}

	#discardSuppressed(deferred: MonitorEvent[], now: number, settings: MonitorDeliverySettings): void {
		this.#events = deferred;
		this.#eventChars = deferred.reduce(
			(total, event) => total + `Monitor event(${event.description}): ${eventBody(event)}`.length,
			0,
		);
		const remainingIds = new Set([...deferred.map((event) => event.id), ...this.#overflow.keys()]);
		if (remainingIds.size > 0) this.#scheduleNextRateLimit(remainingIds, now, settings);
	}

	#buildMessage(
		events: readonly MonitorEvent[],
		overflowCount: number,
		pauseNotice: string,
		maxChars: number,
	): string {
		const overflowNotice =
			overflowCount > 0
				? `[${overflowCount} additional event lines omitted; peek bash_output for full history.]`
				: "";
		const suffix = [overflowNotice, pauseNotice].filter(Boolean).join("\n");
		const fixedChars = SYSTEM_REMINDER_OPEN.length + SYSTEM_REMINDER_CLOSE.length + (suffix ? suffix.length + 1 : 0);
		const body = clip(formatEvents(events), Math.max(0, maxChars - fixedChars));
		return `${SYSTEM_REMINDER_OPEN}${body}${body && suffix ? "\n" : ""}${suffix}${SYSTEM_REMINDER_CLOSE}`;
	}
}
