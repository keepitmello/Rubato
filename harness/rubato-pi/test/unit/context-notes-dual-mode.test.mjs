import test from "node:test";
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

const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };
const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };
// The only summary default left: a provider whose context an external executor owns.
const EXTERNAL = { provider: "claude-sdk-oauth", id: "claude-fable-5-1" };

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

test("every model defaults to history-notes except an externally managed context; user env wins", () => {
  assert.equal(defaultContextModeForModel(ASTRA), HISTORY_NOTES_MODE);
  assert.equal(defaultContextModeForModel(FABLE), HISTORY_NOTES_MODE);
  assert.equal(defaultContextModeForModel({ provider: "b-ai", id: "deepseek-v4.1-flash" }), HISTORY_NOTES_MODE);
  assert.equal(defaultContextModeForModel(EXTERNAL), SUMMARY_MODE);
  assert.equal(adoptContextMode({ env: {}, model: ASTRA }), HISTORY_NOTES_MODE);
  assert.equal(adoptContextMode({ env: {}, model: FABLE }), HISTORY_NOTES_MODE);
  assert.equal(adoptContextMode({ env: {}, model: EXTERNAL }), SUMMARY_MODE);
  assert.equal(adoptContextMode({ env: { RUBATO_CONTEXT_MODE: "summary" }, model: ASTRA }), SUMMARY_MODE);
});

test("recorded mode and notes-window entries win over the model rule; inherited env does not", () => {
  const recorded = [{ type: "custom", customType: MODE_ENTRY, data: { mode: HISTORY_NOTES_MODE } }];
  assert.equal(adoptContextMode({
    env: { RUBATO_CONTEXT_MODE: SUMMARY_MODE, RUBATO_CONTEXT_MODE_ORIGIN: CONTEXT_MODE_ORIGIN },
    branch: recorded,
    model: EXTERNAL,
  }), HISTORY_NOTES_MODE);
  const windowed = [{ type: "custom", customType: INIT_ENTRY, data: { window: initialWindow() } }];
  assert.equal(adoptContextMode({ env: {}, branch: windowed, model: EXTERNAL }), HISTORY_NOTES_MODE);
  assert.equal(adoptContextMode({
    env: { RUBATO_CONTEXT_MODE: HISTORY_NOTES_MODE, RUBATO_CONTEXT_MODE_ORIGIN: CONTEXT_MODE_ORIGIN },
    branch: [],
    model: EXTERNAL,
  }), SUMMARY_MODE);
  assert.equal(adoptContextMode({
    env: { RUBATO_CONTEXT_MODE: HISTORY_NOTES_MODE },
    branch: [],
    model: EXTERNAL,
  }), HISTORY_NOTES_MODE);
});

test("considerContextModeSwitch adopts the model default when the session has no recorded mode", async () => {
  const result = await considerContextModeSwitch({
    model: ASTRA,
    source: "set",
    currentMode: SUMMARY_MODE,
    confirm: async () => { throw new Error("fresh session must not confirm"); },
  });
  assert.deepEqual(result, { action: "switch", mode: HISTORY_NOTES_MODE });
});

test("considerContextModeSwitch never switches silently once a mode is recorded", async () => {
  const declined = new Set();
  const recorded = [{ type: "custom", customType: MODE_ENTRY, data: { mode: SUMMARY_MODE } }];
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
    model: EXTERNAL, source: "set", currentMode: HISTORY_NOTES_MODE, branch: boundary,
    confirm: async () => true, notify: () => {},
  });
  assert.equal(refused.refused, true);
  assert.equal(refused.action, "keep");
  const no = await considerContextModeSwitch({
    model: ASTRA, source: "set", currentMode: SUMMARY_MODE, branch: recorded,
    confirm: async () => false, declined,
  });
  assert.equal(no.declined, true);
  const again = await considerContextModeSwitch({
    model: ASTRA, source: "set", currentMode: SUMMARY_MODE, branch: recorded,
    confirm: async () => true, declined,
  });
  assert.equal(again.action, "keep");
  const yes = await considerContextModeSwitch({
    model: ASTRA, source: "set", currentMode: SUMMARY_MODE, branch: recorded,
    confirm: async () => true, declined: new Set(),
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
