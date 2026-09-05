// Senpi-only UI modules carried onto stock Pi 0.84.2. Imports REAL controllers.
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
  try {
    const tui = JSON.parse(readFileSync(join(TUI_FIXTURE, "package.json"), "utf8"));
    const ca = JSON.parse(readFileSync(join(CA_FIXTURE, "package.json"), "utf8"));
    if (tui.version !== "0.84.2" || !String(tui.name).endsWith("pi-tui")) return `tui is ${tui.name}@${tui.version}`;
    if (ca.version !== "0.84.2" || !String(ca.name).endsWith("pi-coding-agent")) return `ca is ${ca.name}@${ca.version}`;
  } catch (error) {
    return String(error);
  }
  for (const file of [
    join(TUI_PATCH, "unicode-input.patch"),
    join(TUI_PATCH, "ui-editor-markers.patch"),
    join(TUI_PATCH, "ui-editor-mouse.patch"),
    join(TUI_PATCH, "ui-capabilities.patch"),
    join(CA_PATCH, "reload-guard.patch"),
    join(CA_PATCH, "reload-ui.patch"),
    join(CA_PATCH, "ui-modules.patch"),
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
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-modules-"));
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

const maybe = SKIP ? test.skip : test;
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

maybe("ui-modules patch adds streaming/paste-transfer/group files", () => {
  const { caDir } = prepare();
  assert.equal(existsSync(join(caDir, "dist/modes/interactive/streaming-reveal.js")), true);
  assert.equal(existsSync(join(caDir, "dist/modes/interactive/editor-paste-transfer.js")), true);
  assert.equal(existsSync(join(caDir, "dist/modes/interactive/components/tool-group.js")), true);
  assert.equal(existsSync(join(caDir, "dist/modes/interactive/components/progressive-transcript-container.js")), true);
});

maybe("StreamingRevealController writes the full target when smooth streaming is off", async () => {
  const { tuiDir, caDir } = prepare();
  hookTui(tuiDir);
  const { StreamingRevealController } = await import(
    pathToFileURL(join(caDir, "dist/modes/interactive/streaming-reveal.js")).href
  );
  const seen = [];
  const component = {
    updateContent(message) {
      seen.push(message);
    },
  };
  const reveal = new StreamingRevealController({
    getSmoothStreaming: () => false,
    getSmoothStreamingFps: () => 30,
    getHideThinkingBlock: () => false,
    requestRender() {},
  });
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "한글과 emoji 😀 stay whole" }],
    stopReason: "stop",
  };
  reveal.begin(component, message);
  assert.ok(seen.length >= 1, "begin must update the component");
  assert.equal(seen.at(-1).content[0].text, message.content[0].text);
  assert.equal(reveal.isPacingHead(message), false);
  reveal.stop();
});

maybe("transferEditorContent moves paste registry across real Editor instances", async () => {
  const { tuiDir, caDir } = prepare();
  hookTui(tuiDir);
  const { Editor } = await import(pathToFileURL(join(tuiDir, "dist/components/editor.js")).href);
  const { transferEditorContent, expandSubmittedText } = await import(
    pathToFileURL(join(caDir, "dist/modes/interactive/editor-paste-transfer.js")).href
  );
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {}, getShowHardwareCursor() { return false; } };
  const source = new Editor(tui, theme);
  const target = new Editor(tui, theme);
  const body = Array.from({ length: 12 }, (_, i) => `xfer ${i}`).join("\n");
  source.handlePaste(body);
  const result = transferEditorContent(source, target);
  assert.equal(result.imageMarkersTransferred, true);
  assert.equal(target.getExpandedText(), body);
  assert.match(target.getText(), /\[paste #1/);
  assert.equal(expandSubmittedText(target, target.getText()), body);
});

maybe("ToolGroupComponent.canGroup keeps SKILL.md and git bash ungrouped", async () => {
  const { tuiDir, caDir } = prepare();
  hookTui(tuiDir);
  const themeMod = await import(pathToFileURL(join(caDir, "dist/modes/interactive/theme/theme.js")).href);
  try { themeMod.initTheme("dark", false); } catch { /* already */ }
  const { ToolGroupComponent } = await import(
    pathToFileURL(join(caDir, "dist/modes/interactive/components/tool-group.js")).href
  );
  assert.equal(ToolGroupComponent.canGroup("read", { file_path: "/tmp/foo.ts" }), true);
  assert.equal(ToolGroupComponent.canGroup("read", { file_path: "/proj/SKILL.md" }), false);
  assert.equal(ToolGroupComponent.canGroup("bash", { command: "git status" }), false);
  assert.equal(ToolGroupComponent.canGroup("bash", { command: "ls" }), true);
  assert.equal(ToolGroupComponent.canGroup("todo", {}), false);
  const ui = { requestRender() {} };
  const group = new ToolGroupComponent(ui);
  const tool = {
    identity: { toolName: "read" },
    args: { file_path: "/tmp/foo.ts" },
    result: undefined,
    setExpanded() {},
    toolGroup: undefined,
  };
  group.addTool(tool);
  assert.equal(group.size, 1);
  assert.equal(tool.toolGroup, group);
  const lines = group.render(80);
  assert.ok(Array.isArray(lines) && lines.length === 1);
  assert.match(lines[0], /1 tool/);
});

maybe("shortcut overlay classifies typed ? and tmux warning lists passthrough", async () => {
  const { tuiDir, caDir } = prepare();
  hookTui(tuiDir);
  const { classifyEditorInput, shouldShowShortcutOverlay } = await import(
    pathToFileURL(join(caDir, "dist/modes/interactive/components/shortcut-overlay.js")).href
  );
  assert.equal(classifyEditorInput("", "?", false), "typed");
  assert.equal(shouldShowShortcutOverlay("", "?", "typed"), true);
  assert.equal(shouldShowShortcutOverlay("x", "?", "typed"), false);
  const { buildTmuxSetupWarning } = await import(
    pathToFileURL(join(caDir, "dist/modes/interactive/tmux-setup.js")).href
  );
  const warning = buildTmuxSetupWarning({
    imagesEnabled: false,
    outerKittyCapable: true,
    version: "3.2a",
    allowPassthrough: "off",
    extendedKeys: "on",
    extendedKeysFormat: "csi-u",
  });
  assert.equal(typeof warning, "string");
  assert.match(warning, /tmux >= 3\.3|upgrade tmux/);
});

maybe("GrokChrome and WorkingTipCache construct on the carried modules", async () => {
  const { tuiDir, caDir } = prepare();
  hookTui(tuiDir);
  const themeMod = await import(pathToFileURL(join(caDir, "dist/modes/interactive/theme/theme.js")).href);
  try { themeMod.initTheme("dark", false); } catch { /* already */ }
  const { GrokChrome } = await import(pathToFileURL(join(caDir, "dist/modes/interactive/grok/chrome.js")).href);
  const chrome = new GrokChrome();
  const editorTheme = chrome.getEditorTheme();
  assert.equal(typeof editorTheme.borderColor, "function");
  assert.equal(editorTheme.borderColor("x").length > 0, true);
  const footer = chrome.createFooter({ model: undefined }, { getCwd: () => "/tmp" });
  assert.equal(typeof footer.render, "function");
  const { WorkingTipCache } = await import(pathToFileURL(join(caDir, "dist/modes/interactive/tips/working-tip.js")).href);
  const cache = new WorkingTipCache();
  let computes = 0;
  const first = cache.resolve(() => { computes += 1; return "tip-a"; });
  const second = cache.resolve(() => { computes += 1; return "tip-b"; });
  assert.equal(first, "tip-a");
  assert.equal(second, "tip-a");
  assert.equal(computes, 1);
  cache.resetForNewTurn();
  const third = cache.resolve(() => { computes += 1; return "tip-c"; });
  assert.equal(third, "tip-c");
});

maybe("ProgressiveTranscriptContainer exposes the resume tail budget", async () => {
  const { tuiDir, caDir } = prepare();
  hookTui(tuiDir);
  const { ProgressiveTranscriptContainer, DEFAULT_TAIL_BUDGET } = await import(
    pathToFileURL(join(caDir, "dist/modes/interactive/components/progressive-transcript-container.js")).href
  );
  assert.equal(DEFAULT_TAIL_BUDGET, 60);
  const container = new ProgressiveTranscriptContainer({ tailBudget: 8, warmChunkSize: 2 });
  assert.equal(typeof container.render, "function");
  assert.equal(typeof container.addChild, "function");
});
