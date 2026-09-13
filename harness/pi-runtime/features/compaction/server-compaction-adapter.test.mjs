import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { patchAnthropicMessagesNative } from "../media-tools/patches.mjs";
import { patchAnthropicMessagesVideo } from "../video-in/patches.mjs";
import {
  ANTHROPIC_SERVER_COMPACTION_ADAPTER_MARKER,
  ANTHROPIC_SERVER_COMPACTION_LANE_MARKER,
} from "./anthropic-server-compaction.mjs";
import { createCompactionExtension } from "./extension.mjs";
import { patchAnthropicMessagesServerCompaction } from "./patches.mjs";

const stockPiAi = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist",
);

function chainedAnthropicMessages() {
  const stock = readFileSync(join(stockPiAi, "api/anthropic-messages.js"), "utf8");
  return patchAnthropicMessagesServerCompaction(
    patchAnthropicMessagesVideo(patchAnthropicMessagesNative(stock)),
  );
}

test("server compaction adapter survives media-tools and video-in chaining", () => {
  const patched = chainedAnthropicMessages();
  assert.match(patched, /else if \(event\.content_block\.type === "compaction"\)/);
  assert.match(patched, /event\.delta\.type === "compaction_delta"/);
  assert.match(patched, /blocks\.push\(\{ type: "compaction", content \}\)/);
  assert.match(patched, /shouldOmitThinkingBeforeCompaction/);
  assert.match(patched, new RegExp(ANTHROPIC_SERVER_COMPACTION_ADAPTER_MARKER.replaceAll(".", "\\.")));
});

test("compaction-only staging still applies the params seam without the native adapter", () => {
  const stock = readFileSync(join(stockPiAi, "api/anthropic-messages.js"), "utf8");
  const patched = patchAnthropicMessagesServerCompaction(stock);
  assert.match(patched, /applyAnthropicServerCompactionParams/);
  assert.equal(patched.includes("compaction_delta"), false);
});

test("creating the compaction extension arms the server-compaction lane marker", () => {
  const settingsManager = { getCompactionSettings() { return { enabled: true }; } };
  createCompactionExtension({ settingsManager });
  assert.equal(globalThis[Symbol.for(ANTHROPIC_SERVER_COMPACTION_LANE_MARKER)], true);
});
