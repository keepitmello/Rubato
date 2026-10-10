import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { PRODUCT_MODEL_ORDER } from "../../../../packages/model-core/src/product-model-catalog.mjs";
import { CHAIN_LIMIT, nextChain } from "./src/imagegen/chain.js";
import { CODEX_PROVIDER, IMAGE_MODELS, ORCHESTRATOR_MODEL_ID } from "./src/imagegen/codex.js";
import { displayPath, resolveTarget, sanitizeImageStem } from "./src/imagegen/paths.js";
import { imageCreateTool, imageEditTool } from "./src/imagegen/tool.js";

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const OTHER_PNG = Buffer.from("other source image").toString("base64");

function textOf(result) {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function imageReply(revised = "fixture revised prompt") {
	return {
		role: "assistant",
		stopReason: "stop",
		content: [
			{ type: "providerNative", subtype: "image_generation_call", raw: { type: "image_generation_call", id: "ig_1", status: "completed", result: PNG_DATA, revised_prompt: revised } },
			{ type: "text", text: "Here is your image." },
		],
		usage: { input: 5, output: 9 },
	};
}

function fakeRegistry({ oauth = true, baseUrl = "https://chatgpt.com/backend-api", registered = true, reply } = {}) {
	const model = { provider: CODEX_PROVIDER, id: ORCHESTRATOR_MODEL_ID, api: "openai-codex-responses", baseUrl };
	const calls = [];
	return {
		calls,
		find: (provider, id) => (registered && provider === CODEX_PROVIDER && id === ORCHESTRATOR_MODEL_ID ? model : undefined),
		isUsingOAuth: (candidate) => candidate === model && oauth,
		complete: async (candidate, context, options) => {
			const payload = await options.onPayload({ model: candidate.id, tools: [{ type: "function", name: "session_tool" }], tool_choice: "required", parallel_tool_calls: true });
			calls.push({ model: candidate, context, options, payload });
			return reply ?? imageReply();
		},
	};
}

function fixture(t, registryOptions) {
	const cwd = mkdtempSync(join(tmpdir(), "rubato-imagegen-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const branch = [];
	const registry = fakeRegistry(registryOptions);
	const ctx = { cwd, modelRegistry: registry, sessionManager: { getBranch: () => branch } };
	let callCount = 0;
	const run = async (tool, params) => {
		callCount += 1;
		const result = await tool.execute(`call-${callCount}`, params, undefined, undefined, ctx);
		branch.push({ type: "message", message: { role: "toolResult", toolName: tool.name, details: result.details } });
		return result;
	};
	return { cwd, registry, run };
}

test("image tools follow the picker's Codex flagship and the two Images 2.5 tiers", () => {
	assert.equal(ORCHESTRATOR_MODEL_ID, PRODUCT_MODEL_ORDER["openai-codex"][0]);
	assert.deepEqual(IMAGE_MODELS, { create: "gpt-image-2.5-flare", edit: "gpt-image-2.5-sunburst" });
});

test("image tools refuse every credential except the ChatGPT login, before any request", async (t) => {
	for (const [label, options] of [
		["no Codex model", { registered: false }],
		["gateway base URL", { baseUrl: "https://api.b.ai/v1" }],
		["API key instead of OAuth", { oauth: false }],
	]) {
		const { cwd, registry, run } = fixture(t, options);
		for (const tool of [imageCreateTool, imageEditTool]) {
			const refused = await run(tool, { prompt: "refuse me", output_path: "refused.png" });
			assert.equal(refused.details.reason, "missing_config", label);
		}
		assert.equal(registry.calls.length, 0, label);
		assert.equal(existsSync(join(cwd, "refused.png")), false, label);
	}
	const { run } = fixture(t, { oauth: false });
	assert.match(textOf(await run(imageCreateTool, { prompt: "x" })), /OpenAI ChatGPT login/);
});

test("image_create sends Flare through the Codex model and saves the PNG", async (t) => {
	const { cwd, registry, run } = fixture(t);
	const created = await run(imageCreateTool, { prompt: "  a bakery sign  ", size: "1536x1024", output_path: "art/sign" });

	const [call] = registry.calls;
	assert.equal(call.model.id, ORCHESTRATOR_MODEL_ID);
	assert.deepEqual(call.payload.tools, [{ type: "image_generation", model: "gpt-image-2.5-flare", output_format: "png", size: "1536x1024" }]);
	assert.equal(call.payload.tool_choice, "auto");
	assert.equal(call.payload.parallel_tool_calls, false);
	assert.deepEqual(call.context.messages[0].content, [{ type: "text", text: "a bakery sign" }]);

	assert.deepEqual(readFileSync(join(cwd, "art/sign.png")), Buffer.from(PNG_DATA, "base64"));
	assert.equal(created.details.path, "art/sign.png");
	assert.equal(created.details.imageModel, "gpt-image-2.5-flare");
	assert.equal(created.details.orchestrator, `openai-codex/${ORCHESTRATOR_MODEL_ID}`);
	assert.equal(created.details.revisedPrompt, "fixture revised prompt");
	assert.deepEqual(created.details.chain, [{ prompt: "a bakery sign" }]);
	assert.equal(created.content.find((part) => part.type === "image")?.data, PNG_DATA);
	assert.deepEqual(created.usage, { input: 5, output: 9 });
});

test("image_edit continues the session's last image with Sunburst and the earlier requests", async (t) => {
	const { cwd, registry, run } = fixture(t);
	await run(imageCreateTool, { prompt: "a red bicycle", output_path: "bike.png" });
	const continued = await run(imageEditTool, { prompt: "make it blue", quality: "high", output_path: "bike-blue.png" });

	const call = registry.calls.at(-1);
	assert.deepEqual(call.payload.tools, [{ type: "image_generation", model: "gpt-image-2.5-sunburst", output_format: "png", quality: "high" }]);
	const [text, image] = call.context.messages[0].content;
	assert.match(text.text, /1\. a red bicycle/);
	assert.match(text.text, /make it blue$/);
	assert.deepEqual(image, { type: "image", data: PNG_DATA, mimeType: "image/png" });
	assert.equal(continued.details.continued, true);
	assert.deepEqual(continued.details.inputs, ["bike.png"]);
	assert.deepEqual(continued.details.chain, [{ prompt: "a red bicycle" }, { prompt: "make it blue" }]);
	assert.match(textOf(continued), /Continued from bike\.png/);

	await run(imageEditTool, { prompt: "add a basket", output_path: "bike-basket.png" });
	assert.match(registry.calls.at(-1).context.messages[0].content[0].text, /1\. a red bicycle\n2\. make it blue/);

	writeFileSync(join(cwd, "photo.jpg"), Buffer.from(OTHER_PNG, "base64"));
	const fresh = await run(imageEditTool, { prompt: "remove the background", images: ["photo.jpg"], output_path: "cutout.png" });
	const freshContent = registry.calls.at(-1).context.messages[0].content;
	assert.deepEqual(freshContent, [
		{ type: "text", text: "remove the background" },
		{ type: "image", data: OTHER_PNG, mimeType: "image/jpeg" },
	]);
	assert.equal(fresh.details.continued, false);
	assert.deepEqual(fresh.details.chain, [{ prompt: "remove the background" }]);
});

test("image_edit refuses without a source, and failures leave no file", async (t) => {
	const { cwd, registry, run } = fixture(t);
	const nothing = await run(imageEditTool, { prompt: "edit what?" });
	assert.equal(nothing.details.reason, "invalid_params");
	assert.match(textOf(nothing), /no earlier image/);
	assert.equal((await run(imageEditTool, { prompt: "x", images: ["missing.png"] })).details.reason, "invalid_params");
	writeFileSync(join(cwd, "notes.txt"), "not an image");
	assert.match(textOf(await run(imageEditTool, { prompt: "x", images: ["notes.txt"] })), /not a PNG, JPEG, WebP or GIF/);
	writeFileSync(join(cwd, "taken.png"), "owned");
	assert.match(textOf(await run(imageCreateTool, { prompt: "x", output_path: "taken.png" })), /already exists/);
	assert.equal((await run(imageCreateTool, { prompt: "   " })).details.reason, "invalid_params");
	assert.equal(registry.calls.length, 0);

	const failing = fixture(t, { reply: { role: "assistant", stopReason: "error", errorMessage: "backend said no", content: [] } });
	const errored = await failing.run(imageCreateTool, { prompt: "x", output_path: "error.png" });
	assert.equal(errored.details.reason, "provider_error");
	assert.match(textOf(errored), /backend said no/);
	assert.equal(existsSync(join(failing.cwd, "error.png")), false);

	const refusing = fixture(t, { reply: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "I can't draw that." }] } });
	const refused = await refusing.run(imageCreateTool, { prompt: "x", output_path: "refused.png" });
	assert.equal(refused.details.reason, "no_image");
	assert.match(textOf(refused), /I can't draw that\./);
	assert.equal(existsSync(join(refusing.cwd, "refused.png")), false);
	// A failed edit does not become the next continuation source.
	assert.equal((await refusing.run(imageEditTool, { prompt: "continue" })).details.reason, "invalid_params");
});

test("edit chains keep the most recent requests", () => {
	let chain = [];
	for (let index = 1; index <= CHAIN_LIMIT + 2; index += 1) chain = nextChain(chain, { prompt: `step ${index}` });
	assert.equal(chain.length, CHAIN_LIMIT);
	assert.equal(chain[0].prompt, "step 3");
});

test("image output paths stay deterministic, PNG-only, and tool-call-id safe", () => {
	const cwd = resolve(tmpdir(), "rubato-image-path-fixture");
	assert.equal(sanitizeImageStem("../unsafe/id"), "___unsafe_id");
	assert.deepEqual(resolveTarget(cwd, "../unsafe/id"), { ok: true, path: join(cwd, "generated-images/___unsafe_id.png") });
	assert.deepEqual(resolveTarget(cwd, "call", "artifacts/result"), { ok: true, path: join(cwd, "artifacts/result.png") });
	assert.match(resolveTarget(cwd, "call", "artifacts/result.jpg").error, /must end in \.png/);
	assert.equal(displayPath(cwd, join(cwd, "artifacts/result.png")), "artifacts/result.png");
});
