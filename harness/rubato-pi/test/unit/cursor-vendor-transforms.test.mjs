import test from "node:test";
import assert from "node:assert/strict";
import { vendorFileStates } from "./support/vendor-file-states.mjs";
import { rewriteCursorExecJournalImport } from "../../src/transforms/cursor-exec-bridge.mjs";
import {
  applyCursorVendorTransforms,
  injectCursorAgent,
  injectCursorConversationRotation,
  injectCursorExecBridge,
  injectCursorExecBridgeSession,
  isCursorAgentUrl,
  isCursorConversationRotationUrl,
  isCursorExecBridgeUrl,
  isCursorExecBridgeSessionUrl,
} from "../../src/transforms/cursor-vendor.mjs";

const SENPI = "@code-yeongyu/senpi/dist";
const PIAI = "@earendil-works/pi-ai/dist";
const JOURNAL_HREF = "file:///cursor-vendor/cursor-exec-journal.mjs";

function states(alias, relativePath) {
  const pair = vendorFileStates(alias, relativePath);
  assert.ok(pair, `vendorFileStates(${alias}, ${relativePath}) must locate the series`);
  assert.notEqual(pair.pristine, pair.patched, `${relativePath} fixture must differ`);
  return pair;
}

function applyTransformFactory() {
  const warnings = [];
  const applyTransform = (source, transform) => {
    try {
      const next = transform(source);
      return typeof next === "string" ? next : source;
    } catch (error) {
      warnings.push(error.message);
      return source;
    }
  };
  return { warnings, applyTransform };
}

test("URL matching covers only this cluster's vendor files", () => {
  assert.equal(isCursorExecBridgeUrl(`file:///${SENPI}/core/cursor-exec-bridge.js`), true);
  assert.equal(isCursorExecBridgeSessionUrl(`file:///${SENPI}/core/cursor-exec-bridge-session.js`), true);
  assert.equal(isCursorConversationRotationUrl(`file:///${PIAI}/api/cursor-conversation-rotation.js`), true);
  assert.equal(isCursorAgentUrl(`file:///${PIAI}/api/cursor-agent.js`), true);
  // session URL must not also match the bridge matcher
  assert.equal(isCursorExecBridgeUrl(`file:///${SENPI}/core/cursor-exec-bridge-session.js`), false);
  assert.equal(isCursorExecBridgeSessionUrl(`file:///${SENPI}/core/cursor-exec-bridge.js`), false);
  assert.equal(isCursorAgentUrl(`file:///${PIAI}/api/cursor-conversation-rotation.js`), false);
  // created journal is an in-repo module; vendor URL is not transformed
  assert.equal(isCursorExecBridgeUrl(`file:///${SENPI}/core/cursor-exec-journal.js`), false);
  // .d.ts never matches
  assert.equal(isCursorExecBridgeUrl(`file:///${SENPI}/core/cursor-exec-bridge.d.ts`), false);
  assert.equal(isCursorAgentUrl(`file:///${PIAI}/api/cursor-agent.d.ts`), false);
});

test("cursor-exec-bridge-session.js #14: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/core/cursor-exec-bridge-session.js");
  assert.equal(injectCursorExecBridgeSession(pristine), patched);
  assert.throws(() => injectCursorExecBridgeSession("export function createSessionCursorExecBridge() {}"), /cursor-exec-bridge-session lineage comment/);
});

test("cursor-exec-bridge.js #14+#15: transform(pristine) is byte-equal except the in-repo journal href", () => {
  // Deviation: createCursorExecJournal is imported from the in-repo module href
  // because vendor cursor-exec-journal.js is a created file.
  const { pristine, patched } = states("senpi", "dist/core/cursor-exec-bridge.js");
  assert.equal(injectCursorExecBridge(pristine, JOURNAL_HREF), rewriteCursorExecJournalImport(patched, JOURNAL_HREF));
  assert.throws(() => injectCursorExecBridge("export function createCursorExecBridge() {}"), /cursor-exec-bridge rewrite/);
});

test("cursor-conversation-rotation.js terminal-failure-kind: transform(pristine) === patched", () => {
  const { pristine, patched } = states("pi-ai", "dist/api/cursor-conversation-rotation.js");
  assert.equal(injectCursorConversationRotation(pristine), patched);
  assert.throws(() => injectCursorConversationRotation("export function createConversationRotationStore() {}"), /cursor-conversation-rotation forget/);
});

test("cursor-agent.js terminal-failure-kind + native-checkpoint: transform(pristine) === patched", () => {
  const { pristine, patched } = states("pi-ai", "dist/api/cursor-agent.js");
  assert.equal(injectCursorAgent(pristine), patched);
  assert.throws(() => injectCursorAgent("export function streamCursorAgent() {}"), /cursor-agent rewrite/);
});

test("applyCursorVendorTransforms routes by URL and swallows drift on already-patched sources", () => {
  const { patched } = states("pi-ai", "dist/api/cursor-agent.js");
  const { warnings, applyTransform } = applyTransformFactory();
  const url = `file:///x/${PIAI}/api/cursor-agent.js`;
  const next = applyCursorVendorTransforms(url, patched, applyTransform);
  assert.equal(next, patched);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cursor-agent rewrite/);
});

test("applyCursorVendorTransforms is inert on unrelated URLs", () => {
  const { warnings, applyTransform } = applyTransformFactory();
  const source = "export const x = 1;\n";
  const next = applyCursorVendorTransforms("file:///x/@code-yeongyu/senpi/dist/core/sdk.js", source, applyTransform);
  assert.equal(next, source);
  assert.equal(warnings.length, 0);
});

test(".d.ts hunks are skipped: types never load at runtime", () => {
  // Runtime never loads these. Recorded so the cluster report stays honest.
  // #14/#15 cursor-exec-bridge.d.ts, #14/#15/#16 cursor-exec-journal.d.ts,
  // terminal-failure-kind cursor-agent.d.ts + types.d.ts + rotation.d.ts,
  // native-checkpoint cursor-agent.d.ts.
  const skipped = [
    ["senpi", "dist/core/cursor-exec-bridge.d.ts"],
    ["senpi", "dist/core/cursor-exec-journal.d.ts"],
    ["pi-ai", "dist/api/cursor-agent.d.ts"],
    ["pi-ai", "dist/api/cursor-conversation-rotation.d.ts"],
    ["pi-ai", "dist/types.d.ts"],
  ];
  for (const [alias, relativePath] of skipped) {
    const pair = vendorFileStates(alias, relativePath);
    assert.ok(pair, relativePath);
    assert.notEqual(pair.pristine, pair.patched, relativePath);
  }
});
