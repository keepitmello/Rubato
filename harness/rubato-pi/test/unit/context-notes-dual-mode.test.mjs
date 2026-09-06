import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_MODE_ORIGIN, HISTORY_NOTES_MODE, SUMMARY_MODE, resetContextModeResolution, setContextMode,
} from "../../src/context-notes/config.mjs";
import { assertEngineParts } from "../../src/context-notes/engine-gate.mjs";
import {
  adoptContextMode,
  considerContextModeSwitch,
  defaultContextModeForModel,
  recordedModeFromBranch,
} from "../../src/context-notes/mode-policy.mjs";
import { INIT_ENTRY, MODE_ENTRY, SOURCE, encodeBootstrap, initialWindow, nextWindow } from "../../src/context-notes/protocol.mjs";
import { applyContextNotesTransforms as apply } from "../../src/transforms/core-context-notes.mjs";
import { installContextNotes } from "../../src/extensions/context-notes.mjs";
import { fakeSession, Type } from "../helpers/context-notes-fake.mjs";

const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };
const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };

function withMode(t, mode, { origin } = {}) {
  const previous = process.env.RUBATO_CONTEXT_MODE;
  const previousOrigin = process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  resetContextModeResolution();
  process.env.RUBATO_CONTEXT_MODE = mode;
  if (origin) process.env.RUBATO_CONTEXT_MODE_ORIGIN = origin;
  else delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  t.after(() => {
    if (previous === undefined) delete process.env.RUBATO_CONTEXT_MODE;
    else process.env.RUBATO_CONTEXT_MODE = previous;
    if (previousOrigin === undefined) delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
    else process.env.RUBATO_CONTEXT_MODE_ORIGIN = previousOrigin;
    resetContextModeResolution();
  });
}

async function liveSetup(t, mode) {
  withMode(t, mode);
  const f = fakeSession(t);
  const api = await installContextNotes(f.pi, { Type, requireEngine: false });
  t.after(() => api.close());
  return { ...f, api };
}

test("Astra defaults to history-notes and Fable to summary; user env wins", () => {
  assert.equal(defaultContextModeForModel(ASTRA), HISTORY_NOTES_MODE);
  assert.equal(defaultContextModeForModel(FABLE), SUMMARY_MODE);
  assert.equal(adoptContextMode({ env: {}, model: ASTRA }), HISTORY_NOTES_MODE);
  assert.equal(adoptContextMode({ env: {}, model: FABLE }), SUMMARY_MODE);
  assert.equal(adoptContextMode({ env: { RUBATO_CONTEXT_MODE: "summary" }, model: ASTRA }), SUMMARY_MODE);
});

test("recorded mode and notes-window entries win over the model rule; inherited env does not", () => {
  const recorded = [{ type: "custom", customType: MODE_ENTRY, data: { mode: HISTORY_NOTES_MODE } }];
  assert.equal(adoptContextMode({
    env: { RUBATO_CONTEXT_MODE: SUMMARY_MODE, RUBATO_CONTEXT_MODE_ORIGIN: CONTEXT_MODE_ORIGIN },
    branch: recorded,
    model: FABLE,
  }), HISTORY_NOTES_MODE);
  const windowed = [{ type: "custom", customType: INIT_ENTRY, data: { window: initialWindow() } }];
  assert.equal(adoptContextMode({ env: {}, branch: windowed, model: FABLE }), HISTORY_NOTES_MODE);
  assert.equal(adoptContextMode({
    env: { RUBATO_CONTEXT_MODE: HISTORY_NOTES_MODE, RUBATO_CONTEXT_MODE_ORIGIN: CONTEXT_MODE_ORIGIN },
    branch: [],
    model: FABLE,
  }), SUMMARY_MODE);
  assert.equal(adoptContextMode({
    env: { RUBATO_CONTEXT_MODE: HISTORY_NOTES_MODE },
    branch: [],
    model: FABLE,
  }), HISTORY_NOTES_MODE);
});

describe("live env", { concurrency: false }, () => {
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

test("mode record round-trips and session_start re-resolves inherited env", async (t) => {
  const f = await liveSetup(t, SUMMARY_MODE);
  await f.dispatch("session_start");
  f.setConfirm(true);
  await f.dispatch("model_select", { model: ASTRA, source: "set" });
  assert.equal(recordedModeFromBranch(f.entries), HISTORY_NOTES_MODE);

  withMode(t, SUMMARY_MODE, { origin: CONTEXT_MODE_ORIGIN });
  const resumed = fakeSession(t);
  resumed.append({ type: "custom", customType: MODE_ENTRY, data: { mode: HISTORY_NOTES_MODE } });
  const api = await installContextNotes(resumed.pi, { Type, requireEngine: false });
  t.after(() => api.close());
  await resumed.dispatch("session_start");
  assert.equal(process.env.RUBATO_CONTEXT_MODE, HISTORY_NOTES_MODE);
  assert.equal(api.getController(resumed.ctx).window.number, 0);
});

test("a child that inherits a session-origin notes env still follows its own Fable model", async (t) => {
  withMode(t, HISTORY_NOTES_MODE, { origin: CONTEXT_MODE_ORIGIN });
  const f = fakeSession(t);
  f.ctx.model = { ...f.ctx.model, ...FABLE };
  const api = await installContextNotes(f.pi, { Type, requireEngine: false });
  t.after(() => api.close());
  await f.dispatch("session_start");
  assert.equal(process.env.RUBATO_CONTEXT_MODE, SUMMARY_MODE);
  await assert.rejects(f.tools.get("get_context_remaining").execute("id", {}, undefined, undefined, f.ctx), /요약 모드/);
});

test("a second in-process session re-adopts instead of keeping the previous mode", async (t) => {
  const previous = process.env.RUBATO_CONTEXT_MODE;
  const previousOrigin = process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  t.after(() => {
    if (previous === undefined) delete process.env.RUBATO_CONTEXT_MODE;
    else process.env.RUBATO_CONTEXT_MODE = previous;
    if (previousOrigin === undefined) delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
    else process.env.RUBATO_CONTEXT_MODE_ORIGIN = previousOrigin;
    resetContextModeResolution();
  });
  process.env.RUBATO_CONTEXT_MODE = HISTORY_NOTES_MODE;
  process.env.RUBATO_CONTEXT_MODE_ORIGIN = CONTEXT_MODE_ORIGIN;
  const first = fakeSession(t);
  first.ctx.model = { ...first.ctx.model, ...FABLE };
  const api1 = await installContextNotes(first.pi, { Type, requireEngine: false });
  t.after(() => api1.close());
  await first.dispatch("session_start");
  assert.equal(process.env.RUBATO_CONTEXT_MODE, SUMMARY_MODE);
  const second = fakeSession(t);
  second.ctx.model = { ...second.ctx.model, ...ASTRA };
  const api2 = await installContextNotes(second.pi, { Type, requireEngine: false });
  t.after(() => api2.close());
  await second.dispatch("session_start");
  assert.equal(process.env.RUBATO_CONTEXT_MODE, HISTORY_NOTES_MODE);
});

test("session_tree restores the destination branch mode and does not init a summary ancestor", async (t) => {
  withMode(t, SUMMARY_MODE, { origin: CONTEXT_MODE_ORIGIN });
  const f = fakeSession(t);
  f.ctx.model = { ...f.ctx.model, ...FABLE };
  const api = await installContextNotes(f.pi, { Type, requireEngine: false });
  t.after(() => api.close());
  f.addMessage("user", "before switch");
  await f.dispatch("session_start");
  const userId = f.manager.getLeafId();
  f.setConfirm(true);
  f.ctx.model = { ...f.ctx.model, ...ASTRA };
  await f.dispatch("model_select", { model: ASTRA, source: "set" });
  assert.equal(process.env.RUBATO_CONTEXT_MODE, HISTORY_NOTES_MODE);
  const inits = f.entries.filter((e) => e.customType === INIT_ENTRY).length;
  f.rewind(userId);
  await f.dispatch("session_tree");
  assert.equal(process.env.RUBATO_CONTEXT_MODE, SUMMARY_MODE);
  assert.equal(f.entries.filter((e) => e.customType === INIT_ENTRY).length, inits);
});
});

test("gates are present but dormant in summary mode; drift is recorded for a later notes switch", async () => {
  const base = "file:///repo/node_modules/@code-yeongyu/senpi/dist/core/";
  const settings = `export class SettingsManager { getCompactionSettings() { return {enabled:true,idleCompactionEnabled:true}; } }`;
  const patched = apply(`${base}settings-manager.js`, settings, { enabled: false });
  assert.ok(patched.includes("rubato-history-notes-transform-v2:settings"));
  assert.ok(patched.includes("installSettingsGate"));
  delete globalThis[Symbol.for("rubato.history-notes.lane.v1")];
  const drifted = apply(`${base}extensions/builtin/compaction/lane-policy.js`, "export const keep = true;\n", { enabled: false });
  assert.match(drifted, /__rubatoRecordDrift\("lane"/);
  const driftedModule = await import(`data:text/javascript;base64,${Buffer.from(drifted).toString("base64")}#${Math.random()}`);
  assert.equal(driftedModule.keep, true);
  assert.throws(() => assertEngineParts(), /lane \(/);
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
  assert.equal(env.RUBATO_CONTEXT_MODE_ORIGIN, CONTEXT_MODE_ORIGIN);
  assert.throws(() => setContextMode("typo", env));
});
