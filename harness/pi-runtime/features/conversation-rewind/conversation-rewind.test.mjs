import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { feature, files, patches, patchRpcRewind } from "./patches.mjs";
import { findRewindTarget, findStepTarget, messageFingerprint } from "./rewind.mjs";

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
  assert.match(patched, /findStepTarget\(manager\.getBranch\(\), command\.step\)/);
  assert.match(patched, /case "continue": \{/);
  // A continuation adds nothing to the history: the run answers the tool results there.
  assert.match(patched, /session\._runAgentPrompt\(\[\]\)/);
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

// Entries for a step rewind: replies that call tools, and the results that answer them.
function steps(items) {
  let parentId = null;
  return items.map((item, index) => {
    const id = `s${index}`;
    const base = { id, parentId };
    parentId = id;
    const [kind, value, extra] = item;
    if (kind === "user") return { ...base, type: "message", message: { role: "user", content: value, timestamp: index } };
    if (kind === "calls") return { ...base, type: "message", message: { role: "assistant", timestamp: index, model: "m",
      content: [{ type: "text", text: "on it" }, ...value.map((callId) => ({ type: "toolCall", id: callId, name: "read", arguments: {} }))] } };
    if (kind === "result") return { ...base, type: "message", message: { role: "toolResult", toolCallId: value, content: [], timestamp: index } };
    if (kind === "reply") return { ...base, type: "message", message: { role: "assistant", content: [{ type: "text", text: value }], timestamp: index, model: "m" } };
    if (kind === "wake") return { ...base, type: "custom_message", customType: "rubato.task.completion", content: value };
    return { ...base, type: "custom", customType: value, data: extra };
  });
}

test("a step rewind lands on the last result of the reply that made the call", () => {
  const branch = steps([
    ["user", "fix it"], ["calls", ["a"]], ["result", "a"],
    ["calls", ["b", "c"]], ["result", "c"], ["result", "b"],
    ["calls", ["d"]], ["result", "d"], ["reply", "done"],
  ]);
  assert.equal(findStepTarget(branch, "a"), "s2");
  // Calls made together answer together: either one lands after both results.
  assert.equal(findStepTarget(branch, "b"), "s5");
  assert.equal(findStepTarget(branch, "c"), "s5");
  assert.equal(findStepTarget(branch, "d"), "s7");
});

test("a step rewind drops a message steered in after the step", () => {
  const branch = steps([["user", "fix it"], ["calls", ["a"]], ["result", "a"], ["user", "steer: not that file"], ["calls", ["b"]], ["result", "b"]]);
  assert.equal(findStepTarget(branch, "a"), "s2");
});

test("a step that has not finished, or is not on the branch, is refused", () => {
  const running = steps([["user", "fix it"], ["calls", ["a", "b"]], ["result", "a"]]);
  assert.throws(() => findStepTarget(running, "a"), /has not finished/);
  const interrupted = steps([["user", "fix it"], ["calls", ["a"]], ["user", "stop"], ["result", "a"]]);
  assert.throws(() => findStepTarget(interrupted, "a"), /has not finished/);
  assert.throws(() => findStepTarget(running, "zzz"), /not on the current branch/);
  assert.throws(() => findStepTarget(running, ""), /must name a tool call/);
});
