import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `install-gui.sh --apply` runs on every `rubato restart` and every
// `rubato update`, and write-gui-settings.mjs is the step inside it that
// touches the app's own settings file. It used to overwrite the model
// selections outright, so each restart put the default model back to
// xai/grok-4.6 and dropped the reasoning effort the user had chosen. What the
// installer owns is the wiring (driver, bridge path, descriptor path); the
// preferences belong to whoever is using the app.
const script = fileURLToPath(new URL("../../../t3-integration/write-gui-settings.mjs", import.meta.url));

function writeSettings(t, existing) {
  const root = mkdtempSync(join(tmpdir(), "rubato-gui-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userdata = join(root, "userdata");
  mkdirSync(userdata, { recursive: true });
  if (existing) writeFileSync(join(userdata, "settings.json"), JSON.stringify(existing, null, 2));
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUBATO_GUI_T3_HOME: root,
      RUBATO_GUI_BRIDGE: "/repo/harness/t3-integration/src/bridge.mjs",
      RUBATO_GUI_DESCRIPTOR: "/home/.rubato-pi/agent/server/connection.json",
      RUBATO_GUI_CATALOGUE: "/home",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    settings: JSON.parse(readFileSync(join(userdata, "settings.json"), "utf8")),
    clientPath: join(userdata, "client-settings.json"),
  };
}

test("a first install gets a working default model", (t) => {
  const { settings } = writeSettings(t, null);
  assert.equal(settings.defaultModelSelection.instanceId, "rubato");
  assert.equal(settings.defaultModelSelection.model, "xai/grok-4.6");
  // The keys must exist: an absent textGenerationModelSelection decodes to
  // codex and pulls a driver we just turned off back onto the screen.
  assert.ok(settings.textGenerationModelSelection);
  assert.ok(settings.sourceControlWriterModelSelection);
  assert.equal(settings.providers.codex.enabled, false);
});

test("a reinstall keeps the model the user chose, options and all", (t) => {
  const chosen = {
    instanceId: "rubato",
    model: "anthropic/claude-opus-5",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const { settings } = writeSettings(t, { defaultModelSelection: chosen });
  assert.deepEqual(settings.defaultModelSelection, chosen);
  // Thread titles and commit messages are errands: they get the cheap model,
  // not whatever expensive one the user picked for the conversation.
  assert.equal(settings.textGenerationModelSelection.model, "xai/grok-4.6");
  assert.equal(settings.sourceControlWriterModelSelection.model, "xai/grok-4.6");
});

test("a reinstall keeps an errand model the user set by hand", (t) => {
  const mine = { instanceId: "rubato", model: "anthropic/claude-haiku-4-5" };
  const { settings } = writeSettings(t, { textGenerationModelSelection: mine });
  assert.deepEqual(settings.textGenerationModelSelection, mine);
});

test("a reinstall leaves a provider the user turned on alone", (t) => {
  const { settings } = writeSettings(t, { providers: { codex: { enabled: true } } });
  assert.equal(settings.providers.codex.enabled, true);
  // Untouched kinds still have to be present and off.
  assert.equal(settings.providers.claudeAgent.enabled, false);
});

test("a reinstall leaves a provider instance the user made alone", (t) => {
  const { settings } = writeSettings(t, {
    providerInstances: {
      mine: { driver: "codex", enabled: true },
      "rubato-pi": { driver: "rubato-pi", enabled: true },
    },
  });
  assert.equal(settings.providerInstances.mine.enabled, true);
  // Our own older instance is the one that gets retired: two of the same
  // driver show the same models twice.
  assert.equal(settings.providerInstances["rubato-pi"].enabled, false);
  assert.equal(settings.providerInstances.rubato.enabled, true);
});

test("wiring is rewritten every time, because the repo can move", (t) => {
  const { settings } = writeSettings(t, {
    providerInstances: { rubato: { driver: "rubato-pi", enabled: true, config: { bridgeModule: "/old/bridge.mjs" } } },
  });
  assert.equal(settings.providerInstances.rubato.config.bridgeModule, "/repo/harness/t3-integration/src/bridge.mjs");
});

test("a reordered model list survives, and new models join the end", (t) => {
  const { settings } = writeSettings(t, {
    providerModelPreferences: { rubato: { hiddenModels: ["xai/grok-4.6"], modelOrder: ["anthropic/claude-opus-5"] } },
  });
  const order = settings.providerModelPreferences.rubato.modelOrder;
  assert.equal(order[0], "anthropic/claude-opus-5");
  assert.ok(order.length > 1, "catalog models should be appended");
  assert.deepEqual(settings.providerModelPreferences.rubato.hiddenModels, ["xai/grok-4.6"]);
});

// Fonts, themes and the rest of client-settings.json are values we never set.
// Rewriting a file we did not change has nothing to gain and a reader/writer
// race to lose.
test("client settings are not rewritten once the recommended set was applied", (t) => {
  const first = writeSettings(t, null);
  const before = readFileSync(first.clientPath, "utf8");
  const stamped = JSON.parse(before);
  assert.equal(stamped.legacySidebarEnabled, true);
  writeFileSync(first.clientPath, JSON.stringify({ ...stamped, fontSizeTerminal: 18, legacySidebarEnabled: false }));
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUBATO_GUI_T3_HOME: first.clientPath.replace("/userdata/client-settings.json", ""),
      RUBATO_GUI_BRIDGE: "/repo/harness/t3-integration/src/bridge.mjs",
      RUBATO_GUI_DESCRIPTOR: "/home/.rubato-pi/agent/server/connection.json",
      RUBATO_GUI_CATALOGUE: "/home",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const after = JSON.parse(readFileSync(first.clientPath, "utf8"));
  assert.equal(after.fontSizeTerminal, 18);
  // Turned off on purpose; an update does not turn it back on.
  assert.equal(after.legacySidebarEnabled, false);
});
