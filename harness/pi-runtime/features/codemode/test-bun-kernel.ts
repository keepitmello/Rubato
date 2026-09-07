import { JavaScriptKernel } from "./src/kernels/js/context-manager.ts";

const messages: unknown[] = [];
const kernel = new JavaScriptKernel({
	sessionId: "bun-process-contract",
	cwd: process.cwd(),
	parallelPoolWidth: 2,
	onMessage: (message) => messages.push(message),
});

try {
	const first = await kernel.run({ cellId: "first", code: "globalThis.saved = 41; saved" });
	if (!first.ok || !first.valueRepr?.includes("41")) throw new Error(`Bun first cell failed: ${JSON.stringify(first)}`);
	const second = await kernel.run({ cellId: "second", code: "saved + 1" });
	if (!second.ok || !second.valueRepr?.includes("42")) throw new Error(`Bun persistence failed: ${JSON.stringify(second)}`);

	const toolRun = kernel.run({ cellId: "tool", code: "await tool.echo({ value: saved })" });
	const call = await kernel.nextToolCall();
	if (call.toolName !== "echo" || (call.args as { value?: unknown }).value !== 41) {
		throw new Error(`Bun tool call mismatch: ${JSON.stringify(call)}`);
	}
	kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: { echoed: 41 } });
	const toolResult = await toolRun;
	if (!toolResult.ok || !toolResult.valueRepr?.includes("41")) {
		throw new Error(`Bun tool reply failed: ${JSON.stringify(toolResult)}`);
	}

	const pending = kernel.run({ cellId: "interrupt", code: "await new Promise(() => {})" });
	await Bun.sleep(50);
	const interruption = await kernel.interrupt("bun process contract probe");
	const interrupted = await pending;
	if (interrupted.ok || !interrupted.error.message.includes("interrupted")) {
		throw new Error(`Bun interrupt failed: ${JSON.stringify(interrupted)}`);
	}
	if (await interruption.stateRetained) throw new Error("Bun worker state unexpectedly survived interrupt");
	const afterInterrupt = await kernel.run({ cellId: "after-interrupt", code: "typeof saved" });
	if (!afterInterrupt.ok || afterInterrupt.valueRepr !== '"undefined"') {
		throw new Error(`Bun worker did not reset after interrupt: ${JSON.stringify(afterInterrupt)}`);
	}
	console.log(JSON.stringify({ ok: true, bun: Bun.version, mode: kernel.mode, messages: messages.length }));
} finally {
	await kernel.close();
}
