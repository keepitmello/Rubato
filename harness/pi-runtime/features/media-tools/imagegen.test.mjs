import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { PRODUCT_MODEL_ORDER } from "../../../../packages/model-core/src/product-model-catalog.mjs";
import { CHAIN_LIMIT, nextChain } from "./src/imagegen/chain.js";
import { AUTH_MODEL_ID, CODEX_PROVIDER, IMAGE_MODELS, imageEndpoint } from "./src/imagegen/codex.js";
import { displayPath, resolveTarget, sanitizeImageStem } from "./src/imagegen/paths.js";
import { imageCreateTool, imageEditTool } from "./src/imagegen/tool.js";

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const OTHER_PNG = Buffer.from("other source image").toString("base64");
const ACCOUNT_ID = "acct-fixture";
const TOKEN = ["header", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } })).toString("base64url"), "sig"].join(".");

function textOf(result) {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function jsonReply(status, body) {
	return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const imageReply = () => jsonReply(200, { data: [{ b64_json: PNG_DATA, generation_id: "gen_1" }], usage: { input_tokens: 5, output_tokens: 9 } });

function fakeRegistry({ oauth = true, baseUrl = "https://chatgpt.com/backend-api", registered = true } = {}) {
	const model = { provider: CODEX_PROVIDER, id: AUTH_MODEL_ID, api: "openai-codex-responses", baseUrl };
	return {
		find: (provider, id) => (registered && provider === CODEX_PROVIDER && id === AUTH_MODEL_ID ? model : undefined),
		isUsingOAuth: (candidate) => candidate === model && oauth,
		getApiKeyAndHeaders: async (candidate) => (candidate === model ? { ok: true, apiKey: TOKEN, headers: { "x-provider": "codex" } } : { ok: false, error: "unknown model" }),
		complete: async () => {
			throw new Error("image tools must not call a chat model");
		},
	};
}

function fixture(t, { reply = imageReply, ...registryOptions } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "rubato-imagegen-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
		return reply();
	};
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	const branch = [];
	const ctx = { cwd, modelRegistry: fakeRegistry(registryOptions), sessionManager: { getBranch: () => branch } };
	let callCount = 0;
	const run = async (tool, params) => {
		callCount += 1;
		const result = await tool.execute(`call-${callCount}`, params, undefined, undefined, ctx);
		branch.push({ type: "message", message: { role: "toolResult", toolName: tool.name, details: result.details } });
		return result;
	};
	return { cwd, calls, run };
}

test("image tools read the login through the picker's Codex flagship and name the two Images 2.5 tiers", () => {
	assert.equal(AUTH_MODEL_ID, PRODUCT_MODEL_ORDER["openai-codex"][0]);
	assert.deepEqual(IMAGE_MODELS, { create: "gpt-image-2.5-flare", edit: "gpt-image-2.5-sunburst" });
});

test("image requests go to the Codex image endpoints whatever form the provider base URL takes", () => {
	for (const base of ["https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/", "https://chatgpt.com/backend-api/codex", "https://chatgpt.com/backend-api/codex/responses"]) {
		assert.equal(imageEndpoint(base, "generations"), "https://chatgpt.com/backend-api/codex/images/generations", base);
		assert.equal(imageEndpoint(base, "edits"), "https://chatgpt.com/backend-api/codex/images/edits", base);
	}
});

test("image tools refuse every credential except the ChatGPT login, before any request", async (t) => {
	for (const [label, options] of [
		["no Codex model", { registered: false }],
		["gateway base URL", { baseUrl: "https://api.b.ai/v1" }],
		["API key instead of OAuth", { oauth: false }],
	]) {
		const { cwd, calls, run } = fixture(t, options);
		for (const tool of [imageCreateTool, imageEditTool]) {
			const refused = await run(tool, { prompt: "refuse me", output_path: "refused.png" });
			assert.equal(refused.details.reason, "missing_config", label);
		}
		assert.equal(calls.length, 0, label);
		assert.equal(existsSync(join(cwd, "refused.png")), false, label);
	}
	const { run } = fixture(t, { oauth: false });
	assert.match(textOf(await run(imageCreateTool, { prompt: "x" })), /OpenAI ChatGPT login/);
});

test("image_create sends the prompt unchanged straight to the image endpoint and saves the PNG", async (t) => {
	const { cwd, calls, run } = fixture(t);
	const prompt = "a bakery sign that reads \"OPEN\", flat vector, no shadow";
	const created = await run(imageCreateTool, { prompt: `  ${prompt}  `, size: "1536x1024", output_path: "art/sign" });

	const [call] = calls;
	assert.equal(call.url, "https://chatgpt.com/backend-api/codex/images/generations");
	assert.deepEqual(call.body, { model: "gpt-image-2.5-flare", prompt, n: 1, output_format: "png", size: "1536x1024" });
	assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
	assert.equal(call.headers["chatgpt-account-id"], ACCOUNT_ID);
	assert.equal(call.headers["x-provider"], "codex");

	assert.deepEqual(readFileSync(join(cwd, "art/sign.png")), Buffer.from(PNG_DATA, "base64"));
	assert.equal(created.details.path, "art/sign.png");
	assert.equal(created.details.imageModel, "gpt-image-2.5-flare");
	assert.equal(created.details.prompt, prompt);
	assert.equal("revisedPrompt" in created.details, false);
	assert.doesNotMatch(textOf(created), /Revised prompt/);
	assert.deepEqual(created.details.chain, [{ prompt }]);
	assert.equal(created.content.find((part) => part.type === "image")?.data, PNG_DATA);
	assert.equal(created.usage.input, 5);
	assert.equal(created.usage.output, 9);
	assert.equal(created.usage.cost.total, 0);
});

test("image_edit continues the session's last image with Sunburst and the earlier requests", async (t) => {
	const { cwd, calls, run } = fixture(t);
	await run(imageCreateTool, { prompt: "a red bicycle", output_path: "bike.png" });
	const continued = await run(imageEditTool, { prompt: "make it blue", quality: "high", output_path: "bike-blue.png" });

	const call = calls.at(-1);
	assert.equal(call.url, "https://chatgpt.com/backend-api/codex/images/edits");
	assert.equal(call.body.model, "gpt-image-2.5-sunburst");
	assert.equal(call.body.quality, "high");
	assert.match(call.body.prompt, /1\. a red bicycle/);
	assert.match(call.body.prompt, /make it blue$/);
	assert.deepEqual(call.body.images, [{ image_url: `data:image/png;base64,${PNG_DATA}` }]);
	assert.equal(continued.details.continued, true);
	assert.deepEqual(continued.details.inputs, ["bike.png"]);
	assert.deepEqual(continued.details.chain, [{ prompt: "a red bicycle" }, { prompt: "make it blue" }]);
	assert.match(textOf(continued), /Continued from bike\.png/);

	await run(imageEditTool, { prompt: "add a basket", output_path: "bike-basket.png" });
	assert.match(calls.at(-1).body.prompt, /1\. a red bicycle\n2\. make it blue/);

	writeFileSync(join(cwd, "photo.jpg"), Buffer.from(OTHER_PNG, "base64"));
	const fresh = await run(imageEditTool, { prompt: "remove the background", images: ["photo.jpg"], output_path: "cutout.png" });
	assert.equal(calls.at(-1).body.prompt, "remove the background");
	assert.deepEqual(calls.at(-1).body.images, [{ image_url: `data:image/jpeg;base64,${OTHER_PNG}` }]);
	assert.equal(fresh.details.continued, false);
	assert.deepEqual(fresh.details.chain, [{ prompt: "remove the background" }]);
});

test("image_edit refuses without a source, and failures leave no file", async (t) => {
	const { cwd, calls, run } = fixture(t);
	const nothing = await run(imageEditTool, { prompt: "edit what?" });
	assert.equal(nothing.details.reason, "invalid_params");
	assert.match(textOf(nothing), /no earlier image/);
	assert.equal((await run(imageEditTool, { prompt: "x", images: ["missing.png"] })).details.reason, "invalid_params");
	writeFileSync(join(cwd, "notes.txt"), "not an image");
	assert.match(textOf(await run(imageEditTool, { prompt: "x", images: ["notes.txt"] })), /not a PNG, JPEG, WebP or GIF/);
	writeFileSync(join(cwd, "taken.png"), "owned");
	assert.match(textOf(await run(imageCreateTool, { prompt: "x", output_path: "taken.png" })), /already exists/);
	assert.equal((await run(imageCreateTool, { prompt: "   " })).details.reason, "invalid_params");
	assert.equal(calls.length, 0);

	const failing = fixture(t, { reply: () => jsonReply(500, { error: { message: "backend said no" } }) });
	const errored = await failing.run(imageCreateTool, { prompt: "x", output_path: "error.png" });
	assert.equal(errored.details.reason, "provider_error");
	assert.match(textOf(errored), /HTTP 500: backend said no/);
	assert.equal(existsSync(join(failing.cwd, "error.png")), false);

	const blocked = fixture(t, {
		reply: () => jsonReply(400, { error: { code: "moderation_blocked", message: "rejected", moderation_details: { moderation_stage: "input", categories: ["sexual"] } } }),
	});
	const refused = await blocked.run(imageCreateTool, { prompt: "x", output_path: "refused.png" });
	assert.equal(refused.details.reason, "moderation_blocked");
	assert.match(textOf(refused), /stage: input; categories: sexual/);
	assert.match(textOf(refused), /sent exactly as written/);
	assert.equal(existsSync(join(blocked.cwd, "refused.png")), false);
	// A failed edit does not become the next continuation source.
	assert.equal((await blocked.run(imageEditTool, { prompt: "continue" })).details.reason, "invalid_params");

	const empty = fixture(t, { reply: () => jsonReply(200, { data: [] }) });
	assert.equal((await empty.run(imageCreateTool, { prompt: "x", output_path: "empty.png" })).details.reason, "no_image");
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
