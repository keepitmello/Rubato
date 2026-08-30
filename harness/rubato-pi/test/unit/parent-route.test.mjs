import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { routeCompletion } from "../../src/parent-route.mjs";
import { rubatoTaskExtension } from "../../src/engine-paths.mjs";

test("compacting buffers completions instead of dropping them", () => {
  assert.deepEqual(routeCompletion("compacting"), { kind: "buffer", reason: "compacting" });
  assert.deepEqual(routeCompletion("idle"), { kind: "wake" });
});

test("the pinned task bundle still routes compacting to buffer", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const bundle = readFileSync(rubatoTaskExtension, "utf8");
  assert.match(bundle, /case"compacting":return\{kind:"buffer",reason:"compacting"\}/);
});
