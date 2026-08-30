import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { senpiNested } from "../../src/engine-paths.mjs";
import { nodeChildEnv, resolveNodeExecutable } from "../helpers/node-executable.mjs";
import { injectEditorMouse } from "../../src/editor-mouse.mjs";
import {
  injectPasteExpand,
  isPasteExpandModuleUrl,
} from "../../src/paste-expand.mjs";

const tuiDist = senpiNested("@earendil-works/pi-tui/dist");
const editorPath = join(tuiDist, "components/editor.js");
const nestedPrefix = "file:///repo/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-tui/dist/";
const hoistedPrefix = "file:///repo/node_modules/@earendil-works/pi-tui/dist/";
const registerHref = new URL("../../src/no-changelog-register.mjs", import.meta.url).href;
const thisFile = fileURLToPath(import.meta.url);
const runtime = process.env.RUBATO_PASTE_EXPAND_RUNTIME === "1";

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

function makeEditor(Editor) {
  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
    getShowHardwareCursor() { return false; },
  };
  const editor = new Editor(tui, theme);
  editor.focused = true;
  return editor;
}

function largePaste(label = "alpha") {
  return Array.from({ length: 12 }, (_, i) => `${label} line ${i + 1}`).join("\n");
}

if (!runtime) {
  test("URL matching targets Senpi nested and hoisted editor modules", () => {
    assert.equal(isPasteExpandModuleUrl(`${nestedPrefix}components/editor.js`), true);
    assert.equal(isPasteExpandModuleUrl(`${hoistedPrefix}components/editor.js`), true);
    assert.equal(isPasteExpandModuleUrl(`${hoistedPrefix}editor-component.js`), false);
    assert.equal(isPasteExpandModuleUrl(`${nestedPrefix}tui-alt-screen.js`), false);
  });

  test("transform is anchored, idempotent, and fails on pinned-source drift", () => {
    const editorSource = readFileSync(editorPath, "utf8");
    const next = injectPasteExpand(editorSource);
    assert.notEqual(next, editorSource);
    assert.match(next, /expandMatchingPaste/);
    assert.match(next, /rubato\.pasteExpand\.injected/);
    assert.equal(injectPasteExpand(next), next);
    assert.throws(
      () => injectPasteExpand(editorSource.replace(
        "if (pastedLines.length > 10 || totalChars > 1000)",
        "if (pastedLines.length > 11 || totalChars > 1000)",
      )),
      /transform drift: large paste branch/,
    );
    assert.throws(
      () => injectPasteExpand(editorSource.replace(
        "removePasteMarker(id)",
        "removePasteMarker(pasteId)",
      )),
      /transform drift: expand matching paste method/,
    );
  });

  test("large-paste expand still matches after the editor-mouse rewrite", () => {
    const editorSource = readFileSync(editorPath, "utf8");
    const withMouse = injectEditorMouse(editorSource);
    const withBoth = injectPasteExpand(withMouse);
    assert.match(withMouse, /deleteMouseSelection\(false\)/);
    assert.match(withBoth, /deleteMouseSelection\(false\)/);
    assert.match(withBoth, /expandMatchingPaste/);
    assert.equal(injectPasteExpand(withBoth), withBoth);
    assert.equal(injectEditorMouse(withBoth), withBoth);
  });

  test("transformed editor expands a repeated large paste through an explicit child import without inherited NODE_OPTIONS", () => {
    const result = spawnSync(resolveNodeExecutable(), ["--import", registerHref, "--test", "--test-reporter=spec", thisFile], {
      env: nodeChildEnv({ RUBATO_PASTE_EXPAND_RUNTIME: "1" }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /fail 0/);
    assert.match(result.stdout, /pass [1-9]/);
  });
} else {
  test("child import has a clean NODE_OPTIONS and a transformed Editor", async () => {
    assert.equal(process.env.NODE_OPTIONS ?? "", "");
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?paste-expand=${Date.now()}`);
    assert.equal(typeof Editor.prototype.expandMatchingPaste, "function");
    assert.equal(typeof Editor.prototype.handlePaste, "function");
  });

  test("repeated large paste expands the placeholder in place without doubling on submit", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?paste-expand=${Date.now()}`);
    const editor = makeEditor(Editor);
    const body = largePaste();

    editor.handleInput(`\x1b[200~${body}\x1b[201~`);
    assert.equal(editor.getText(), "[paste #1 +12 lines]");
    assert.equal(editor.getExpandedText(), body);
    assert.equal(editor.getPasteState().pastes.size, 1);

    editor.handleInput(`\x1b[200~${body}\x1b[201~`);
    assert.equal(editor.getText(), body);
    assert.equal(editor.getExpandedText(), body);
    assert.equal(editor.getPasteState().pastes.size, 0);
    assert.equal(editor.getPasteState().pasteCounter, 0);

    const submitted = [];
    editor.onSubmit = (value) => submitted.push(value);
    editor.submitValue();
    assert.deepEqual(submitted, [body]);
    assert.equal(editor.getText(), "");
    assert.equal(editor.getPasteState().pastes.size, 0);
  });

  test("a third paste of the same body collapses again; a different body stays its own marker", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?paste-expand=${Date.now()}`);
    const first = makeEditor(Editor);
    const alpha = largePaste("alpha");
    const beta = largePaste("beta");

    first.handlePaste(alpha);
    first.handlePaste(beta);
    assert.equal(first.getText(), "[paste #1 +12 lines][paste #2 +12 lines]");
    first.handlePaste(alpha);
    assert.equal(first.getText(), `${alpha}[paste #1 +12 lines]`);
    assert.equal(first.getPasteState().pastes.size, 1);
    assert.equal(first.getExpandedText(), `${alpha}${beta}`);

    const again = makeEditor(Editor);
    again.handlePaste(alpha);
    again.handlePaste(alpha);
    assert.equal(again.getText(), alpha);
    again.handlePaste(alpha);
    assert.equal(again.getText(), `${alpha}[paste #1 +12 lines]`);
    const submitted = [];
    again.onSubmit = (value) => submitted.push(value);
    again.submitValue();
    assert.deepEqual(submitted, [`${alpha}${alpha}`]);
  });

  test("expanding a body that contains its own marker literal keeps that literal", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?paste-expand=${Date.now()}`);
    const editor = makeEditor(Editor);
    const body = ["[paste #1 +12 lines]", ...Array.from({ length: 11 }, (_, i) => `line${i}`)].join("\n");
    assert.equal(body.split("\n").length, 12);

    editor.handlePaste(body);
    assert.equal(editor.getText(), "[paste #1 +12 lines]");
    editor.handlePaste(body);
    assert.equal(editor.getText(), body);
    assert.equal(editor.getExpandedText(), body);
    assert.equal(editor.getPasteState().pastes.size, 0);

    const submitted = [];
    editor.onSubmit = (value) => submitted.push(value);
    editor.submitValue();
    assert.deepEqual(submitted, [body]);
  });

  test("selecting the marker then re-pasting does not leave a stale registry id", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?paste-expand=${Date.now()}`);
    const editor = makeEditor(Editor);
    const body = largePaste();
    editor.handlePaste(body);
    assert.equal(editor.getText(), "[paste #1 +12 lines]");
    editor.render(40);
    assert.equal(typeof editor.handleMouse, "function");
    assert.equal(editor.handleMouse({ kind: "press", x: 0, y: 1 }), true);
    assert.equal(editor.handleMouse({ kind: "drag", x: 22, y: 1 }), true);
    assert.equal(editor.handleMouse({ kind: "release", x: 22, y: 1 }), true);
    const selection = editor.getMouseSelection();
    assert.ok(selection);
    assert.equal(selection.start.line, 0);
    assert.equal(selection.start.col, 0);
    assert.equal(selection.end.line, 0);
    assert.equal(selection.end.col, editor.getText().length);

    editor.handlePaste(body);
    assert.equal(editor.getText(), "[paste #1 +12 lines]");
    assert.deepEqual([...editor.getPasteState().pastes.keys()], [1]);
    assert.equal(editor.getPasteState().pastes.size, 1);
    assert.equal(editor.getExpandedText(), body);

    const submitted = [];
    editor.onSubmit = (value) => submitted.push(value);
    editor.submitValue();
    assert.deepEqual(submitted, [body]);
  });

  test("undo after expand restores the collapsed marker and a mid-text expand keeps neighbors", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?paste-expand=${Date.now()}`);
    const alpha = largePaste("alpha");
    const beta = largePaste("beta");
    const mid = makeEditor(Editor);
    mid.setText("before ");
    mid.state.cursorLine = 0;
    mid.setCursorCol(7);
    mid.handlePaste(alpha);
    assert.equal(mid.getText(), "before [paste #1 +12 lines]");
    mid.handlePaste(alpha);
    assert.equal(mid.getText(), `before ${alpha}`);
    assert.equal(mid.getPasteState().pastes.size, 0);
    mid.undo();
    assert.equal(mid.getText(), "before [paste #1 +12 lines]");
    assert.equal(mid.getExpandedText(), `before ${alpha}`);

    const pair = makeEditor(Editor);
    pair.handlePaste(alpha);
    pair.handlePaste(beta);
    pair.handlePaste(alpha);
    assert.equal(pair.getText(), `${alpha}[paste #1 +12 lines]`);
    assert.equal(pair.getExpandedText(), `${alpha}${beta}`);
    const submitted = [];
    pair.onSubmit = (value) => submitted.push(value);
    pair.submitValue();
    assert.deepEqual(submitted, [`${alpha}${beta}`]);
  });

  test("a duplicated marker literal is not expanded", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?paste-expand=${Date.now()}`);
    const editor = makeEditor(Editor);
    const body = largePaste();
    editor.handlePaste(body);
    editor.insertTextAtCursorInternal(editor.getText());
    assert.equal(editor.getText(), "[paste #1 +12 lines][paste #1 +12 lines]");
    editor.handlePaste(body);
    assert.equal(editor.getText(), "[paste #1 +12 lines][paste #1 +12 lines][paste #2 +12 lines]");
    assert.deepEqual([...editor.getPasteState().pastes.keys()], [1, 2]);
    assert.equal(editor.getExpandedText(), "[paste #1 +12 lines][paste #1 +12 lines]" + body);
  });
}
