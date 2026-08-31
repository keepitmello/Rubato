import assert from "node:assert/strict";
import test from "node:test";
import { injectAssistantDescriptors } from "../../src/transforms/assistant-descriptors.mjs";
import {
  injectAgentSession,
  injectCompaction,
  injectCoreDescriptors,
  injectErrorFormat,
  injectOverflow,
  injectProviderTimeoutRetry,
  injectServiceTier,
  injectSpeculative,
  injectStreamWatchdog,
  isCoreDescriptorsUrl,
  isProviderTimeoutRetryUrl,
  isStreamWatchdogUrl,
} from "../../src/transforms/core-session.mjs";
import { vendorFileStates } from "./support/vendor-file-states.mjs";

function states(alias, relativePath) {
  const pair = vendorFileStates(alias, relativePath);
  assert.ok(pair, `vendorFileStates(${alias}, ${relativePath}) must locate the series`);
  assert.notEqual(pair.pristine, pair.patched, `${relativePath} fixture must differ`);
  return pair;
}

test("stream-watchdog.js #3: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/core/compaction/stream-watchdog.js");
  assert.equal(injectStreamWatchdog(pristine), patched);
});

test("stream-watchdog.d.ts #3 is skipped: types never load at runtime", () => {
  assert.equal(
    isStreamWatchdogUrl("file:///x/@code-yeongyu/senpi/dist/core/compaction/stream-watchdog.d.ts"),
    false,
  );
});

test("compaction.js #8-11: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/core/compaction/compaction.js");
  assert.equal(injectCompaction(pristine), patched);
});

test("agent-session.js baseline+/skill: + #28 + #31: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/core/agent-session.js");
  assert.equal(injectAgentSession(pristine), patched);
});

test("speculative.js baseline: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/core/extensions/builtin/compaction/speculative.js");
  assert.equal(injectSpeculative(pristine), patched);
});

test("service-tier.js baseline: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/core/extensions/builtin/service-tier.js");
  assert.equal(injectServiceTier(pristine), patched);
});

test("overflow.js pi-ai series: transform(pristine) === patched", () => {
  const { pristine, patched } = states("pi-ai", "dist/utils/overflow.js");
  assert.equal(injectOverflow(pristine), patched);
});

test("provider-timeout-retry.js #31: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/core/provider-timeout-retry.js");
  assert.equal(injectProviderTimeoutRetry(pristine), patched);
});

test("provider-timeout-retry.d.ts #31 is skipped: types never load at runtime", () => {
  assert.equal(
    isProviderTimeoutRetryUrl("file:///x/@code-yeongyu/senpi/dist/core/provider-timeout-retry.d.ts"),
    false,
  );
});

test("extension-error-format.js #31: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/modes/interactive/extension-error-format.js");
  assert.equal(injectErrorFormat(pristine), patched);
});

test("assistant-render-descriptors.js #31: chrome(pristine) then ours === patched", () => {
  // Comparison basis: full stack. tui-chrome (#17/#18/#25/#27) runs first;
  // our needles are taken from that composed text, then #31 sanitize wraps.
  const { pristine, patched } = states("senpi", "dist/modes/interactive/components/assistant-render-descriptors.js");
  const chrome = injectAssistantDescriptors(pristine);
  assert.notEqual(chrome, patched, "tui-chrome alone is not the full stack");
  assert.equal(injectCoreDescriptors(chrome), patched);
  assert.equal(isCoreDescriptorsUrl("file:///x/@code-yeongyu/senpi/dist/modes/interactive/components/assistant-render-descriptors.js"), true);
});
