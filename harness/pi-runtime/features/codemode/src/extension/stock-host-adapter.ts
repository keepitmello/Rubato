export interface RemovedToolHintContextEvent {
	readonly messages: unknown[];
}

export interface RemovedToolHintHost {
	on(
		event: "context",
		handler: (event: RemovedToolHintContextEvent) => { messages: unknown[] } | undefined,
	): void;
	registerRemovedToolHint?(name: string, hint: string): void;
}

export type RegisterRemovedToolHint = (name: string, hint: string) => void;

/**
 * Stock Pi 0.85.1 has no removed-tool hint API. Its context hook can still make
 * the exact redirect visible to the model before the next provider request.
 * A host with the native API keeps the stronger immediate/UI behavior.
 */
export function createRemovedToolHintRegistrar(host: RemovedToolHintHost): RegisterRemovedToolHint {
	const nativeRegistrar = host.registerRemovedToolHint;
	if (typeof nativeRegistrar === "function") {
		return (name, hint) => nativeRegistrar.call(host, name, hint);
	}

	const hints = new Map<string, string>();
	host.on("context", (event) => {
		let changed = false;
		const messages = event.messages.map((message) => {
			const next = appendRemovedToolHint(message, hints);
			changed ||= next !== message;
			return next;
		});
		return changed ? { messages } : undefined;
	});
	return (name, hint) => hints.set(name, hint);
}

function appendRemovedToolHint(message: unknown, hints: ReadonlyMap<string, string>): unknown {
	if (!isRecord(message) || message.role !== "toolResult" || message.isError !== true || typeof message.toolName !== "string") {
		return message;
	}
	const hint = hints.get(message.toolName);
	if (hint === undefined || !Array.isArray(message.content)) return message;
	const notFound = `Tool ${message.toolName} not found`;
	let changed = false;
	const content = message.content.map((part) => {
		if (!isRecord(part) || part.type !== "text" || part.text !== notFound) return part;
		changed = true;
		return { ...part, text: `${notFound}. ${hint}` };
	});
	return changed ? { ...message, content } : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
