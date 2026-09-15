import test from "node:test";
import assert from "node:assert/strict";
import { routeCompletion } from "../../src/parent-route.mjs";

test("compacting buffers completions instead of dropping them", () => {
  assert.deepEqual(routeCompletion("compacting"), { kind: "buffer", reason: "compacting" });
  assert.deepEqual(routeCompletion("idle"), { kind: "wake" });
});
