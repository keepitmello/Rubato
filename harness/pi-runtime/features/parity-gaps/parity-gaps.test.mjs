import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  patchAuthStorage,
  patchEstimateProviderNative,
  patchGoogleSharedInputGuard,
  patchOverflow,
  patchPromptCacheTtl,
  patchToolDescriptions,
  files,
  patches,
} from "./patches.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
const stockPackageDir = (name) => resolvePiRuntime({ root: fileURLToPath(new URL("../..", import.meta.url)) }).packages[`@earendil-works/${name}`].dir;

const here = dirname(fileURLToPath(import.meta.url));
const ai = join(stockPackageDir("pi-ai"), "dist");
const ag = join(here, "../../node_modules/@earendil-works/pi-coding-agent/dist");

test("parity-gaps patches match stock preimages and apply", () => {
  const byId = Object.fromEntries(patches.map((p) => [p.id, p]));
  const overflow = readFileSync(join(ai, "utils/overflow.js"), "utf8");
  assert.equal(byId.overflow.preimageSha256.length, 64);
  const o = patchOverflow(overflow);
  assert.match(o, /conversation is too long/);
  assert.match(o, /message\.usage\.input \?\? 0/);
  const g = patchGoogleSharedInputGuard(readFileSync(join(ai, "api/google-shared.js"), "utf8"));
  assert.match(g, /model\.input\?\.includes\("image"\)/);
  const c = patchPromptCacheTtl(readFileSync(join(ai, "api/openai-responses.js"), "utf8"));
  assert.match(c, /return \{ ttl: "30m" \};\n    return \{ ttl: "30m" \};/);
  const a = patchAuthStorage(readFileSync(join(ag, "core/auth-storage.js"), "utf8"));
  assert.match(a, /function atomicWriteAuthFileSync/);
  assert.match(a, /atomicWriteAuthFileSync\(this\.authPath, next\)/);
  const t = patchToolDescriptions(readFileSync(join(ag, "core/tools/tool-definition-wrapper.js"), "utf8"));
  assert.match(t, /slimToolDescription\(definition\.name/);
  assert.match(t, /from "\.\.\/\.\.\/rubato-features\/parity-gaps\/slim\.mjs"/);
  assert.deepEqual(files.map((entry) => entry.path), ["dist/rubato-features/parity-gaps/slim.mjs"]);
});

test("token estimate survives an aborted answer that kept a provider-native block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-estimate-"));
  copyFileSync(join(ai, "utils/text.js"), join(dir, "text.js"));
  writeFileSync(join(dir, "estimate.js"), patchEstimateProviderNative(readFileSync(join(ai, "utils/estimate.js"), "utf8")));
  const { estimateContextTokens } = await import(pathToFileURL(join(dir, "estimate.js")).href);
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "hello" }], usage, stopReason: "stop", timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "go" }], timestamp: 3 },
    { role: "assistant", content: [
      { type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: null } },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    ], usage, stopReason: "aborted", timestamp: 4 },
    { role: "user", content: [{ type: "text", text: "again" }], timestamp: 5 },
  ];
  const estimate = estimateContextTokens({ messages });
  assert.equal(estimate.lastUsageIndex, 1);
  assert.ok(estimate.trailingTokens > 0);
});
