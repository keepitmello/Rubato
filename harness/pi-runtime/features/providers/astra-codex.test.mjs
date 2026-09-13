import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { patchOpenAiCodexResponsesAstra, patchTransformMessagesPreserve } from "./astra-codex.mjs";

const stockPiAi = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist",
);

test("Codex Responses freezes Astra effort as configuration_update and keeps WS thinking", () => {
	const stock = readFileSync(join(stockPiAi, "api/openai-codex-responses.js"), "utf8");
	const patched = patchOpenAiCodexResponsesAstra(stock);
	assert.match(patched, /applyAstraConfigurationUpdate\(body, model, cacheSessionId/);
	assert.match(patched, /type: "configuration_update"/);
	assert.match(patched, /preserveThinking: !!fullBody\.reasoning/);
	assert.match(patched, /preserveTextSignatures: true/);
	assert.match(patched, /isAstraConfigurationUpdateModel\(model\)/);
	assert.match(patched, /SESSION_WEBSOCKET_CACHE_TTL_MS = 30 \* 60 \* 1000/);
	assert.match(patched, /entry\.idleTimer\.unref\?/);
});

test("transformMessages accepts senpi preserveThinking / preserveTextSignatures options", () => {
	const stock = readFileSync(join(stockPiAi, "api/transform-messages.js"), "utf8");
	const patched = patchTransformMessagesPreserve(stock);
	assert.match(patched, /normalizeToolCallId, options = \{\}/);
	assert.match(patched, /options\.preserveThinking \?\? true/);
	assert.match(patched, /preserveProviderState \|\| preserveTextSignatures/);
});
