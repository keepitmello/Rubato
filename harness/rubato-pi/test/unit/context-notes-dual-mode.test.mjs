import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_NOTES_MODE, SUMMARY_MODE, setContextMode } from "../../src/context-notes/config.mjs";
import { assertEngineParts, recordEnginePartDrift } from "../../src/context-notes/engine-gate.mjs";
import {
  considerContextModeSwitch,
  defaultContextModeForModel,
  peekSessionContextMode,
  resolveLaunchContextMode,
} from "../../src/context-notes/mode-policy.mjs";
import { INIT_ENTRY, MODE_ENTRY, SOURCE, encodeBootstrap, initialWindow, nextWindow } from "../../src/context-notes/protocol.mjs";
import { applyContextNotesTransforms as apply } from "../../src/transforms/core-context-notes.mjs";
import { installContextNotes } from "../../src/extensions/context-notes.mjs";
import { fakeSession, Type } from "../helpers/context-notes-fake.mjs";

const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };
const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "rubato-dual-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSettings(dir, settings) {
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
}

function withMode(t, mode) {
  const previous = process.env.RUBATO_CONTEXT_MODE;
  process.env.RUBATO_CONTEXT_MODE = mode;
  t.after(() => {
    if (previous === undefined) delete process.env.RUBATO_CONTEXT_MODE;
    else process.env.RUBATO_CONTEXT_MODE = previous;
  });
}

async function liveSetup(t, mode) {
  withMode(t, mode);
  const f = fakeSession(t);
  const api = await installContextNotes(f.pi, { Type, requireEngine: false });
  t.after(() => api.close());
  return { ...f, api };
}

test("Astra defaults to history-notes and Fable to summary; env wins", (t) => {
  assert.equal(defaultContextModeForModel(ASTRA), HISTORY_NOTES_MODE);
  assert.equal(defaultContextModeForModel(FABLE), SUMMARY_MODE);
  const dir = tempDir(t);
  writeSettings(dir, { defaultProvider: "openai-codex", defaultModel: "gpt-6-astra" });
  assert.equal(resolveLaunchContextMode({ args: [], env: {}, agentDir: dir }), HISTORY_NOTES_MODE);
  writeSettings(dir, { defaultProvider: "anthropic", defaultModel: "claude-fable-5-1" });
  assert.equal(resolveLaunchContextMode({ args: [], env: {}, agentDir: dir }), SUMMARY_MODE);
  assert.equal(resolveLaunchContextMode({
    args: ["--model", "openai-codex/gpt-6-astra"],
    env: {},
    agentDir: dir,
  }), HISTORY_NOTES_MODE);
  assert.equal(resolveLaunchContextMode({
    args: ["--model", "openai-codex/gpt-6-astra"],
    env: { RUBATO_CONTEXT_MODE: "summary" },
    agentDir: dir,
  }), SUMMARY_MODE);
});

test("a --session mode record or notes-window entry wins over the model rule", (t) => {
  const dir = tempDir(t);
  writeSettings(dir, { defaultProvider: "anthropic", defaultModel: "claude-fable-5-1" });
  const recorded = join(dir, "recorded.jsonl");
  writeFileSync(recorded, `${JSON.stringify({ type: "custom", customType: MODE_ENTRY, data: { mode: HISTORY_NOTES_MODE } })}\n`);
  assert.equal(resolveLaunchContextMode({
    args: ["--session", recorded, "--model", "anthropic/claude-fable-5-1"],
    env: {},
    agentDir: dir,
  }), HISTORY_NOTES_MODE);
  const windowed = join(dir, "windowed.jsonl");
  writeFileSync(windowed, `${JSON.stringify({ type: "custom", customType: INIT_ENTRY, data: { window: initialWindow() } })}\n`);
  assert.equal(peekSessionContextMode(windowed), HISTORY_NOTES_MODE);
  assert.equal(resolveLaunchContextMode({ args: ["--session", windowed], env: {}, agentDir: dir }), HISTORY_NOTES_MODE);
  const summary = join(dir, "summary.jsonl");
  writeFileSync(summary, `${JSON.stringify({ type: "custom", customType: MODE_ENTRY, data: { mode: SUMMARY_MODE } })}\n`);
  assert.equal(resolveLaunchContextMode({
    args: ["--session", summary, "--model", "openai-codex/gpt-6-astra"],
    env: {},
    agentDir: dir,
  }), SUMMARY_MODE);
});

test("model_select confirm yes/no in both directions, and no repeat after no", async (t) => {
  const yes = await liveSetup(t, SUMMARY_MODE);
  await yes.dispatch("session_start");
  yes.setConfirm(true);
  await yes.dispatch("model_select", { model: ASTRA, source: "set" });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, HISTORY_NOTES_MODE);
  assert.equal(yes.confirms.length, 1);
  assert.match(yes.confirms[0].message, /Astra는 작업 노트 모드가 기본이에요/);
  assert.ok(yes.entries.some((entry) => entry.customType === MODE_ENTRY && entry.data.mode === HISTORY_NOTES_MODE));
  assert.equal(yes.api.getController(yes.ctx).window.number, 0);

  const no = await liveSetup(t, SUMMARY_MODE);
  await no.dispatch("session_start");
  no.setConfirm(false);
  await no.dispatch("model_select", { model: ASTRA, source: "set" });
  await no.dispatch("model_select", { model: ASTRA, source: "set" });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, SUMMARY_MODE);
  assert.equal(no.confirms.length, 1);

  const back = await liveSetup(t, HISTORY_NOTES_MODE);
  await back.dispatch("session_start");
  back.setConfirm(true);
  await back.dispatch("model_select", { model: FABLE, source: "set" });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, SUMMARY_MODE);
  assert.match(back.confirms[0].message, /Fable는 요약 모드가 기본이에요/);
  await assert.rejects(back.tools.get("get_context_remaining").execute("id", {}, undefined, undefined, back.ctx), /요약 모드/);
});

test("notes to summary is refused after a window boundary without prompting", async (t) => {
  const f = await liveSetup(t, HISTORY_NOTES_MODE);
  f.addMessage("user", "Perform the experiment");
  await f.dispatch("session_start");
  await f.tools.get("notes_write_file").execute("n", { path: "active.md", text: "goal" }, undefined, undefined, f.ctx);
  await f.tools.get("new_context").execute("c", {}, undefined, undefined, f.ctx);
  await f.dispatch("turn_end");
  assert.ok(f.entries.some((entry) => entry.type === "compaction" && entry.details?.source === SOURCE));
  f.setConfirm(true);
  await f.dispatch("model_select", { model: FABLE, source: "set" });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, HISTORY_NOTES_MODE);
  assert.equal(f.confirms.length, 0);
  assert.ok(f.notices.some((args) => String(args[0]).includes("작업 노트 창")));
});

test("mode record round-trips through the session file and session_start adoption", async (t) => {
  const f = await liveSetup(t, SUMMARY_MODE);
  await f.dispatch("session_start");
  f.setConfirm(true);
  await f.dispatch("model_select", { model: ASTRA, source: "set" });
  assert.equal(peekSessionContextMode(f.file), HISTORY_NOTES_MODE);
  assert.equal(resolveLaunchContextMode({ args: ["--session", f.file], env: {}, agentDir: f.dir }), HISTORY_NOTES_MODE);

  withMode(t, SUMMARY_MODE);
  const resumed = fakeSession(t);
  resumed.append({ type: "custom", customType: MODE_ENTRY, data: { mode: HISTORY_NOTES_MODE } });
  const api = await installContextNotes(resumed.pi, { Type, requireEngine: false });
  t.after(() => api.close());
  await resumed.dispatch("session_start");
  assert.equal(process.env.RUBATO_CONTEXT_MODE, HISTORY_NOTES_MODE);
  assert.equal(api.getController(resumed.ctx).window.number, 0);
});

test("gates are present but dormant in summary mode; drift is recorded for a later notes switch", async () => {
  const base = "file:///repo/node_modules/@code-yeongyu/senpi/dist/core/";
  const settings = `export class SettingsManager { getCompactionSettings() { return {enabled:true,idleCompactionEnabled:true}; } }`;
  const patched = apply(`${base}settings-manager.js`, settings, { enabled: false });
  assert.ok(patched.includes("rubato-history-notes-transform-v2:settings"));
  const old = process.env.RUBATO_CONTEXT_MODE;
  process.env.RUBATO_CONTEXT_MODE = SUMMARY_MODE;
  try {
    const module = await import(`data:text/javascript;base64,${Buffer.from(patched).toString("base64")}#${Math.random()}`);
    assert.equal(new module.SettingsManager().getCompactionSettings().enabled, true);
    process.env.RUBATO_CONTEXT_MODE = HISTORY_NOTES_MODE;
    assert.equal(new module.SettingsManager().getCompactionSettings().enabled, false);
  } finally {
    if (old === undefined) delete process.env.RUBATO_CONTEXT_MODE;
    else process.env.RUBATO_CONTEXT_MODE = old;
  }
  delete globalThis[Symbol.for("rubato.history-notes.lane.v1")];
  recordEnginePartDrift("lane", new Error("니들이 없어요"));
  assert.throws(() => assertEngineParts(), /lane \(니들이 없어요\)/);
});

test("considerContextModeSwitch never switches silently", async () => {
  const declined = new Set();
  const window = nextWindow(initialWindow());
  const boundary = [{
    type: "compaction",
    summary: encodeBootstrap(window),
    details: { source: SOURCE, window },
  }];
  assert.deepEqual(await considerContextModeSwitch({
    model: ASTRA, source: "restore", currentMode: SUMMARY_MODE, confirm: async () => true,
  }), { action: "keep" });
  const refused = await considerContextModeSwitch({
    model: FABLE, source: "set", currentMode: HISTORY_NOTES_MODE, branch: boundary,
    confirm: async () => true, notify: () => {},
  });
  assert.equal(refused.refused, true);
  assert.equal(refused.action, "keep");
  const no = await considerContextModeSwitch({
    model: ASTRA, source: "set", currentMode: SUMMARY_MODE, confirm: async () => false, declined,
  });
  assert.equal(no.declined, true);
  const again = await considerContextModeSwitch({
    model: ASTRA, source: "set", currentMode: SUMMARY_MODE, confirm: async () => true, declined,
  });
  assert.equal(again.action, "keep");
  const yes = await considerContextModeSwitch({
    model: ASTRA, source: "set", currentMode: SUMMARY_MODE, confirm: async () => true, declined: new Set(),
  });
  assert.deepEqual(yes, { action: "switch", mode: HISTORY_NOTES_MODE });
});

test("setContextMode is the live env switch", () => {
  const env = { RUBATO_CONTEXT_MODE: SUMMARY_MODE };
  assert.equal(setContextMode(HISTORY_NOTES_MODE, env), HISTORY_NOTES_MODE);
  assert.equal(env.RUBATO_CONTEXT_MODE, HISTORY_NOTES_MODE);
  assert.throws(() => setContextMode("typo", env));
});
