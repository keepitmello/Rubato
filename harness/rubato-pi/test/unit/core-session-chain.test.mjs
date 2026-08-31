import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../../src/no-changelog-hooks.mjs";
import {
  injectAgentSession,
  injectCompaction,
  isAgentSessionUrl,
  isCompactionUrl,
  isErrorFormatUrl,
  isOverflowUrl,
  isServiceTierUrl,
  isSpeculativeUrl,
} from "../../src/transforms/core-session.mjs";
import { vendorFileStates } from "./support/vendor-file-states.mjs";

function loaderFor(source) {
  return () => ({ format: "module", source, shortCircuit: true });
}

async function runLoad(url, source) {
  return await load(url, {}, loaderFor(source));
}

test("url matchers hit senpi dist and nested pi-ai overflow", () => {
  assert.equal(isCompactionUrl("file:///x/@code-yeongyu/senpi/dist/core/compaction/compaction.js"), true);
  assert.equal(isAgentSessionUrl("file:///x/@code-yeongyu/senpi/dist/core/agent-session.js"), true);
  assert.equal(isSpeculativeUrl("file:///x/@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/speculative.js"), true);
  assert.equal(isServiceTierUrl("file:///x/@code-yeongyu/senpi/dist/core/extensions/builtin/service-tier.js"), true);
  assert.equal(isErrorFormatUrl("file:///x/@code-yeongyu/senpi/dist/modes/interactive/extension-error-format.js"), true);
  // Wave-1 verified bun store still contains @earendil-works/pi-ai/dist/
  const bunOverflow =
    "file:///Users/x/node_modules/.bun/@code-yeongyu+senpi@2026.8.22/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/utils/overflow.js";
  assert.equal(isOverflowUrl(bunOverflow), true);
  assert.equal(isOverflowUrl(bunOverflow.replace("overflow.js", "overflow.d.ts")), false);
});

test("missing pristine needles throw so applyTransform can swallow drift", () => {
  assert.throws(() => injectCompaction("export function prepareCompaction() {}"), /core-session transform drift/);
  assert.throws(() => injectAgentSession("export class AgentSession {}"), /core-session transform drift/);
});

test("descriptors full loader: tui-chrome then core-session equals patched", async () => {
  const pair = vendorFileStates("senpi", "dist/modes/interactive/components/assistant-render-descriptors.js");
  assert.ok(pair);
  const url = "file:///x/node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/assistant-render-descriptors.js";
  const result = await runLoad(url, pair.pristine);
  assert.equal(String(result.source), pair.patched);
});

test("already-patched descriptors stay inert through the loader", async () => {
  const pair = vendorFileStates("senpi", "dist/modes/interactive/components/assistant-render-descriptors.js");
  assert.ok(pair);
  const url = "file:///x/node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/assistant-render-descriptors.js";
  const result = await runLoad(url, pair.patched);
  assert.equal(String(result.source), pair.patched);
});

test("pristine overflow is rewritten by the loader", async () => {
  const pair = vendorFileStates("pi-ai", "dist/utils/overflow.js");
  assert.ok(pair);
  const url =
    "file:///x/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/utils/overflow.js";
  const result = await runLoad(url, pair.pristine);
  assert.equal(String(result.source), pair.patched);
});
