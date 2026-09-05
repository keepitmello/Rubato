import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const FILE = join(
  repoRoot,
  "harness",
  "pi-patches",
  "pi-coding-agent",
  "0.84.2",
  "owned",
  "dist",
  "modes",
  "provider-native-rendering.js",
);

test("provider-native-rendering exports the UI helper names", async () => {
  assert.equal(existsSync(FILE), true);
  const mod = await import(pathToFileURL(FILE).href);
  assert.equal(typeof mod.formatProviderNativeBody, "function");
  assert.equal(typeof mod.formatProviderNativeSummary, "function");
  assert.equal(typeof mod.stringifyProviderNative, "function");
  const block = { subtype: "compaction", raw: { type: "compaction", content: "SUMMARY" } };
  const summary = mod.formatProviderNativeSummary({ provider: "anthropic" }, block, false);
  assert.match(summary, /compaction/);
  const body = mod.formatProviderNativeBody(block, true);
  assert.match(body, /SUMMARY/);
});
