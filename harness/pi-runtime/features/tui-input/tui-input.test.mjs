import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { applyFeatureToggles, readDisabledFeatures } from "../rubato-components/feature-toggles.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import {
  TUI_INPUT_FACTORY_NAMES,
  createTuiInputFactories,
  SELECT_CANCEL_BINDING,
  SELECT_CANCEL_KEYS,
} from "./index.mjs";
import {
  busyEnterDelivery,
  handlePendingRecallKey,
  isBusyEnterEnabled,
  promoteBusyEnter,
  recallLatestPending,
  setBusyEnterEnabled,
} from "./busy-enter.mjs";
import { feature, files, patches, patchStdinBufferUnicode } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-pi-tui-input-"));
const outputRoot = join(scratch, "engine");
const HANGUL_GA = Buffer.from([0xea, 0xb0, 0x80]);

after(() => {
  setBusyEnterEnabled(false);
  rmSync(scratch, { recursive: true, force: true });
});

function withoutNodeOptions(env, extra = {}) {
  const copy = { ...env, ...extra };
  delete copy.NODE_OPTIONS;
  delete copy.NODE_COMPILE_CACHE;
  return copy;
}

function fakeQueueSession({ steering = [], followUp = [], streaming = true, compacting = false } = {}) {
  const state = { steering: [...steering], followUp: [...followUp] };
  return {
    isStreaming: streaming,
    isCompacting: compacting,
    getSteeringMessages: () => state.steering,
    getFollowUpMessages: () => state.followUp,
    clearQueue() {
      const snapshot = { steering: [...state.steering], followUp: [...state.followUp] };
      state.steering = [];
      state.followUp = [];
      return snapshot;
    },
    steer(text) { state.steering.push(text); },
    followUp(text) { state.followUp.push(text); },
  };
}

test("descriptor is stock-locked and listed on the candidate", async () => {
  assert.equal(feature.id, "tui-input");
  assert.equal(PI_FEATURE_NAMES.includes("tui-input"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("tui-input"), true);
  assert.deepEqual((await loadPiFeatures(["tui-input"])).map((entry) => entry.id), ["tui-input"]);
  assert.deepEqual(TUI_INPUT_FACTORY_NAMES, ["rubato-tui-unicode", "rubato-tui-images", "rubato-tui-busy-enter"]);
  assert.equal(patches.length, 2);
  assert.ok(patches.every((entry) => entry.version === "0.85.1"));
  assert.ok(patches.every((entry) => /^[a-f0-9]{64}$/.test(entry.preimageSha256)));
  assert.deepEqual(files.map((entry) => entry.path), [
    "rubato-features/tui-input/index.mjs",
    "rubato-features/tui-input/busy-enter.mjs",
    "rubato-features/tui-input/images.mjs",
    "rubato-features/tui-input/cancel.mjs",
  ]);
});

test("rubato-features.json disables each rubato-tui-* factory by name", () => {
  const agentDir = mkdtempSync(join(scratch, "toggle-"));
  writeFileSync(join(agentDir, "rubato-features.json"), JSON.stringify({
    disabled: ["rubato-tui-unicode", "rubato-tui-images", "rubato-tui-busy-enter", "rubato-missing"],
  }));
  const disabled = readDisabledFeatures({ agentDir, env: {} });
  const result = applyFeatureToggles(createTuiInputFactories(), disabled);
  assert.deepEqual(result.extensionFactories.map((entry) => entry.name), []);
  assert.deepEqual(result.disabled, ["rubato-tui-unicode", "rubato-tui-images", "rubato-tui-busy-enter"]);
  assert.deepEqual(result.unknown, ["rubato-missing"]);
});

test("split Hangul UTF-8 becomes one character only after the stdin-buffer patch", async () => {
  const stockPath = join(sourceRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/stdin-buffer.js");
  const stockSource = readFileSync(stockPath, "utf8");
  assert.equal(stockSource.includes("StringDecoder"), false);
  const patched = patchStdinBufferUnicode(stockSource);
  assert.equal(patched.includes("StringDecoder"), true);
  assert.throws(() => patchStdinBufferUnicode(patched), /expected pristine feature seam/);
  assert.throws(
    () => patchStdinBufferUnicode(stockSource.replace("sequences.push(remaining[0]);", "sequences.push(remaining[1]);")),
    /expected anchor is missing/,
  );

  const stockFile = join(scratch, "stdin-stock.mjs");
  const patchedFile = join(scratch, "stdin-patched.mjs");
  writeFileSync(stockFile, stockSource);
  writeFileSync(patchedFile, patched);
  const stockMod = await import(pathToFileURL(stockFile).href + "?stock");
  const patchedMod = await import(pathToFileURL(patchedFile).href + "?patched");

  const stockChars = [];
  const stockBuf = new stockMod.StdinBuffer({ timeout: 5, escapeTimeout: 5 });
  stockBuf.on("data", (chunk) => stockChars.push(chunk));
  stockBuf.process(Buffer.from([HANGUL_GA[0]]));
  stockBuf.process(Buffer.from(HANGUL_GA.slice(1)));
  assert.notEqual(stockChars.join(""), "가");

  const patchedChars = [];
  const patchedBuf = new patchedMod.StdinBuffer({ timeout: 5, escapeTimeout: 5 });
  patchedBuf.on("data", (chunk) => patchedChars.push(chunk));
  patchedBuf.process(Buffer.from([HANGUL_GA[0]]));
  patchedBuf.process(Buffer.from(HANGUL_GA.slice(1)));
  assert.deepEqual(patchedChars, ["가"]);

  const emoji = [];
  const emojiBuf = new patchedMod.StdinBuffer({ timeout: 5, escapeTimeout: 5 });
  emojiBuf.on("data", (chunk) => emoji.push(chunk));
  const grin = Buffer.from("😀");
  emojiBuf.process(grin.subarray(0, 2));
  emojiBuf.process(grin.subarray(2));
  assert.deepEqual(emoji, ["😀"]);
});

test("8-bit meta stays below 0xC2 so Hangul leads are not stolen as Alt+letter", async () => {
  const patchedFile = join(scratch, "stdin-patched-meta.mjs");
  const stockPath = join(sourceRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/stdin-buffer.js");
  writeFileSync(patchedFile, patchStdinBufferUnicode(readFileSync(stockPath, "utf8")));
  const { StdinBuffer } = await import(pathToFileURL(patchedFile).href + "?meta");
  const meta = [];
  const metaBuf = new StdinBuffer({ timeout: 5, escapeTimeout: 5 });
  metaBuf.on("data", (chunk) => meta.push(chunk));
  metaBuf.process(Buffer.from([0xa1]));
  assert.deepEqual(meta, ["\x1b!"]);
  const alt = [];
  const altBuf = new StdinBuffer({ timeout: 5, escapeTimeout: 5 });
  altBuf.on("data", (chunk) => alt.push(chunk));
  altBuf.process(Buffer.from([0xe1]));
  assert.deepEqual(alt, []);
});

test("bracketed paste is one StdinBuffer event including newlines", async () => {
  const { StdinBuffer } = await import(pathToFileURL(join(
    sourceRoot,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/stdin-buffer.js",
  )));
  const pastes = [];
  const buffer = new StdinBuffer({ timeout: 5, escapeTimeout: 5 });
  buffer.on("paste", (content) => pastes.push(content));
  const body = "첫 줄\n둘째 줄\n세 번째";
  buffer.process(Buffer.from("\x1b[200~" + body.slice(0, 4), "utf8"));
  buffer.process(Buffer.from(body.slice(4) + "\x1b[201~", "utf8"));
  assert.deepEqual(pastes, [body]);
});

test("select cancel is Esc and Ctrl-C with no value", async () => {
  const tui = await import(pathToFileURL(join(
    sourceRoot,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
  )));
  assert.deepEqual(tui.TUI_KEYBINDINGS[SELECT_CANCEL_BINDING].defaultKeys, [...SELECT_CANCEL_KEYS]);
  const list = new tui.SelectList(
    [{ value: "keep", label: "keep" }],
    4,
    { fg: (_n, s) => s, bg: (_n, s) => s },
  );
  let selected = 0;
  let cancelled = 0;
  list.onSelect = () => { selected += 1; };
  list.onCancel = () => { cancelled += 1; };
  list.handleInput("\x1b");
  list.handleInput("\x03");
  assert.equal(selected, 0);
  assert.equal(cancelled, 2);
});

test("busy-enter queues as follow-up, empty Enter toggles, Up recalls latest", () => {
  setBusyEnterEnabled(false);
  assert.equal(busyEnterDelivery(), "steer");
  setBusyEnterEnabled(true);
  assert.equal(isBusyEnterEnabled(), true);
  assert.equal(busyEnterDelivery(), "followUp");

  const session = fakeQueueSession({ followUp: ["다음 턴"], steering: ["지금"] });
  const mode = { session, editor: { text: "", setText(value) { this.text = value; } }, updatePendingMessagesDisplay() { this.rendered = true; } };
  promoteBusyEnter(mode);
  assert.deepEqual(session.getFollowUpMessages(), []);
  assert.deepEqual(session.getSteeringMessages(), ["지금", "다음 턴"]);

  const session2 = fakeQueueSession({ followUp: ["latest"], steering: ["keep"] });
  const editor = { text: "", getText() { return this.text; }, setText(value) { this.text = value; }, isShowingAutocomplete() { return false; } };
  const mode2 = { session: session2, editor, defaultEditor: editor, keybindings: { matches: (data, name) => name === "tui.editor.cursorUp" && data === "\x1b[A" } };
  let fellThrough = false;
  handlePendingRecallKey(mode2, "\x1b[A", () => { fellThrough = true; });
  assert.equal(fellThrough, false);
  assert.equal(editor.text, "latest");
  assert.deepEqual(session2.getFollowUpMessages(), []);
  assert.deepEqual(session2.getSteeringMessages(), ["keep"]);
  assert.equal(recallLatestPending({ session: fakeQueueSession({ followUp: [] }), editor }), undefined);
});

test("staged patches apply, stay unique, and compose with reload/session-picker", async () => {
  const dependencies = await loadPiFeatures([
    "reload",
    "service-tier",
    "input-lifecycle",
    "abort-provenance",
    "extension-rpc",
    "request-run",
    "session-catalog",
    "session-picker",
    "providers",
    "runtime-factories",
    "tui-input",
  ]);
  const staged = await stagePiRuntime({ sourceRoot, outputRoot, features: dependencies });
  const runtime = resolvePiRuntime({ root: staged.root });
  const unicode = staged.receipt.files.find((entry) => entry.path.endsWith("dist/stdin-buffer.js"));
  assert.ok(unicode.patches.includes("tui-input/tui-input:unicode"));
  const interactive = staged.receipt.files.find((entry) => entry.path.endsWith("dist/modes/interactive/interactive-mode.js"));
  assert.ok(interactive.patches.includes("tui-input/tui-input:interactive"));
  for (const entry of [unicode, interactive]) {
    const syntax = spawnSync(process.execPath, ["--check", join(staged.root, entry.path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, `${entry.path}: ${syntax.stderr}`);
  }
  const stdinPath = join(runtime.packages["@earendil-works/pi-tui"].dir, "dist/stdin-buffer.js");
  const { StdinBuffer } = await import(pathToFileURL(stdinPath));
  const chars = [];
  const buffer = new StdinBuffer({ timeout: 5, escapeTimeout: 5 });
  buffer.on("data", (chunk) => chars.push(chunk));
  buffer.process(Buffer.from([HANGUL_GA[0]]));
  buffer.process(Buffer.from(HANGUL_GA.slice(1)));
  assert.deepEqual(chars, ["가"]);
  const interactivePath = join(runtime.packages["@earendil-works/pi-coding-agent"].dir, "dist/modes/interactive/interactive-mode.js");
  const interactiveSource = readFileSync(interactivePath, "utf8");
  assert.match(interactiveSource, /from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/rubato-features\/tui-input\/busy-enter\.mjs"/);
  assert.match(interactiveSource, /BUSY_ENTER_STATUS/);
  const fromInteractive = resolve(dirname(interactivePath), "../../../../../../rubato-features/tui-input/busy-enter.mjs");
  const runtimeBusy = join(staged.root, "rubato-features/tui-input/busy-enter.mjs");
  assert.equal(realpathSync(fromInteractive), realpathSync(runtimeBusy));
});
