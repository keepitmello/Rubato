import assert from "node:assert/strict";
import test from "node:test";

import {
  CHILD_EXTENSIONS_ENV,
  applyChildExtensionsEnv,
} from "../../src/runtime-env.mjs";

test("child extension paths use the Rubato runtime env contract", () => {
globalThis.env = {};
  applyChildExtensionsEnv(env, ["/a.mjs", "/b.mjs"], ":");
  assert.equal(CHILD_EXTENSIONS_ENV, "RUBATO_MEMORY_CHILD_EXTENSIONS");
  assert.equal(env[CHILD_EXTENSIONS_ENV], "/a.mjs:/b.mjs");
});
