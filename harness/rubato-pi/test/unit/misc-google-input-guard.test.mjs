import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { senpiNested } from "../../src/engine-paths.mjs";
import {
  injectGoogleSharedInputGuard,
  injectTransformMessagesInputGuard,
} from "../../src/transforms/misc-google-input-guard.mjs";

test("transform-messages guards missing model.input", () => {
  const source = readFileSync(senpiNested("@earendil-works/pi-ai/dist/api/transform-messages.js"), "utf8");
  const patched = injectTransformMessagesInputGuard(source);
  assert.match(patched, /model\.input\?\.includes\("image"\) === true/);
  assert.match(patched, /model\.input\?\.includes\("video"\) === true/);
  assert.doesNotMatch(patched, /const supportsImages = model\.input\.includes\("image"\)/);
});

test("google-shared guards missing model.input on toolResult images", () => {
  const source = readFileSync(senpiNested("@earendil-works/pi-ai/dist/api/google-shared.js"), "utf8");
  const patched = injectGoogleSharedInputGuard(source);
  assert.match(patched, /model\.input\?\.includes\("image"\)/);
  assert.doesNotMatch(patched, /const imageContent = model\.input\.includes\("image"\)/);
});
