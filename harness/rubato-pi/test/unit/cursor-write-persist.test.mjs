import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { senpiDir } from "../../src/engine-paths.mjs";
import {
  injectCursorEditPersist,
  injectCursorWritePersist,
} from "../../src/transforms/cursor-write-persist.mjs";

test("write tool re-reads the path before reporting success", () => {
  const source = readFileSync(join(senpiDir, "dist/core/tools/write.js"), "utf8");
  const next = injectCursorWritePersist(source);
  assert.match(next, /Write did not persist to disk/);
  assert.notEqual(next, source);
});

test("edit tool re-reads the path before reporting success", () => {
  const source = readFileSync(join(senpiDir, "dist/core/tools/edit.js"), "utf8");
  const next = injectCursorEditPersist(source);
  assert.match(next, /Edit did not persist to disk/);
  assert.notEqual(next, source);
});
