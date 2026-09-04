import test from "node:test";
import assert from "node:assert/strict";
import { compileCacheDir } from "../../src/compile-cache.mjs";

test("compile cache sits under the profile unless NODE_COMPILE_CACHE is set", () => {
  assert.match(compileCacheDir("/tmp/home", {}), /[/\\]\.rubato-pi[/\\]compile-cache$/);
  assert.equal(compileCacheDir("/tmp/home", { NODE_COMPILE_CACHE: "/tmp/cc" }), "/tmp/cc");
});
