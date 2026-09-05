// Interactive reload preflight on stock Pi 0.84.2 after reload-guard.patch.
// Drives REAL patched InteractiveMode.handleReloadCommand / resetExtensionUI /
// setCustomEditorComponent. AgentSession.bindExtensions so beforeSessionStart runs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const GUARD_PATCH = join(repoRoot, "harness", "pi-patches", "pi-coding-agent", "0.84.2", "reload-guard.patch");
const UI_PATCH = join(repoRoot, "harness", "pi-patches", "pi-coding-agent", "0.84.2", "reload-ui.patch");
const GUARD_TS = join(repoRoot, "packages", "rubato-runtime", "src", "components", "task", "reload-guard.ts");
const STATUS_LINE_TS = join(repoRoot, "packages", "senpi-task", "src", "status-line.ts");
const FIXTURE = process.env.PI_STOCK_FIXTURE_DIR ??
  "/tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent";
const PATCH_TIMEOUT_MS = 8000;
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];

function fixtureProblem() {
  if (!existsSync(join(FIXTURE, "package.json"))) return `stock fixture missing at ${FIXTURE}`;
  try {
    const pkg = JSON.parse(readFileSync(join(FIXTURE, "package.json"), "utf8"));
    if (pkg.version !== "0.84.2" || !String(pkg.name).endsWith("pi-coding-agent")) {
      return `stock fixture is ${pkg.name}@${pkg.version}, want pi-coding-agent@0.84.2`;
    }
  } catch (error) {
    return `stock fixture unreadable: ${String(error)}`;
  }
  if (!existsSync(GUARD_PATCH) || !existsSync(UI_PATCH)) return "reload-guard or reload-ui patch missing";
  return null;
}

const SKIP = fixtureProblem();

function runPatch(args, cwd) {
  try {
    const stdout = execFileSync("patch", args, {
      cwd,
      encoding: "utf8",
      timeout: PATCH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    if (error.killed || error.signal) {
      throw new Error(`patch timed out or killed (${error.signal ?? "timeout"}): ${args.join(" ")}`);
    }
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

function copyPristine(dest) {
  cpSync(FIXTURE, dest, {
    recursive: true,
    filter: (src) => src !== join(FIXTURE, "node_modules"),
  });
  const nm = join(FIXTURE, "node_modules");
  if (existsSync(nm)) symlinkSync(nm, join(dest, "node_modules"));
}

function applyBoth(pkgDir) {
  const guard = runPatch([...PATCH_FLAGS, "-i", GUARD_PATCH], pkgDir);
  assert.equal(guard.status, 0, `reload-guard apply failed: ${guard.stdout}\n${guard.stderr}`);
  const ui = runPatch([...PATCH_FLAGS, "-i", UI_PATCH], pkgDir);
  assert.equal(ui.status, 0, `reload-ui apply failed: ${ui.stdout}\n${ui.stderr}`);
  assert.match(`${ui.stdout}\n${ui.stderr}`, /interactive-mode\.js/);
}

let prepared = null;
function preparePatched() {
  if (prepared) return prepared;
  const dir = mkdtempSync(join(tmpdir(), "pi-reload-ui-"));
  const pkgDir = join(dir, "pkg");
  copyPristine(pkgDir);
  applyBoth(pkgDir);
  prepared = { dir, pkgDir };
  return prepared;
}

let hooksRegistered = false;
let guardModPromise = null;
function loadGuardExports() {
  if (!guardModPromise) {
    if (!hooksRegistered) {
      hooksRegistered = true;
      const piTui = join(FIXTURE, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "@rubato/senpi-task") {
            return { url: pathToFileURL(STATUS_LINE_TS).href, shortCircuit: true };
          }
          if (specifier === "@earendil-works/pi-tui" && existsSync(piTui)) {
            return { url: pathToFileURL(piTui).href, shortCircuit: true };
          }
          if (specifier.startsWith(".") && context.parentURL) {
            const parent = fileURLToPath(context.parentURL);
            if (parent.includes("/packages/senpi-task/") || parent.includes("/packages/rubato-runtime/")) {
              let candidate = join(dirname(parent), specifier);
              if (!existsSync(candidate)) {
                if (existsSync(`${candidate}.ts`)) candidate = `${candidate}.ts`;
                else if (existsSync(join(candidate, "index.ts"))) candidate = join(candidate, "index.ts");
              }
              if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
            }
          }
          return nextResolve(specifier, context);
        },
      });
    }
    guardModPromise = import(pathToFileURL(GUARD_TS).href);
  }
  return guardModPromise;
}

async function loadPatchedModules() {
  const { pkgDir } = preparePatched();
  const sessionUrl = pathToFileURL(join(pkgDir, "dist", "core", "agent-session.js")).href;
  const loaderUrl = pathToFileURL(join(pkgDir, "dist", "core", "extensions", "loader.js")).href;
  const interactiveUrl = pathToFileURL(join(pkgDir, "dist", "modes", "interactive", "interactive-mode.js")).href;
  const themeUrl = pathToFileURL(join(pkgDir, "dist", "modes", "interactive", "theme", "theme.js")).href;
  const [{ AgentSession }, loader, interactive, themeMod, rpcSrc] = await Promise.all([
    import(sessionUrl),
    import(loaderUrl),
    import(interactiveUrl),
    import(themeUrl),
    readFileSync(join(pkgDir, "dist", "modes", "rpc", "rpc-mode.js"), "utf8"),
  ]);
  themeMod.initTheme("dark", false);
  return { AgentSession, loader, InteractiveMode: interactive.InteractiveMode, rpcSrc, pkgDir };
}

function runningRecord() {
  return {
    task_id: "st_9",
    status: "running",
    name: "deep-refactor",
    parent_session_id: "parent",
    root_session_id: "root",
    depth: 1,
    execution_mode: "in-process",
    model: "faux/faux-1",
    residency_state: "resident",
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-28T00:00:00.000Z",
    notification: { run_epoch: 1, notified_epoch: 0 },
    notify_on_terminal: false,
  };
}

function makeSession(AgentSession, extensions, runtime, counters) {
  const extensionRunnerRef = { current: undefined };
  const agent = {
    subscribe: () => () => {},
    state: { tools: [], messages: [], systemPrompt: "", model: undefined, thinkingLevel: "off" },
  };
  const session = new AgentSession({
    agent,
    sessionManager: {
      getSessionName: () => undefined,
      getSessionFile: () => undefined,
      getSessionId: () => "s",
      getCwd: () => "/tmp",
    },
    settingsManager: {
      getImageAutoResize: () => false,
      getShellCommandPrefix: () => undefined,
      getShellPath: () => undefined,
      reload: async () => { counters.settings += 1; },
      isProjectTrusted: () => true,
      getSteeringMode: () => "all",
      getFollowUpMode: () => "all",
      getHideThinkingBlock: () => false,
      getOutputPad: () => 1,
    },
    cwd: "/tmp",
    resourceLoader: {
      getExtensions: () => ({ extensions, runtime }),
      getSystemPrompt: () => undefined,
      getAppendSystemPrompt: () => [],
      getSkills: () => ({ skills: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getPrompts: () => ({ prompts: [] }),
      getThemes: () => ({ themes: [] }),
      reload: async () => { counters.resource += 1; },
    },
    modelRuntime: {
      registerProvider() {},
      registerNativeProvider() {},
      unregisterProvider() {},
      hasConfiguredAuth: () => false,
      getModel: () => undefined,
      getModels: () => [],
      getAvailableSnapshot: () => [],
      getError: () => undefined,
      refresh: async () => {},
    },
    baseToolsOverride: {},
    extensionRunnerRef,
  });
  return { session, extensionRunnerRef };
}

function emptyCounters() {
  return {
    settings: 0, resource: 0, shutdown: 0,
    warning: [], status: [], error: [],
    keybindings: 0, rebuild: 0,
  };
}

/** Real InteractiveMode prototype for resetExtensionUI / setCustomEditorComponent. */
function makeLiveHost(InteractiveMode, session, counters, { custom = false } = {}) {
  const defaultEditor = {
    id: "defaultEditor",
    getText: () => "draft",
    setText() {},
  };
  const customEditor = {
    id: "customEditor",
    getText: () => "custom-draft",
    setText() {},
  };
  const children = [];
  let focus = null;
  const host = Object.create(InteractiveMode.prototype);
  const initial = custom ? customEditor : defaultEditor;
  children.push(initial);
  Object.assign(host, {
    runtimeHost: { session },
    defaultEditor,
    editor: initial,
    editorComponentFactory: custom ? () => customEditor : undefined,
    editorContainer: {
      clear() { children.length = 0; },
      addChild(child) { children.push(child); },
    },
    ui: {
      setFocus(target) { focus = target; },
      requestRender() {},
      hideOverlay() {},
    },
    keybindings: { reload() { counters.keybindings += 1; } },
    customHeader: undefined,
    builtInHeader: undefined,
    toolOutputExpanded: false,
    themeController: { applyFromSettings: async () => {} },
    autocompleteProvider: undefined,
    extensionSelector: undefined,
    extensionInput: undefined,
    extensionEditor: undefined,
    disposeActiveSelector() {},
    clearExtensionTerminalInputListeners() {},
    setExtensionFooter() {},
    setExtensionHeader() {},
    clearExtensionWidgets() {},
    footerDataProvider: { clearExtensionStatuses() {} },
    footer: { invalidate() {} },
    showWarning(message) { counters.warning.push(message); },
    showStatus(message) { counters.status.push(message); },
    showError(message) { counters.error.push(message); },
    rebuildChatFromMessages() { counters.rebuild += 1; },
    applyRuntimeSettings() {},
    setupAutocompleteProvider() {},
    setupExtensionShortcuts() {},
    showLoadedResources() {},
    maybeSaveImplicitProjectTrustAfterReload() { return false; },
    updateTerminalTitle() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    hideThinkingBlock: false,
    outputPad: 1,
  });
  assert.equal(host.resetExtensionUI, InteractiveMode.prototype.resetExtensionUI);
  assert.equal(host.setCustomEditorComponent, InteractiveMode.prototype.setCustomEditorComponent);
  return {
    host,
    children,
    defaultEditor,
    customEditor,
    snapshot: () => ({
      childIds: children.map((c) => c.id ?? c.constructor?.name),
      focusId: focus?.id ?? focus?.constructor?.name,
      focus,
      children: [...children],
      editor: host.editor,
    }),
  };
}

test("reload-ui applies after reload-guard at fuzz 0", { skip: SKIP ?? undefined }, () => {
  const { pkgDir } = preparePatched();
  assert.ok(existsSync(join(pkgDir, "dist", "modes", "interactive", "interactive-mode.js")));
});

test("negative drift: mutated handleReloadCommand anchor fails reload-ui.patch", { skip: SKIP ?? undefined }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reload-ui-drift-"));
  copyPristine(dir);
  const guard = runPatch([...PATCH_FLAGS, "-i", GUARD_PATCH], dir);
  assert.equal(guard.status, 0);
  const target = join(dir, "dist", "modes", "interactive", "interactive-mode.js");
  const original = readFileSync(target, "utf8");
  const anchor = "            this.showWarning(\"Wait for compaction to finish before reloading.\");";
  assert.ok(original.includes(anchor), "stock handleReloadCommand hunk anchor missing");
  writeFileSync(target, original.replace(anchor, `${anchor} // drifted`));
  const result = runPatch([...PATCH_FLAGS, "-i", UI_PATCH], dir);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `drifted tree must reject reload-ui, got ${result.status}: ${out}`);
  assert.match(out, /hunks failed|failed while patching/i);
  assert.doesNotMatch(out, /previously applied/);
});

test("veto: InteractiveMode does not clear UI, show success, or teardown", { skip: SKIP ?? undefined }, async () => {
  const { wireReloadGuard, evaluateReloadVeto } = await loadGuardExports();
  const { AgentSession, loader, InteractiveMode } = await loadPatchedModules();
  const manager = {
    residentTaskIds: () => [runningRecord().task_id],
    get: () => runningRecord(),
  };
  const expected = evaluateReloadVeto(manager);
  const counters = emptyCounters();
  const runtime = loader.createExtensionRuntime();
  const guard = await loader.loadExtensionFromFactory(async (pi) => {
    wireReloadGuard(pi, manager);
    pi.on("session_shutdown", () => { counters.shutdown += 1; });
  }, "/tmp", undefined, runtime);
  const { session } = makeSession(AgentSession, [guard], runtime, counters);
  const { host, snapshot, defaultEditor } = makeLiveHost(InteractiveMode, session, counters);
  const before = snapshot();
  const returned = await InteractiveMode.prototype.handleReloadCommand.call(host);
  const after = snapshot();
  assert.equal(returned, undefined);
  assert.deepEqual(after.children, before.children);
  assert.equal(after.editor, defaultEditor);
  assert.equal(counters.status.length, 0);
  assert.equal(counters.shutdown, 0);
  assert.equal(counters.settings, 0);
  assert.equal(counters.warning[0], expected.reason);
});

test("race after preflight: cancelled reload restores editor and skips success", { skip: SKIP ?? undefined }, async () => {
  const { InteractiveMode } = await loadPatchedModules();
  const counters = emptyCounters();
  let reloadCalls = 0;
  const session = {
    isStreaming: false,
    isCompacting: false,
    checkReloadVeto: async () => ({ cancelled: false }),
    reload: async () => {
      reloadCalls += 1;
      return { cancelled: true, reason: "1 subagent(s) still running: raced" };
    },
    resourceLoader: { getThemes: () => ({ themes: [] }) },
    modelRuntime: { getError: () => undefined },
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp" },
    settingsManager: { getHideThinkingBlock: () => false, getOutputPad: () => 1 },
  };
  const { host, snapshot, defaultEditor } = makeLiveHost(InteractiveMode, session, counters);
  await InteractiveMode.prototype.handleReloadCommand.call(host);
  const after = snapshot();
  assert.equal(reloadCalls, 1);
  assert.equal(after.editor, defaultEditor);
  assert.equal(after.focus, defaultEditor);
  assert.equal(counters.status.length, 0);
  assert.match(counters.warning[0] ?? "", /raced|blocked/i);
  assert.equal(counters.keybindings, 0);
});

async function runBoundReload({ custom, throwAfterStart = false }) {
  const { wireReloadGuard } = await loadGuardExports();
  const { AgentSession, loader, InteractiveMode } = await loadPatchedModules();
  const counters = emptyCounters();
  let atSessionStart;
  const runtime = loader.createExtensionRuntime();
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    wireReloadGuard(pi, { residentTaskIds: () => [], get: () => undefined });
    pi.on("session_shutdown", () => { counters.shutdown += 1; });
    pi.on("session_start", (event) => {
      if (event.reason === "reload") atSessionStart = live.snapshot();
    });
  }, "/tmp", undefined, runtime);
  const { session } = makeSession(AgentSession, [ext], runtime, counters);
  await session.bindExtensions({ shutdownHandler() {} });
  const live = makeLiveHost(InteractiveMode, session, counters, { custom });
  if (throwAfterStart) {
    const realReload = session.reload.bind(session);
    session.reload = async (options) => {
      await realReload({
        beforeSessionStart: async () => {
          await options.beforeSessionStart?.();
        },
      });
      throw new Error("boom after beforeSessionStart");
    };
  }
  await InteractiveMode.prototype.handleReloadCommand.call(live.host);
  return { counters, atSessionStart, live, custom };
}

test("default editor: reload box still focused at session_start after real reset", { skip: SKIP ?? undefined }, async () => {
  const { counters, atSessionStart, live } = await runBoundReload({ custom: false });
  assert.ok(atSessionStart, "session_start(reason=reload) must run (hasBindings)");
  assert.ok(!atSessionStart.childIds.includes("defaultEditor"), `box lost at session_start: ${JSON.stringify(atSessionStart.childIds)}`);
  assert.equal(atSessionStart.focusId, "Container");
  assert.notEqual(atSessionStart.focus, live.defaultEditor);
  assert.equal(counters.warning.length, 0);
  assert.equal(counters.shutdown, 1);
  assert.ok(counters.status.some((line) => line.includes("Reloaded keybindings")));
  assert.equal(counters.keybindings, 1);
});

test("custom editor: reload box still focused at session_start after real reset", { skip: SKIP ?? undefined }, async () => {
  const { counters, atSessionStart, live } = await runBoundReload({ custom: true });
  assert.ok(atSessionStart, "session_start(reason=reload) must run (hasBindings)");
  assert.ok(!atSessionStart.childIds.includes("customEditor"), `custom editor visible at session_start: ${JSON.stringify(atSessionStart.childIds)}`);
  assert.ok(!atSessionStart.childIds.includes("defaultEditor"), `default editor stole the box: ${JSON.stringify(atSessionStart.childIds)}`);
  assert.equal(atSessionStart.focusId, "Container");
  assert.notEqual(atSessionStart.focus, live.customEditor);
  assert.notEqual(atSessionStart.focus, live.defaultEditor);
  assert.equal(counters.warning.length, 0);
  assert.ok(counters.status.some((line) => line.includes("Reloaded keybindings")));
});

test("error after beforeSessionStart with custom editor seats defaultEditor, not stale custom", { skip: SKIP ?? undefined }, async () => {
  const { counters, atSessionStart, live } = await runBoundReload({ custom: true, throwAfterStart: true });
  assert.ok(atSessionStart, "beforeSessionStart/session_start ran before the throw");
  assert.equal(atSessionStart.focusId, "Container");
  const after = live.snapshot();
  assert.equal(after.editor, live.defaultEditor, "this.editor must be default after reset");
  assert.equal(after.focus, live.defaultEditor);
  assert.ok(after.childIds.includes("defaultEditor"));
  assert.ok(!after.childIds.includes("customEditor"), `stale custom editor re-seated: ${JSON.stringify(after.childIds)}`);
  assert.match(counters.error[0] ?? "", /boom after beforeSessionStart/);
  assert.equal(counters.status.length, 0);
});

test("RPC command-context still discards session.reload result (documented retain)", { skip: SKIP ?? undefined }, async () => {
  const { rpcSrc } = await loadPatchedModules();
  assert.match(rpcSrc, /reload: async \(\) => \{\s*await session\.reload\(\);/s);
  assert.doesNotMatch(rpcSrc, /check_reload_veto/);
});
