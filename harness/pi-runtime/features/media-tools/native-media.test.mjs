import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stagePiRuntime } from "../../stage-runtime.mjs";
import { toolExecutionFeature } from "../tool-execution/index.mjs";
import { feature as videoInFeature, patchAnthropicMessagesVideo } from "../video-in/patches.mjs";
import {
	feature,
	patchAnthropicMessagesNative,
	patchOpenAiResponsesShared,
	patches,
} from "./patches.mjs";
import { addAnthropicBashToPayload, isAnthropicBashEnabled, materializeAnthropicBash } from "./src/anthropic-bash/index.js";
import { externalizeNativeImages } from "./src/openai-image-gen/externalize.js";
import { applyImageGenerationTools } from "./src/openai-image-gen/inject.js";
import {
	addOpenAiWebSearchToPayload,
	isOpenaiWebSearchEnabled,
	materializeOpenAiWebSearch,
} from "./src/openai-web-search/index.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stockPiAi = join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist");
const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function withEnv(name, value, fn) {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	return Promise.resolve().then(fn).finally(() => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	});
}

function openaiModel() {
	return {
		provider: "openai",
		api: "openai-responses",
		id: "gpt-5",
		name: "GPT fixture",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
	};
}

function anthropicModel() {
	return {
		provider: "anthropic",
		api: "anthropic-messages",
		id: "claude-sonnet-4-5",
		name: "Claude fixture",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
	};
}

function assistantOutput(model) {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function* asStream(events) {
	for (const event of events) yield event;
}

function sseBody(events) {
	return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function mockAnthropicClient(events) {
	return {
		beta: {
			messages: {
				create: () => ({
					asResponse: async () => new Response(sseBody(events), { headers: { "content-type": "text/event-stream" } }),
				}),
			},
		},
	};
}

function imageEvents() {
	const item = { type: "image_generation_call", id: "ig_1", status: "completed", result: PNG_DATA, revised_prompt: "one pixel" };
	return [
		{ type: "response.created", response: { id: "resp_img" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "image_generation_call", id: "ig_1", status: "in_progress" } },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_img", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	];
}

function webSearchEvents() {
	const item = {
		type: "web_search_call",
		id: "ws_1",
		status: "completed",
		action: { type: "search", query: "rubato runtime", sources: [{ title: "Rubato", url: "https://example.com/rubato" }] },
	};
	return [
		{ type: "response.created", response: { id: "resp_ws" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "in_progress" } },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", status: "in_progress", content: [], role: "assistant" } },
		{ type: "response.output_text.delta", output_index: 1, delta: "Found it." },
		{ type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Found it." }] } },
		{ type: "response.completed", response: { id: "resp_ws", status: "completed", output: [item, { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Found it." }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	];
}

function bashEvents(modelId) {
	return [
		{ type: "message_start", message: { id: "msg_bash", model: modelId, usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "bash", input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"echo hi\"}" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "bash_code_execution_tool_result", tool_use_id: "srvtoolu_1", content: { type: "bash_code_execution_result", stdout: "hi\n", stderr: "", return_code: 0 } } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
		{ type: "message_stop" },
	];
}

function textEvents(modelId, text) {
	return [
		{ type: "message_start", message: { id: "msg_text", model: modelId, usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	];
}

test("stock parser hashes match media-tools patch preimages", () => {
	const byPath = Object.fromEntries(patches.map((patch) => [patch.path, patch]));
	assert.equal(sha256(readFileSync(join(stockPiAi, "api/openai-responses-shared.js"))), byPath["dist/api/openai-responses-shared.js"].preimageSha256);
	assert.equal(sha256(readFileSync(join(stockPiAi, "api/anthropic-messages.js"))), byPath["dist/api/anthropic-messages.js"].preimageSha256);
	assert.equal(sha256(readFileSync(join(stockPiAi, "types.d.ts"))), byPath["dist/types.d.ts"].preimageSha256);
});

test("A10 convertContentBlocks anchors survive the anthropic native patch", () => {
	const stock = readFileSync(join(stockPiAi, "api/anthropic-messages.js"), "utf8");
	const patched = patchAnthropicMessagesNative(stock);
	const composed = patchAnthropicMessagesVideo(patched);
	assert.match(patched, /subtype: event.content_block.type/);
	assert.match(composed, /type: "video"/);
	assert.match(composed, /subtype: event.content_block.type/);
});

test("native image injection keeps client and Responses tools mutually exclusive", () => {
	const payload = { tools: [{ type: "function", name: "generate_image" }, { type: "image_generation" }] };
	assert.deepEqual(applyImageGenerationTools(payload, "native").tools, [{ type: "image_generation" }]);
	assert.deepEqual(applyImageGenerationTools(payload, "client").tools, [{ type: "function", name: "generate_image" }]);
});

test("PI_OPENAI_WEB_SEARCH defaults on and honors the product disabled list", async () => {
	await withEnv("PI_OPENAI_WEB_SEARCH", undefined, () => {
		assert.equal(isOpenaiWebSearchEnabled(), true);
	});
	await withEnv("PI_OPENAI_WEB_SEARCH", "off", () => {
		assert.equal(isOpenaiWebSearchEnabled(), false);
	});
	const model = { api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
	const injected = addOpenAiWebSearchToPayload(model, { tools: [] });
	assert.equal(injected.tools.some((tool) => tool.type === "web_search_preview"), true);
	assert.equal(injected.include.includes("web_search_call.action.sources"), true);
	await withEnv("PI_OPENAI_WEB_SEARCH", "0", () => {
		const stripped = addOpenAiWebSearchToPayload(model, { tools: [] });
		assert.equal((stripped.tools ?? []).some((tool) => String(tool.type).startsWith("web_search")), false);
	});
	const defaults = readFileSync(resolve(runtimeRoot, "../../harness/rubato-pi/src/session-defaults.mjs"), "utf8");
	assert.match(defaults, /DISABLED_WEB_SEARCH_EXTENSIONS = \["anthropic-web-search", "websearch"\]/);
	assert.equal(defaults.includes("openai-web-search"), false);
});

test("PI_ANTHROPIC_BASH defaults off and injects bash_20250124 when on", async () => {
	await withEnv("PI_ANTHROPIC_BASH", undefined, () => {
		assert.equal(isAnthropicBashEnabled(), false);
		assert.deepEqual(addAnthropicBashToPayload("anthropic-messages", { tools: [{ name: "bash", type: "function" }] }), { tools: [{ name: "bash", type: "function" }] });
	});
	await withEnv("PI_ANTHROPIC_BASH", "on", () => {
		assert.equal(isAnthropicBashEnabled(), true);
		const payload = addAnthropicBashToPayload("anthropic-messages", { tools: [{ name: "bash", type: "function" }] });
		assert.deepEqual(payload.tools, [{ type: "bash_20250124", name: "bash" }]);
	});
});

test("externalize writes generated PNG and scrubs the native base64 block", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "a14-image-"));
	try {
		const message = {
			role: "assistant",
			content: [{ type: "providerNative", subtype: "image_generation_call", raw: { type: "image_generation_call", id: "ig_1", status: "completed", result: PNG_DATA, revised_prompt: "one pixel" } }],
		};
		const next = await externalizeNativeImages(message, cwd);
		assert.match(next.content[0].text, /Generated image: generated-images\/ig_1\.png/);
		assert.equal(existsSync(join(cwd, "generated-images", "ig_1.png")), true);
		assert.equal(JSON.stringify(next).includes(PNG_DATA), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("staged stock SDK parses native image, web search, and anthropic bash from local mock streams", async (t) => {
	const scratch = mkdtempSync(join(tmpdir(), "a14-native-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const staged = await stagePiRuntime({
		sourceRoot: runtimeRoot,
		outputRoot: join(scratch, "engine"),
		features: [toolExecutionFeature, feature, videoInFeature],
	});
	const outputRoot = join(scratch, "engine");
	const piAiPath = join(outputRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist");
	const { processResponsesStream } = await import(pathToFileURL(join(piAiPath, "api/openai-responses-shared.js")).href);
	const { AssistantMessageEventStream } = await import(pathToFileURL(join(piAiPath, "utils/event-stream.js")).href);
	const anthropic = await import(pathToFileURL(join(piAiPath, "api/anthropic-messages.js")).href);
	const stockProcess = (await import(pathToFileURL(join(stockPiAi, "api/openai-responses-shared.js")).href)).processResponsesStream;

	const model = openaiModel();
	const stockOut = assistantOutput(model);
	await stockProcess(asStream(imageEvents()), stockOut, new AssistantMessageEventStream(), model, {});
	assert.equal(stockOut.content.some((block) => block.type === "providerNative"), false);

	const imageOut = assistantOutput(model);
	await processResponsesStream(asStream(imageEvents()), imageOut, new AssistantMessageEventStream(), model, {});
	assert.equal(imageOut.content[0].type, "providerNative");
	assert.equal(imageOut.content[0].subtype, "image_generation_call");
	assert.equal(imageOut.content[0].raw.result, PNG_DATA);
	const saved = await externalizeNativeImages(imageOut, scratch);
	assert.equal(existsSync(join(scratch, "generated-images", "ig_1.png")), true);
	assert.equal(JSON.stringify(saved).includes(PNG_DATA), false);
	assert.match(saved.content[0].text, /Generated image:/);

	const searchOut = assistantOutput(model);
	await processResponsesStream(asStream(webSearchEvents()), searchOut, new AssistantMessageEventStream(), model, {});
	const searchBlock = searchOut.content.find((block) => block.type === "providerNative");
	assert.equal(searchBlock?.subtype, "web_search_call");
	assert.equal(searchBlock.raw.action.sources[0].url, "https://example.com/rubato");
	const rendered = materializeOpenAiWebSearch(searchOut);
	assert.match(rendered.content.find((block) => block.type === "text" && block.text.startsWith("Web search")).text, /https:\/\/example.com\/rubato/);

	const claude = anthropicModel();
	const bashMessage = await anthropic.stream(claude, { messages: [{ role: "user", content: "run echo" }], systemPrompt: "test", tools: [] }, { client: mockAnthropicClient(bashEvents(claude.id)) }).result();
	assert.equal(bashMessage.content[0].type, "providerNative");
	assert.equal(bashMessage.content[0].subtype, "server_tool_use");
	assert.equal(bashMessage.content[0].raw.input.command, "echo hi");
	assert.equal(bashMessage.content[1].subtype, "bash_code_execution_tool_result");
	const landed = materializeAnthropicBash(bashMessage);
	assert.match(landed.content.at(-1).text, /Native bash result:[\s\S]*hi/);

	let replayed;
	await anthropic.stream(claude, { messages: [{ role: "user", content: "run echo" }, bashMessage], systemPrompt: "test", tools: [] }, {
		client: mockAnthropicClient(textEvents(claude.id, "done")),
		onPayload: (payload) => {
			replayed = payload;
			return payload;
		},
	}).result();
	const assistant = replayed.messages.find((message) => message.role === "assistant");
	assert.equal(assistant.content.some((block) => block.type === "server_tool_use" && block.input.command === "echo hi"), true);
	assert.equal(assistant.content.some((block) => block.type === "bash_code_execution_tool_result"), true);

	await withEnv("PI_ANTHROPIC_BASH", "on", async () => {
		let payload;
		await anthropic.stream(claude, { messages: [{ role: "user", content: "hi" }], systemPrompt: "test", tools: [{ name: "bash", description: "shell", parameters: { type: "object", properties: {} } }] }, {
			client: mockAnthropicClient(textEvents(claude.id, "ok")),
			onPayload: (next) => {
				payload = addAnthropicBashToPayload(claude.api, next);
				return payload;
			},
		}).result();
		assert.equal(payload.tools.some((tool) => tool.type === "bash_20250124"), true);
	});
});
