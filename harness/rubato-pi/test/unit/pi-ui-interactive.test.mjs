// Stock InteractiveMode after reload-ui then ui-interactive. Real prototype methods.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const TUI_FIXTURE = process.env.PI_TUI_FIXTURE_DIR ?? "/tmp/pi-tui-scratch/package";
const CA_FIXTURE = process.env.PI_STOCK_FIXTURE_DIR ??
  "/tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent";
const TUI_PATCH = join(repoRoot, "harness", "pi-patches", "pi-tui", "0.84.2");
const CA_PATCH = join(repoRoot, "harness", "pi-patches", "pi-coding-agent", "0.84.2");
const PATCH_TIMEOUT_MS = 8000;
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];

function fixtureProblem() {
  if (!existsSync(join(TUI_FIXTURE, "package.json"))) return `tui fixture missing at ${TUI_FIXTURE}`;
  if (!existsSync(join(CA_FIXTURE, "package.json"))) return `coding-agent fixture missing at ${CA_FIXTURE}`;
  for (const file of [
    join(CA_PATCH, "reload-guard.patch"),
    join(CA_PATCH, "reload-ui.patch"),
    join(CA_PATCH, "ui-modules.patch"),
    join(CA_PATCH, "ui-interactive.patch"),
    join(CA_PATCH, "ui-slash-remote.patch"),
    join(TUI_PATCH, "ui-editor-markers.patch"),
  ]) {
    if (!existsSync(file)) return `missing ${file}`;
  }
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

function apply(pkgDir, patches) {
  for (const patch of patches) {
    const result = runPatch([...PATCH_FLAGS, "-i", patch], pkgDir);
    assert.equal(result.status, 0, `apply failed ${patch}: ${result.stdout}\n${result.stderr}`);
  }
}

let prepared = null;
function prepare() {
  if (prepared) return prepared;
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-im-"));
  const tuiDir = join(dir, "tui");
  const caDir = join(dir, "ca");
  cpSync(TUI_FIXTURE, tuiDir, {
    recursive: true,
    filter: (src) => src !== join(TUI_FIXTURE, "node_modules"),
  });
  cpSync(CA_FIXTURE, caDir, {
    recursive: true,
    filter: (src) => src !== join(CA_FIXTURE, "node_modules"),
  });
  const nm = join(CA_FIXTURE, "node_modules");
  if (existsSync(nm)) {
    symlinkSync(nm, join(tuiDir, "node_modules"));
    symlinkSync(nm, join(caDir, "node_modules"));
  }
  apply(tuiDir, [
    join(TUI_PATCH, "unicode-input.patch"),
    join(TUI_PATCH, "ui-editor-markers.patch"),
    join(TUI_PATCH, "ui-editor-mouse.patch"),
    join(TUI_PATCH, "ui-capabilities.patch"),
  ]);
  apply(caDir, [
    join(CA_PATCH, "reload-guard.patch"),
    join(CA_PATCH, "reload-ui.patch"),
    join(CA_PATCH, "ui-modules.patch"),
    join(CA_PATCH, "ui-interactive.patch"),
    join(CA_PATCH, "ui-slash-remote.patch"),
  ]);
  prepared = { dir, tuiDir, caDir };
  return prepared;
}

let hooks = false;
function hookTui(tuiDir) {
  if (hooks) return;
  hooks = true;
  const tuiIndex = join(tuiDir, "dist", "index.js");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@earendil-works/pi-tui" && existsSync(tuiIndex)) {
        return { url: pathToFileURL(tuiIndex).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

async function loadInteractive() {
  const { tuiDir, caDir } = prepare();
  hookTui(tuiDir);
  const interactive = await import(
    pathToFileURL(join(caDir, "dist/modes/interactive/interactive-mode.js")).href
  );
  const themeMod = await import(
    pathToFileURL(join(caDir, "dist/modes/interactive/theme/theme.js")).href
  );
  try { themeMod.initTheme("dark", false); } catch { /* already */ }
  const { Editor } = await import(pathToFileURL(join(tuiDir, "dist/components/editor.js")).href);
  return { InteractiveMode: interactive.InteractiveMode, Editor, caDir, tuiDir };
}

const theme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};

const maybe = SKIP ? test.skip : test;

maybe("ui-interactive applies after reload-ui with ProgressiveTranscript and image attach", async () => {
  const { caDir } = prepare();
  const src = readFileSync(join(caDir, "dist/modes/interactive/interactive-mode.js"), "utf8");
  assert.match(src, /ProgressiveTranscriptContainer/);
  assert.match(src, /insertImageMarker/);
  assert.match(src, /transferEditorContent/);
  assert.match(src, /StreamingRevealController/);
  assert.match(src, /attachToolComponent/);
  assert.match(src, /setCustomEditorComponent/);
  assert.match(src, /resetExtensionUI/);
});

maybe("attachToolComponent groups consecutive reads and leaves SKILL.md ungrouped", async () => {
  const { InteractiveMode } = await loadInteractive();
  const children = [];
  const host = Object.create(InteractiveMode.prototype);
  Object.assign(host, {
    ui: { requestRender() {} },
    toolOutputExpanded: false,
    turnWorkSummary: undefined,
    chatContainer: {
      addChild(child) { children.push(child); },
      children,
    },
  });
  const readA = { args: { file_path: "/tmp/a.ts" }, setExpanded() {}, identity: { toolName: "read" } };
  const readB = { args: { file_path: "/tmp/b.ts" }, setExpanded() {}, identity: { toolName: "read" } };
  const skill = { args: { file_path: "/tmp/SKILL.md" }, setExpanded() {}, identity: { toolName: "read" } };
  host.attachToolComponent("read", readA);
  host.attachToolComponent("read", readB);
  assert.equal(children.length, 1, "grouped reads share one child");
  assert.equal(children[0].size, 2);
  host.attachToolComponent("read", skill);
  assert.equal(children.length, 2, "SKILL.md is not absorbed");
  assert.equal(children[1], skill);
});

maybe("setCustomEditorComponent transfers paste markers onto a real Editor", async () => {
  const { InteractiveMode, Editor } = await loadInteractive();
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {}, getShowHardwareCursor() { return false; }, setFocus() {}, hideOverlay() {} };
  const defaultEditor = new Editor(tui, theme);
  const customEditor = new Editor(tui, theme);
  const body = Array.from({ length: 12 }, (_, i) => `draft ${i}`).join("\n");
  defaultEditor.handlePaste(body);
  const children = [];
  const host = Object.create(InteractiveMode.prototype);
  Object.assign(host, {
    editorComponentFactory: undefined,
    defaultEditor,
    editor: defaultEditor,
    pendingImages: new Map(),
    editorContainer: {
      clear() { children.length = 0; },
      addChild(child) { children.push(child); },
    },
    ui: tui,
    keybindings: {},
    autocompleteProvider: undefined,
    disposeActiveSelector() {},
  });
  host.setCustomEditorComponent(() => customEditor);
  assert.equal(host.editor, customEditor);
  assert.equal(customEditor.getExpandedText(), body);
  host.setCustomEditorComponent(undefined);
  assert.equal(host.editor, defaultEditor);
  assert.equal(defaultEditor.getExpandedText(), body);
});

maybe("subscribeImageMarkers restores attachment payloads on the live Editor", async () => {
  const { InteractiveMode, Editor } = await loadInteractive();
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {}, getShowHardwareCursor() { return false; } };
  const editor = new Editor(tui, theme);
  const host = Object.create(InteractiveMode.prototype);
  host.pendingImages = new Map();
  host.subscribeImageMarkers(editor);
  const id = editor.insertImageMarker();
  host.pendingImages.set(id, { type: "image", data: "AAAA", mimeType: "image/png" });
  const snap = editor.snapshotAttachmentState();
  assert.equal(snap.get(1).mimeType, "image/png");
  host.pendingImages.clear();
  editor.restoreAttachmentState(snap);
  assert.equal(host.pendingImages.get(1).data, "AAAA");
});

maybe("startTurnWorkSummary adds a real TurnWorkSummaryComponent that tracks thinking", async () => {
  const { InteractiveMode } = await loadInteractive();
  const children = [];
  const host = Object.create(InteractiveMode.prototype);
  host.ui = { requestRender() {} };
  host.chatContainer = {
    addChild(child) { children.push(child); },
    children,
  };
  const summary = host.startTurnWorkSummary();
  assert.equal(children[0], summary);
  assert.equal(host.startTurnWorkSummary(), summary);
  summary.trackAssistant(
    { setTurnWorkCollapsed() {}, setHideProgress() {} },
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "thinking", thinking: "plan", startedAt: 1, endedAt: 1500 }],
    },
  );
  const lines = summary.render(80);
  assert.ok(Array.isArray(lines) && lines.length === 1);
  assert.match(lines[0], /Worked 1 step/);
});

maybe("typed ? shows the shortcut overlay and a later key hides it", async () => {
  const { InteractiveMode } = await loadInteractive();
  const header = [];
  const host = Object.create(InteractiveMode.prototype);
  host.lastEditorText = "";
  host.lastInputWasPaste = false;
  host.headerContainer = {
    addChild(child) { header.push(child); },
    removeChild(child) {
      const at = header.indexOf(child);
      if (at >= 0) header.splice(at, 1);
    },
  };
  host.ui = { requestRender() {} };
  host.updateShortcutOverlay("?");
  assert.equal(header.length, 1);
  const overlay = header[0];
  const shown = overlay.render(60);
  assert.ok(shown.some((line) => /shortcut/i.test(line) || /interrupt/i.test(line) || /Keyboard/i.test(line)));
  host.updateShortcutOverlay("?x");
  assert.equal(header.length, 0);
  assert.equal(host.shortcutOverlay, undefined);
});

maybe("respondToUiRequest accepts a select value and rejects cancel-without-value", async () => {
  const { InteractiveMode } = await loadInteractive();
  const host = Object.create(InteractiveMode.prototype);
  const seen = [];
  host.runtimeHost = {
    session: {
      emitExtensionEvent(type, payload) { seen.push({ type, payload }); },
      extensionRunner: { getRegisteredCommands() { return []; } },
      isStreaming: false,
    },
  };
  const surface = host.createInteractiveControlSurface();
  const id = host.openStandardUiRequest({ kind: "select", title: "Pick", options: ["alpha", "beta"] }, (value, origin) => {
    seen.push({ value, origin });
  });
  assert.equal(surface.respondToUiRequest(id, "nope"), false);
  assert.equal(surface.respondToUiRequest(id, undefined), false);
  assert.equal(surface.respondToUiRequest(id, "beta"), true);
  assert.equal(seen.at(-1).value, "beta");
  assert.equal(seen.at(-1).origin, "remote");
  const commands = surface.listCommands();
  const reload = commands.find((item) => item.name === "reload");
  const settings = commands.find((item) => item.name === "settings");
  assert.equal(reload.remoteMode, "native-action");
  assert.equal(settings.remoteMode, "terminal-only");
  const native = await surface.submitInput("/reload");
  assert.equal(native.accepted, false);
  assert.equal(native.reason, "native_action_required");
  const terminal = await surface.submitInput("/settings");
  assert.equal(terminal.accepted, false);
  assert.equal(terminal.reason, "terminal_required");
});

maybe("showExtensionSelector abort resolves undefined without a selected value", async () => {
  const { InteractiveMode } = await loadInteractive();
  const host = Object.create(InteractiveMode.prototype);
  const children = [];
  let focus;
  host.runtimeHost = { session: { emitExtensionEvent() {} } };
  host.ui = { setFocus(target) { focus = target; }, requestRender() {} };
  host.editor = { id: "editor" };
  host.editorContainer = {
    clear() { children.length = 0; },
    addChild(child) { children.push(child); },
  };
  host.disposeActiveSelector = () => {};
  host.hideExtensionSelector = InteractiveMode.prototype.hideExtensionSelector;
  host.toggleToolOutputExpansion = () => {};
  const ac = new AbortController();
  const pending = host.showExtensionSelector("Pick", ["one", "two"], { signal: ac.signal });
  ac.abort();
  const value = await pending;
  assert.equal(value, undefined);
});
