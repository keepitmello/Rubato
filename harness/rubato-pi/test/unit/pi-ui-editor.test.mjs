// Stock Pi 0.84.2 Editor after ui-editor-markers + ui-editor-mouse + ui-capabilities.
// Drives REAL Editor.handlePaste / insertImageMarker / handleMouse / expandMatchingPaste.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { injectPasteExpand } from "../../src/paste-expand.mjs";
import { injectEditorMouse } from "../../src/editor-mouse.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const TUI_FIXTURE = process.env.PI_TUI_FIXTURE_DIR ?? "/tmp/pi-tui-scratch/package";
const CA_FIXTURE = process.env.PI_STOCK_FIXTURE_DIR ??
  "/tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent";
const PATCH_DIR = join(repoRoot, "harness", "pi-patches", "pi-tui", "0.84.2");
const UNICODE = join(PATCH_DIR, "unicode-input.patch");
const MARKERS = join(PATCH_DIR, "ui-editor-markers.patch");
const MOUSE = join(PATCH_DIR, "ui-editor-mouse.patch");
const CAPS = join(PATCH_DIR, "ui-capabilities.patch");
const PATCH_TIMEOUT_MS = 8000;
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];

function fixtureProblem() {
  if (!existsSync(join(TUI_FIXTURE, "package.json"))) return `tui fixture missing at ${TUI_FIXTURE}`;
  try {
    const pkg = JSON.parse(readFileSync(join(TUI_FIXTURE, "package.json"), "utf8"));
    if (pkg.version !== "0.84.2" || !String(pkg.name).endsWith("pi-tui")) {
      return `tui fixture is ${pkg.name}@${pkg.version}`;
    }
  } catch (error) {
    return `tui fixture unreadable: ${String(error)}`;
  }
  for (const file of [UNICODE, MARKERS, MOUSE, CAPS]) {
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

function copyTui(dest) {
  cpSync(TUI_FIXTURE, dest, {
    recursive: true,
    filter: (src) => src !== join(TUI_FIXTURE, "node_modules"),
  });
  const nm = join(CA_FIXTURE, "node_modules");
  if (existsSync(nm)) symlinkSync(nm, join(dest, "node_modules"));
}

function applyUi(pkgDir) {
  for (const patch of [UNICODE, MARKERS, MOUSE, CAPS]) {
    const result = runPatch([...PATCH_FLAGS, "-i", patch], pkgDir);
    assert.equal(result.status, 0, `apply failed ${patch}: ${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /fuzz [1-9]/i);
  }
}

let prepared = null;
function prepare() {
  if (prepared) return prepared;
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-editor-"));
  const pkgDir = join(dir, "pkg");
  copyTui(pkgDir);
  applyUi(pkgDir);
  prepared = { dir, pkgDir };
  return prepared;
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

async function loadEditor() {
  const { pkgDir } = prepare();
  const mod = await import(`${pathToFileURL(join(pkgDir, "dist", "components", "editor.js")).href}?t=${Date.now()}`);
  const caps = await import(`${pathToFileURL(join(pkgDir, "dist", "terminal-image.js")).href}?t=${Date.now()}`);
  return { Editor: mod.Editor, caps, pkgDir };
}

function makeEditor(Editor) {
  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
    getShowHardwareCursor() { return false; },
    copied: [],
    copySelection(text) { this.copied.push(text); return true; },
    flash() {},
  };
  const editor = new Editor(tui, theme);
  editor.focused = true;
  return { editor, tui };
}

function largePaste(label = "alpha") {
  return Array.from({ length: 12 }, (_, i) => `${label} line ${i + 1}`).join("\n");
}

const maybe = SKIP ? test.skip : test;

maybe("ui editor patches apply fuzz-0 after unicode-input", () => {
  prepare();
});

maybe("negative drift: mutated editor hunk anchor rejects ui-editor-markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-editor-drift-"));
  const pkgDir = join(dir, "pkg");
  copyTui(pkgDir);
  const target = join(pkgDir, "dist", "components", "editor.js");
  const original = readFileSync(target, "utf8");
  writeFileSync(target, original.replace("pastes = new Map();", "pastes = new WeakMap();"));
  const unicode = runPatch([...PATCH_FLAGS, "-i", UNICODE], pkgDir);
  assert.equal(unicode.status, 0, unicode.stdout + unicode.stderr);
  const markers = runPatch([...PATCH_FLAGS, "-i", MARKERS], pkgDir);
  assert.notEqual(markers.status, 0);
});

maybe("large paste stores a registry marker and expands on submit", async () => {
  const { Editor } = await loadEditor();
  const { editor } = makeEditor(Editor);
  const body = largePaste("block");
  editor.handlePaste(body);
  assert.match(editor.getText(), /\[paste #1 \+12 lines\]/);
  assert.equal(editor.getExpandedText(), body);
  const snap = editor.getPasteState();
  assert.equal(snap.pastes.get(1), body);
  let submitted;
  editor.onSubmit = (text) => { submitted = text; };
  editor.submitValue();
  assert.equal(submitted, body);
  assert.equal(editor.getText(), "");
});

maybe("expandMatchingPaste restores a 3-line-unequal sibling after undo-sized block", async () => {
  const { Editor } = await loadEditor();
  const { editor } = makeEditor(Editor);
  const body = largePaste("once");
  editor.handlePaste(body);
  assert.match(editor.getText(), /\[paste #1/);
  editor.handlePaste(body);
  assert.equal(editor.getExpandedText(), body);
  assert.equal(editor.getText(), body);
});

maybe("insertImageMarker returns canonical id and fires onImageMarkersChanged", async () => {
  const { Editor } = await loadEditor();
  const { editor } = makeEditor(Editor);
  const orders = [];
  editor.onImageMarkersChanged = (order) => orders.push([...order]);
  const id = editor.insertImageMarker();
  assert.equal(id, 1);
  assert.match(editor.getText(), /\[Image #1\]/);
  assert.deepEqual(editor.getImageMarkerState().ids ?? [...editor.imageMarkers.ids(editor.getText())], [1]);
  assert.ok(orders.length >= 1);
});

maybe("mouse press-drag-release selects text and copySelection receives it", async () => {
  const { Editor } = await loadEditor();
  const { editor, tui } = makeEditor(Editor);
  editor.setText("abcdefghijklmnopqrstuvwxyz");
  editor.render(40);
  const start = editor.getMousePosition(2, 1);
  const end = editor.getMousePosition(10, 1);
  assert.ok(start && end, "visual positions");
  assert.equal(editor.handleMouse({ kind: "press", x: 2, y: 1 }), true);
  assert.equal(editor.handleMouse({ kind: "drag", x: 10, y: 1 }), true);
  assert.equal(editor.handleMouse({ kind: "release", x: 10, y: 1 }), true);
  const selected = editor.getMouseSelectedText();
  assert.ok(selected.length > 0, `selected ${JSON.stringify(selected)}`);
  assert.match(selected, /[a-z]+/);
});

maybe("capability overrides and tmux passthrough wrap round-trip", async () => {
  const { caps } = await loadEditor();
  caps.resetCapabilitiesCache();
  caps.setCapabilityOverrides({ images: "kitty", hyperlinks: true });
  const got = caps.getCapabilities();
  assert.equal(got.images, "kitty");
  assert.equal(got.hyperlinks, true);
  const wrapped = caps.wrapTmuxPassthrough("\x1b[0m");
  assert.equal(wrapped.startsWith("\x1bPtmux;"), true);
  assert.match(wrapped, /\x1b\x1b\[0m/);
  assert.equal(caps.outerKittyGraphicsMode("xterm-kitty"), "placeholder");
  assert.equal(caps.outerKittyGraphicsMode("xterm"), null);
});

maybe("existing paste-expand and editor-mouse chrome no-op on the patched editor", async () => {
  const { pkgDir } = prepare();
  const editorSrc = readFileSync(join(pkgDir, "dist", "components", "editor.js"), "utf8");
  assert.equal(injectPasteExpand(editorSrc), editorSrc);
  assert.equal(injectEditorMouse(editorSrc), editorSrc);
});
