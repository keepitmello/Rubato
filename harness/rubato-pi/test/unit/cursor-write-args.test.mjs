import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { senpiDir } from "../../src/engine-paths.mjs";
import { injectCursorExecBridge } from "../../src/transforms/cursor-exec-bridge.mjs";
import { persistWriteToHostDisk } from "../../src/transforms/cursor-write-host-fs.mjs";
import { cursorWriteContent, missingCursorWriteContentMessage } from "../../src/transforms/cursor-write-args.mjs";

test("prefers fileText, then contents, then content, then fileBytes", () => {
  assert.equal(cursorWriteContent({ fileText: "a", contents: "b" }), "a");
  assert.equal(cursorWriteContent({ contents: "b", content: "c" }), "b");
  assert.equal(cursorWriteContent({ content: "c" }), "c");
  assert.equal(cursorWriteContent({ fileBytes: new TextEncoder().encode("d") }), "d");
});

test("missing body is undefined so the bridge can refuse instead of writing empty", () => {
  assert.equal(cursorWriteContent({ path: "x.ts" }), undefined);
  assert.equal(cursorWriteContent(null), undefined);
  assert.match(missingCursorWriteContentMessage(), /fileText\/contents\/content\/fileBytes/);
});

test("injected bridge refuses a write frame with no file body and accepts contents", () => {
  const source = readFileSync(join(senpiDir, "dist/core/cursor-exec-bridge.js"), "utf8");
  const next = injectCursorExecBridge(source);
  assert.match(next, /args\.contents/);
  assert.match(next, /missing file text/);
});

test("injected bridge writes through host disk persist, not tool success alone", () => {
  const source = readFileSync(join(senpiDir, "dist/core/cursor-exec-bridge.js"), "utf8");
  const next = injectCursorExecBridge(source);
  assert.match(next, /persistWriteToHostDisk/);
  assert.match(next, /persistCursorWrite/);
  assert.match(next, /StrReplace/);
});
