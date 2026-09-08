import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { senpiDir } from "../../src/engine-paths.mjs";
import { applyCoreSessionTransforms } from "../../src/transforms/core-session.mjs";
import {
  injectMcpAttachNonblocking,
  isMcpIndexUrl,
} from "../../src/transforms/core-tool-surface.mjs";

const INDEX = join(senpiDir, "dist/core/extensions/builtin/mcp/index.js");

function applyNoThrow(url, source) {
  const warnings = [];
  const next = applyCoreSessionTransforms(url, source, (text, transform) => {
    try {
      return transform(text);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return text;
    }
  });
  return { next, warnings };
}

test("url matcher picks the MCP index only", () => {
  assert.equal(isMcpIndexUrl(pathToFileURL(INDEX).href), true);
  assert.equal(isMcpIndexUrl(pathToFileURL(join(senpiDir, "dist/core/extensions/builtin/mcp/expose/naming.js")).href), false);
});

test("MCP attach does not hold session_start; first turn still waits for tools", () => {
  const pristine = readFileSync(INDEX, "utf8");
  const patched = injectMcpAttachNonblocking(pristine);
  assert.match(patched, /void work;/);
  assert.equal(patched.includes("return work;"), false);
  assert.match(patched, /await \(attachPromise \?\? attach\(/);
  assert.throws(() => injectMcpAttachNonblocking(patched), /mcp session_start never awaits attach/);
  const { next, warnings } = applyNoThrow(pathToFileURL(INDEX).href, pristine);
  assert.equal(warnings.length, 0, warnings.join("; "));
  assert.match(next, /await \(attachPromise \?\? attach\(/);
});
