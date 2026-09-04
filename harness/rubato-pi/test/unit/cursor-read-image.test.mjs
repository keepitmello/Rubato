import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { senpiNested } from "../../src/engine-paths.mjs";
import { injectCursorAgent } from "../../src/transforms/cursor-agent.mjs";
import { cursorReadImageBytes } from "../../src/transforms/cursor-read-image.mjs";

test("read tool image parts decode to the original bytes", () => {
  const bytes = cursorReadImageBytes({
    role: "toolResult",
    content: [
      { type: "text", text: "Read image file [image/jpeg]" },
      { type: "image", data: Buffer.from("jpeg-bytes").toString("base64"), mimeType: "image/jpeg" },
    ],
  });
  assert.deepEqual(bytes, Uint8Array.from(Buffer.from("jpeg-bytes")));
});

test("text-only read results stay undefined so the text path is used", () => {
  assert.equal(cursorReadImageBytes({ content: [{ type: "text", text: "hello" }] }), undefined);
  assert.equal(cursorReadImageBytes({ content: [] }), undefined);
  assert.equal(cursorReadImageBytes({}), undefined);
});

test("cursor-agent rewrite ships image bytes on native readResult", () => {
  const source = readFileSync(senpiNested("@earendil-works/pi-ai/dist/api/cursor-agent.js"), "utf8");
  const patched = injectCursorAgent(source);
  assert.match(patched, /cursorReadImageBytes/);
  assert.match(patched, /output: \{ case: "data", value: imageBytes \}/);
  assert.match(patched, /cursor-read-image\.mjs/);
});

test("cursor-agent rewrite does not teach that Task is a subagent", () => {
  const source = readFileSync(senpiNested("@earendil-works/pi-ai/dist/api/cursor-agent.js"), "utf8");
  const patched = injectCursorAgent(source);
  assert.doesNotMatch(patched, /Subagents are \$\{NOT_IMPLEMENTED_SUFFIX\}/);
  assert.match(
    patched,
    /Cursor Task is not available in this client\. Spawn with Agent using an exact model or preset\. Board work uses team_task_\*/,
  );
});
