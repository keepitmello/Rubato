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
  assert.equal(findRewindTarget(branch, { keep: fingerprints(branch, "a1", "a2"), skip: 0 }), idOf(branch, "wake", "child done"));
});

test("a message steered into a kept turn stays with it", () => {
  const branch = conversation([
    ["user", "one"], ["assistant", "a1"], ["tool"],
    ["user", "steer: also the header"], ["assistant", "a1b"],
    ["user", "two"], ["assistant", "a2"],
  ]);
  assert.equal(findRewindTarget(branch, { keep: fingerprints(branch, "a1", "a1b"), skip: 0 }), idOf(branch, "user", "two"));
});

test("inputs injected ahead of the removed prompt go with it", () => {
  const branch = conversation([
    ["user", "one"], ["assistant", "a1"],
    ["custom", "rubato.context-mode.v1"], ["wake", "usage note"],
    ["user", "two"], ["assistant", "a2"],
  ]);
  assert.equal(findRewindTarget(branch, { keep: fingerprints(branch, "a1"), skip: 0 }), idOf(branch, "wake", "usage note"));
});

test("a prompt the app keeps after its last kept answer is passed, whatever its text", () => {
  const branch = conversation([
    ["user", "one"], ["assistant", "a1"],
    ["user", [{ type: "image", data: "", mimeType: "image/png" }]],
    ["wake", "usage note"],
    ["user", "one"], ["assistant", "a2"],
  ]);
  const target = findRewindTarget(branch, { keep: fingerprints(branch, "a1"), skip: 1 });
  assert.equal(target, idOf(branch, "wake", "usage note"));
  assert.throws(() => findRewindTarget(branch, { keep: fingerprints(branch, "a1"), skip: 3 }), /does not have/);
});

test("keeping nothing lands before the first input", () => {
  const branch = conversation([["custom", "session-info"], ["wake", "recalled memory"], ["user", "one"], ["assistant", "a1"]]);
  assert.equal(findRewindTarget(branch, { keep: [] }), idOf(branch, "wake", "recalled memory"));
});

test("removed turns that left no model history rewind nothing", () => {
  // A /name turn: T3 counts it, Pi stored only its session name.
  const branch = conversation([["user", "one"], ["assistant", "a1"], ["custom", "session_info"]]);
  assert.equal(findRewindTarget(branch, { keep: fingerprints(branch, "a1") }), null);
});

test("what the app cannot name is refused, not guessed", () => {
  const branch = conversation([["user", "one"], ["assistant", "a1"], ["user", "two"], ["assistant", "a2"]]);
  assert.throws(() => findRewindTarget(branch, { keep: ["000000000000000000000000"] }), /not on the current branch/);
  assert.throws(() => findRewindTarget(branch, {}), /must name/);
  assert.throws(() => findRewindTarget(branch, { keep: [], skip: -1 }), /integer >= 0/);
});
