import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { feature, files, patches, patchRpcRewind } from "./patches.mjs";
import { findRewindTarget, messageFingerprint } from "./rewind.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const stockRpc = join(featureDir, "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("descriptor is stock-locked, listed on the candidate, and adds the rewind command", async () => {
  assert.equal(PI_FEATURE_NAMES.includes("conversation-rewind"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("conversation-rewind"), true);
  assert.deepEqual((await loadPiFeatures(["conversation-rewind"])).map((entry) => entry.id), [feature.id]);
  assert.equal(patches[0].preimageSha256, sha256(readFileSync(stockRpc)));
  assert.deepEqual(files.map((entry) => entry.path), ["dist/rubato-features/conversation-rewind/rewind.mjs"]);
  const patched = patchRpcRewind(readFileSync(stockRpc, "utf8"));
  assert.match(patched, /case "rewind": \{/);
  assert.match(patched, /session\.navigateTree\(targetId, \{ summarize: false \}\)/);
  assert.throws(() => patchRpcRewind(patched), /pristine/);
});

// A tiny session tree: each entry's parent is the one before it.
function conversation(steps) {
  let parentId = null;
  let clock = 1_000;
  return steps.map(([kind, value], index) => {
    const id = `e${index}`;
    const base = { id, parentId, timestamp: new Date(clock).toISOString() };
    parentId = id;
    clock += 1;
    if (kind === "user") return { ...base, type: "message", message: { role: "user", content: value, timestamp: clock } };
    if (kind === "assistant") return { ...base, type: "message", message: { role: "assistant", content: [{ type: "text", text: value }], timestamp: clock, model: "m" } };
    if (kind === "tool") return { ...base, type: "message", message: { role: "toolResult", content: [], timestamp: clock } };
    if (kind === "wake") return { ...base, type: "custom_message", customType: "rubato.task.completion", content: value };
    return { ...base, type: "custom", customType: value };
  });
}
const fingerprints = (branch, ...texts) => branch
  .filter((entry) => entry.message?.role === "assistant" && texts.includes(entry.message.content[0].text))
  .map((entry) => messageFingerprint(entry.message));
const idOf = (branch, kind, value) => branch.find((entry) =>
  kind === "wake" ? entry.content === value : entry.message?.role === kind && (entry.message.content === value || entry.message.content?.[0]?.text === value)).id;

test("a turn a finished child woke counts as a turn, so the prompt before it survives", () => {
  const branch = conversation([
    ["user", "one"], ["assistant", "a1"],
    ["user", "two"], ["assistant", "a2"],
    ["wake", "child done"], ["assistant", "a-wake"],
    ["user", "three"], ["assistant", "a3"],
  ]);
  // The app drops its last two turns: the wake and "three".
  const target = findRewindTarget(branch, { keep: fingerprints(branch, "a1", "a2"), text: "three", turns: 2 });
  assert.equal(target, idOf(branch, "wake", "child done"));
  // Counting user messages would have dropped "two" as well.
  assert.equal(findRewindTarget(branch, { turns: 2 }), idOf(branch, "user", "two"));
});

test("a message steered into a kept turn stays with it", () => {
  const branch = conversation([
    ["user", "one"], ["assistant", "a1"], ["tool"],
    ["user", "steer: also the header"], ["assistant", "a1b"],
    ["user", "two"], ["assistant", "a2"],
  ]);
  const target = findRewindTarget(branch, { keep: fingerprints(branch, "a1", "a1b"), text: "two", turns: 1 });
  assert.equal(target, idOf(branch, "user", "two"));
});

test("inputs injected ahead of the removed prompt go with it", () => {
  const branch = conversation([
    ["user", "one"], ["assistant", "a1"],
    ["custom", "rubato.context-mode.v1"], ["wake", "usage note"],
    ["user", "two"], ["assistant", "a2"],
  ]);
  const target = findRewindTarget(branch, { keep: fingerprints(branch, "a1"), text: "two", turns: 1 });
  assert.equal(target, idOf(branch, "wake", "usage note"));
});

test("a kept prompt stopped before any answer is not taken with the one after it", () => {
  const branch = conversation([
    ["user", "one"], ["assistant", "a1"],
    ["user", "oops, stopped"],
    ["user", "two"], ["assistant", "a2"],
  ]);
  const target = findRewindTarget(branch, { keep: fingerprints(branch, "a1"), text: "two", turns: 1 });
  assert.equal(target, idOf(branch, "user", "two"));
  // Without the prompt's text the rewind opens at the first input after the kept answers.
  assert.equal(findRewindTarget(branch, { keep: fingerprints(branch, "a1") }), idOf(branch, "user", "oops, stopped"));
});

test("keeping nothing lands before the first input", () => {
  const branch = conversation([["custom", "session-info"], ["wake", "recalled memory"], ["user", "one"], ["assistant", "a1"]]);
  assert.equal(findRewindTarget(branch, { keep: [], turns: 1 }), idOf(branch, "wake", "recalled memory"));
});

test("history the app never saw falls back to counting user messages", () => {
  const branch = conversation([["user", "one"], ["assistant", "a1"], ["user", "two"], ["assistant", "a2"]]);
  assert.equal(findRewindTarget(branch, { keep: ["000000000000000000000000"], turns: 1 }), idOf(branch, "user", "two"));
  assert.throws(() => findRewindTarget(branch, { keep: ["000000000000000000000000"] }), /not on the current branch/);
  assert.throws(() => findRewindTarget(branch, { turns: 3 }), /more turns/);
  assert.throws(() => findRewindTarget(branch, { turns: 0 }), /integer >= 1/);
  assert.throws(() => findRewindTarget(branch, { keep: fingerprints(branch, "a2") }), /Nothing after/);
});
