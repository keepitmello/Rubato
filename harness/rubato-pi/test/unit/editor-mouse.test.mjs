import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { senpiDir, senpiNested } from "../../src/engine-paths.mjs";
import { nodeChildEnv, resolveNodeExecutable } from "../helpers/node-executable.mjs";
import {
  injectEditorMouse,
  injectEditorMouseRouting,
  isEditorMouseModuleUrl,
  isEditorMouseTuiUrl,
} from "../../src/editor-mouse.mjs";

const tuiDist = senpiNested("@earendil-works/pi-tui/dist");
const editorPath = join(tuiDist, "components/editor.js");
const altScreenPath = join(tuiDist, "tui-alt-screen.js");
const customEditorPath = join(senpiDir, "dist/modes/interactive/components/custom-editor.js");
const nestedPrefix = "file:///repo/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-tui/dist/";
const hoistedPrefix = "file:///repo/node_modules/@earendil-works/pi-tui/dist/";
const registerHref = new URL("../../src/no-changelog-register.mjs", import.meta.url).href;
const thisFile = fileURLToPath(import.meta.url);
const runtime = process.env.RUBATO_EDITOR_MOUSE_RUNTIME === "1";

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

function makeTui(rows = 24) {
  return {
    terminal: { rows, columns: 80 },
    requestRender() {},
    getShowHardwareCursor() { return false; },
  };
}

function makeEditor(Editor, rows = 24, options) {
  const editor = new Editor(makeTui(rows), theme, options);
  editor.focused = true;
  return editor;
}

function makeCustomEditor(CustomEditor, rows = 24, options) {
  const editor = new CustomEditor(makeTui(rows), theme, { matches() { return false; } }, options);
  editor.focused = true;
  return editor;
}

function inverseOpenAtEnd(line) {
  let inverse = false;
  const re = /\x1b\[([0-9;]*)m/g;
  let match;
  while ((match = re.exec(line))) {
    const codes = match[1].length === 0 ? [0] : match[1].split(";").map(Number);
    if (codes.includes(0) || codes.includes(27)) inverse = false;
    else if (codes.includes(7)) inverse = true;
  }
  return inverse;
}

function stripAnsi(line) {
  return line.replace(/\x1b[_\]][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function inverseCells(line) {
  const cells = [];
  const re = /\x1b\[7m([\s\S]*?)\x1b\[27m/g;
  let match;
  while ((match = re.exec(line))) cells.push(stripAnsi(match[1]));
  return cells.join("");
}

function contentRow(lines) {
  return lines.find((line) => !/^─+$/.test(stripAnsi(line))) ?? "";
}

function pointer(editor, kind, x, y) {
  assert.equal(editor.handleMouse({ kind, x, y }), true);
}

function mouse(kind, x, y) {
  const button = kind === "press" ? 0 : kind === "drag" ? 35 : 0;
  return `\x1b[<${button};${x + 1};${y + 1}${kind === "release" ? "m" : "M"}`;
}

function findBox(node, component) {
  if (!node) return undefined;
  if (node.component === component) return node;
  for (const child of node.children ?? []) {
    const found = findBox(child, component);
    if (found) return found;
  }
  return undefined;
}

if (!runtime) {
  test("URL matching targets Senpi nested and hoisted editor/alt-screen modules", () => {
    assert.equal(isEditorMouseModuleUrl(`${nestedPrefix}components/editor.js`), true);
    assert.equal(isEditorMouseTuiUrl(`${nestedPrefix}tui-alt-screen.js`), true);
    assert.equal(isEditorMouseModuleUrl(`${hoistedPrefix}components/editor.js`), true);
    assert.equal(isEditorMouseTuiUrl(`${hoistedPrefix}tui-alt-screen.js`), true);
    assert.equal(isEditorMouseModuleUrl(`${hoistedPrefix}editor-component.js`), false);
    assert.equal(isEditorMouseTuiUrl(`${nestedPrefix}terminal.js`), false);
  });

  test("transforms are anchored, idempotent, and fail on pinned-source drift", () => {
    const editorSource = readFileSync(editorPath, "utf8");
    const altSource = readFileSync(altScreenPath, "utf8");
    const editorNext = injectEditorMouse(editorSource);
    const altNext = injectEditorMouseRouting(altSource);
    assert.notEqual(editorNext, editorSource);
    assert.notEqual(altNext, altSource);
    assert.equal(injectEditorMouse(editorNext), editorNext);
    assert.equal(injectEditorMouseRouting(altNext), altNext);
    assert.match(editorNext, /applyMouseSelectionHighlight/);
    assert.match(editorNext, /clearMouseSelection/);
    assert.match(altNext, /findFocusedMouseBox/);
    assert.throws(() => injectEditorMouse(editorSource.replace("this.snappedFromCursorCol = null;", "this.snappedFromCursorCol = undefined;")), /transform drift: editor state/);
    assert.throws(() => injectEditorMouseRouting(altSource.replace("this.handleSelectionMouseEvent(mouseEvent);", "this.handleSelectionMouseEvent(event);")), /transform drift: mouse routing call/);
  });

  test("transformed editor and TUI run through an explicit child import without inherited NODE_OPTIONS", () => {
    const result = spawnSync(resolveNodeExecutable(), ["--import", registerHref, "--test", thisFile], {
      env: nodeChildEnv({ RUBATO_EDITOR_MOUSE_RUNTIME: "1" }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  });
} else {
  test("child import has a clean NODE_OPTIONS and a transformed Editor", async () => {
    assert.equal(process.env.NODE_OPTIONS ?? "", "");
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?mouse=${Date.now()}`);
    assert.equal(typeof Editor.prototype.handleMouse, "function");
    assert.equal(typeof Editor.prototype.getMouseSelection, "function");
  });

  test("loader-transformed editor supports caret, visible selection, delete, replace, wrapping, and scrolling", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?mouse=${Date.now()}`);

    const click = makeEditor(Editor);
    click.setText("hello world");
    click.render(20);
    pointer(click, "press", 6, 1);
    pointer(click, "release", 6, 1);
    click.handleInput("X");
    assert.equal(click.getText(), "hello Xworld");

    const forward = makeEditor(Editor);
    forward.setText("hello world");
    forward.render(20);
    pointer(forward, "press", 2, 1);
    pointer(forward, "drag", 7, 1);
    pointer(forward, "release", 7, 1);
    assert.match(forward.render(20).join("\n"), /\x1b\[27m/);
    forward.handleInput("\x7f");
    assert.equal(forward.getText(), "heorld");
    assert.equal(forward.getMouseSelection(), undefined);

    const backward = makeEditor(Editor);
    backward.setText("hello world");
    backward.render(20);
    pointer(backward, "press", 8, 1);
    pointer(backward, "drag", 3, 1);
    pointer(backward, "release", 3, 1);
    backward.handleInput("XY");
    assert.equal(backward.getText(), "helXYrld");

    const wrapped = makeEditor(Editor);
    wrapped.setText("abcdefghijklmno");
    wrapped.render(8);
    pointer(wrapped, "press", 2, 2);
    pointer(wrapped, "release", 2, 2);
    wrapped.handleInput("X");
    assert.equal(wrapped.getText(), "abcdefghiXjklmno");

    const scrolled = makeEditor(Editor, 10);
    scrolled.setText("a\nb\nc\nd\ne\nf\ng");
    scrolled.render(8);
    pointer(scrolled, "press", 1, 1);
    pointer(scrolled, "release", 1, 1);
    scrolled.handleInput("X");
    assert.equal(scrolled.getText(), "a\nb\ncX\nd\ne\nf\ng");
  });

  test("selection clears on keyboard movement, submit, and setText", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?mouse=${Date.now()}`);
    const editor = makeEditor(Editor);
    editor.setText("hello world");
    editor.render(20);
    pointer(editor, "press", 2, 1);
    pointer(editor, "drag", 7, 1);
    pointer(editor, "release", 7, 1);
    assert.ok(editor.getMouseSelection());

    editor.handleInput("\x1b[D");
    assert.equal(editor.getMouseSelection(), undefined);
    assert.equal(editor.getText(), "hello world");

    pointer(editor, "press", 2, 1);
    pointer(editor, "drag", 7, 1);
    pointer(editor, "release", 7, 1);
    editor.setText("reset");
    assert.equal(editor.getMouseSelection(), undefined);
    editor.handleInput("\x7f");
    assert.equal(editor.getText(), "rese");

    editor.setText("hello world");
    editor.render(20);
    pointer(editor, "press", 2, 1);
    pointer(editor, "drag", 7, 1);
    pointer(editor, "release", 7, 1);
    const submitted = [];
    editor.onSubmit = (value) => submitted.push(value);
    editor.handleInput("\r");
    assert.equal(editor.getMouseSelection(), undefined);
    assert.equal(editor.getText(), "");
    assert.deepEqual(submitted, ["hello world"]);
  });

  test("Enter, paste, and word/line deletes replace the selection", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?mouse=${Date.now()}`);

    const newline = makeEditor(Editor);
    newline.setText("hello world");
    newline.render(20);
    pointer(newline, "press", 2, 1);
    pointer(newline, "drag", 8, 1);
    pointer(newline, "release", 8, 1);
    newline.addNewLine();
    assert.equal(newline.getText(), "he\nrld");
    assert.equal(newline.getMouseSelection(), undefined);

    const paste = makeEditor(Editor);
    paste.setText("hello world");
    paste.render(20);
    pointer(paste, "press", 2, 1);
    pointer(paste, "drag", 8, 1);
    pointer(paste, "release", 8, 1);
    paste.handleInput("\x1b[200~XY\x1b[201~");
    assert.equal(paste.getText(), "heXYrld");
    assert.equal(paste.getMouseSelection(), undefined);

    const word = makeEditor(Editor);
    word.setText("hello world");
    word.render(20);
    pointer(word, "press", 2, 1);
    pointer(word, "drag", 8, 1);
    pointer(word, "release", 8, 1);
    word.handleInput("\x17");
    assert.equal(word.getText(), "herld");
    assert.equal(word.getMouseSelection(), undefined);

    const line = makeEditor(Editor);
    line.setText("hello world");
    line.render(20);
    pointer(line, "press", 2, 1);
    pointer(line, "drag", 8, 1);
    pointer(line, "release", 8, 1);
    line.handleInput("\x0b");
    assert.equal(line.getText(), "herld");
    assert.equal(line.getMouseSelection(), undefined);
  });

  test("fullscreen layout hit-tests editor bounds and falls back outside", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?mouse=${Date.now()}`);
    const { TuiAltScreen } = await import(`${pathToFileURL(altScreenPath).href}?mouse=${Date.now()}`);
    const { VStack } = await import(pathToFileURL(join(tuiDist, "components/v-stack.js")).href);
    const { Text } = await import(pathToFileURL(join(tuiDist, "components/text.js")).href);

    const terminal = {
      rows: 20,
      columns: 40,
      write() {}, hideCursor() {}, showCursor() {}, start() {}, stop() {}, onData() {}, onResize() {},
    };
    const tui = new TuiAltScreen(terminal, false);
    const editor = new Editor(tui, theme);
    editor.setText("hello world");
    const transcript = new Text("transcript line\n".repeat(8), 0, 0);
    tui.setLayoutRoot(new VStack([
      { component: transcript, grow: 1 },
      { component: editor },
    ]));
    tui.focusedComponent = editor;
    tui.altScreenActive = true;
    tui.doRender();
    const box = findBox(tui.currentLayout?.root, editor);
    assert.ok(box, "editor must occupy a layout box");
    assert.ok(box.rect.y > 0, "fullscreen editor sits below the transcript");

    const events = [];
    const original = editor.handleMouse.bind(editor);
    editor.handleMouse = (event) => {
      events.push(event);
      return original(event);
    };

    tui.handleViewportInput(mouse("press", 1, 1));
    tui.handleViewportInput(mouse("release", 1, 1));
    assert.deepEqual(events, []);
    assert.equal(editor.getMouseSelection(), undefined);
    assert.equal(tui.selectionPressActive || tui.getSelectionBounds() !== undefined || tui.selectionAnchor !== undefined, true);

    events.length = 0;
    const localX = 6;
    const localY = 1;
    tui.handleViewportInput(mouse("press", box.rect.x + localX, box.rect.y + localY));
    tui.handleViewportInput(mouse("release", box.rect.x + localX, box.rect.y + localY));
    assert.deepEqual(events.map(({ kind, x, y }) => ({ kind, x, y })), [
      { kind: "press", x: localX, y: localY },
      { kind: "release", x: localX, y: localY },
    ]);
    editor.handleInput("X");
    assert.equal(editor.getText(), "hello Xworld");
  });

  test("loader-transformed alt-screen routes editor mouse events and preserves wheel routing", async () => {
    const { TuiAltScreen } = await import(`${pathToFileURL(altScreenPath).href}?mouse=${Date.now()}`);
    const terminal = {
      rows: 20,
      columns: 40,
      write() {}, hideCursor() {}, showCursor() {}, start() {}, stop() {}, onData() {}, onResize() {},
    };
    const tui = new TuiAltScreen(terminal, false);
    const events = [];
    tui.focusedComponent = { focused: true, handleInput() {}, handleMouse(event) { events.push(event); return true; } };
    tui.currentLayout = {
      root: {
        component: tui.focusedComponent,
        rect: { x: 0, y: 10, width: 40, height: 8 },
        clip: { x: 0, y: 10, width: 40, height: 8 },
        children: [],
      },
    };
    tui.previousScreen = ["", "editor"];
    tui.handleViewportInput(mouse("press", 3, 11));
    tui.handleViewportInput(mouse("drag", 6, 11));
    tui.handleViewportInput(mouse("release", 6, 11));
    assert.deepEqual(events, [
      { kind: "press", x: 3, y: 1 },
      { kind: "drag", x: 6, y: 1 },
      { kind: "release", x: 6, y: 1 },
    ]);

    tui.focusedComponent.mouseSelectionActive = true;
    tui.handleViewportInput(mouse("drag", 6, 1));
    assert.deepEqual(events.at(-1), { kind: "drag", x: 6, y: -9 });

    events.length = 0;
    tui.handleViewportInput(mouse("press", 3, 1));
    assert.deepEqual(events, []);

    const wheelDeltas = [];
    tui.getPrimaryScrollView().scrollBy = (delta) => { wheelDeltas.push(delta); return 0; };
    tui.handleViewportInput("\x1b[<64;4;2M");
    assert.deepEqual(wheelDeltas, [-1]);
  });

  // Interactive mode never puts the editor straight into the layout: it wraps it in a
  // Container (interactive-mode.js `this.editorContainer.addChild(this.editor)`).
  // A Container renders its children itself, so the layout tree ends at the container
  // with no children and the focused editor is not a layout node. When the hit-test
  // stopped there, drags fell through to the alt-screen clipboard selection: the
  // highlight appeared but Backspace still deleted a single character.
  test("editor wrapped in a Container is still hit-tested and Backspace clears the selection", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?mouse=${Date.now()}`);
    const { TuiAltScreen } = await import(`${pathToFileURL(altScreenPath).href}?mouse=${Date.now()}`);
    const { Container } = await import(pathToFileURL(join(tuiDist, "tui.js")).href);
    const { VStack } = await import(pathToFileURL(join(tuiDist, "components/v-stack.js")).href);
    const { Text } = await import(pathToFileURL(join(tuiDist, "components/text.js")).href);

    const terminal = {
      rows: 20,
      columns: 60,
      write() {}, hideCursor() {}, showCursor() {}, start() {}, stop() {}, onData() {}, onResize() {},
    };
    const tui = new TuiAltScreen(terminal, false);
    const editor = new Editor(tui, theme);
    editor.setText("hello world");

    const editorContainer = new Container();
    editorContainer.addChild(editor);
    tui.setLayoutRoot(new VStack([
      { component: new Text("transcript line\n".repeat(8), 0, 0), grow: 1 },
      { component: editorContainer },
    ]));
    tui.focusedComponent = editor;
    tui.altScreenActive = true;
    tui.doRender();

    assert.equal(findBox(tui.currentLayout?.root, editor), undefined, "the editor is not its own layout node");
    const box = tui.findFocusedMouseBox(editor);
    assert.ok(box, "the container's box stands in for the focused editor");
    assert.equal(box.component, editorContainer);

    const px = editor.paddingX;
    tui.handleViewportInput(mouse("press", box.rect.x + px, box.rect.y + 1));
    tui.handleViewportInput(mouse("drag", box.rect.x + px + 5, box.rect.y + 1));
    tui.handleViewportInput(mouse("release", box.rect.x + px + 5, box.rect.y + 1));

    assert.deepEqual(editor.getMouseSelection(), {
      start: { line: 0, col: 0 },
      end: { line: 0, col: 5 },
    });
    assert.equal(tui.getSelectionBounds(), undefined, "the drag must not leak into clipboard selection");

    editor.handleInput("\x7f");
    assert.equal(editor.getText(), " world");
    assert.equal(editor.getMouseSelection(), undefined);
  });

  // The wrapper box may only stand in for the editor when the editor is the container's
  // only child. With a sibling above it, the container's origin is several rows higher
  // than the editor's, and handleMouse would map a click to the wrong line. Falling back
  // to clipboard selection is the correct outcome there.
  test("a container with a sibling above the editor is not claimed", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?mouse=${Date.now()}`);
    const { TuiAltScreen } = await import(`${pathToFileURL(altScreenPath).href}?mouse=${Date.now()}`);
    const { Container } = await import(pathToFileURL(join(tuiDist, "tui.js")).href);
    const { VStack } = await import(pathToFileURL(join(tuiDist, "components/v-stack.js")).href);
    const { Text } = await import(pathToFileURL(join(tuiDist, "components/text.js")).href);

    const terminal = {
      rows: 24,
      columns: 60,
      write() {}, hideCursor() {}, showCursor() {}, start() {}, stop() {}, onData() {}, onResize() {},
    };
    const tui = new TuiAltScreen(terminal, false);
    const editor = new Editor(tui, theme);
    editor.setText("AAAA\nBBBB\nCCCC");

    const container = new Container();
    container.addChild(new Text("BANNER\n", 0, 0));
    container.addChild(editor);
    tui.setLayoutRoot(new VStack([
      { component: new Text("t\n".repeat(4), 0, 0), grow: 1 },
      { component: container },
    ]));
    tui.focusedComponent = editor;
    tui.altScreenActive = true;
    tui.doRender();

    assert.equal(tui.findFocusedMouseBox(editor), undefined, "a multi-child wrapper must not stand in for the editor");

    const box = tui.currentLayout.root.children.at(-1);
    tui.handleViewportInput(mouse("press", box.rect.x + editor.paddingX, box.rect.y + 3));
    tui.handleViewportInput(mouse("drag", box.rect.x + editor.paddingX + 2, box.rect.y + 3));
    assert.equal(editor.getMouseSelection(), undefined, "the editor must not claim a skewed drag");
    assert.notEqual(tui.selectionAnchor, undefined, "the drag falls back to clipboard selection");
  });

  // The single-child wrapper is claimed, and its box origin is the editor's origin, so a
  // click on the row that renders a given line selects that same line.
  test("wrapper box origin matches the editor so clicks land on the rendered line", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?mouse=${Date.now()}`);
    const { TuiAltScreen } = await import(`${pathToFileURL(altScreenPath).href}?mouse=${Date.now()}`);
    const { Container } = await import(pathToFileURL(join(tuiDist, "tui.js")).href);
    const { VStack } = await import(pathToFileURL(join(tuiDist, "components/v-stack.js")).href);
    const { Text } = await import(pathToFileURL(join(tuiDist, "components/text.js")).href);

    const terminal = {
      rows: 24,
      columns: 60,
      write() {}, hideCursor() {}, showCursor() {}, start() {}, stop() {}, onData() {}, onResize() {},
    };
    const tui = new TuiAltScreen(terminal, false);
    const editor = new Editor(tui, theme);
    editor.setText("AAAA\nBBBB\nCCCC");

    const container = new Container();
    container.addChild(editor);
    tui.setLayoutRoot(new VStack([
      { component: new Text("t\n".repeat(4), 0, 0), grow: 1 },
      { component: container },
    ]));
    tui.focusedComponent = editor;
    tui.altScreenActive = true;
    tui.doRender();

    const box = tui.findFocusedMouseBox(editor);
    assert.equal(box?.component, container);

    const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
    const rendered = container.render(60).map(plain);
    const rowOfBBBB = rendered.findIndex((line) => line.includes("BBBB"));
    assert.ok(rowOfBBBB > 0, "the editor renders BBBB inside the wrapper");

    tui.handleViewportInput(mouse("press", box.rect.x + editor.paddingX, box.rect.y + rowOfBBBB));
    tui.handleViewportInput(mouse("drag", box.rect.x + editor.paddingX + 2, box.rect.y + rowOfBBBB));
    tui.handleViewportInput(mouse("release", box.rect.x + editor.paddingX + 2, box.rect.y + rowOfBBBB));
    assert.deepEqual(editor.getMouseSelection(), {
      start: { line: 1, col: 0 },
      end: { line: 1, col: 2 },
    });

    editor.handleInput("\x7f");
    assert.equal(editor.getText(), "AAAA\nBB\nCCCC");
  });

  test("CustomEditor row-1 click selects the cells after the prompt, not paddingX again", async () => {
    const { CustomEditor } = await import(`${pathToFileURL(customEditorPath).href}?mouse=${Date.now()}`);
    const editor = makeCustomEditor(CustomEditor);
    editor.setText("hello world");
    editor.render(20);
    pointer(editor, "press", 2, 1);
    pointer(editor, "drag", 7, 1);
    pointer(editor, "release", 7, 1);
    assert.deepEqual(editor.getMouseSelection(), {
      start: { line: 0, col: 0 },
      end: { line: 0, col: 5 },
    });
    const row = contentRow(editor.render(20));
    assert.equal(stripAnsi(row).startsWith("❯ hello world"), true);
    assert.equal(inverseCells(row), "hello");
  });

  test("CustomEditor CJK highlight covers the contiguous wide cells the pointer covered", async () => {
    const { CustomEditor } = await import(`${pathToFileURL(customEditorPath).href}?mouse=${Date.now()}`);
    const editor = makeCustomEditor(CustomEditor);
    editor.setText("한글가나다 abc");
    editor.render(24);
    pointer(editor, "press", 2, 1);
    pointer(editor, "drag", 8, 1);
    pointer(editor, "release", 8, 1);
    assert.deepEqual(editor.getMouseSelection(), {
      start: { line: 0, col: 0 },
      end: { line: 0, col: 3 },
    });
    const row = contentRow(editor.render(24));
    assert.match(stripAnsi(row), /한글가나다 abc/);
    assert.equal(inverseCells(row), "한글가");
  });

  test("CustomEditor wrapped-row selection keeps the literal padding and paints those cells", async () => {
    const { CustomEditor } = await import(`${pathToFileURL(customEditorPath).href}?mouse=${Date.now()}`);
    const editor = makeCustomEditor(CustomEditor);
    editor.setText("한글가나다라마바사아자차");
    const lines = editor.render(12);
    assert.equal(stripAnsi(lines[1]).startsWith("❯ 한글가나"), true);
    assert.equal(stripAnsi(lines[2]).startsWith("  다라마바"), true);
    pointer(editor, "press", 2, 2);
    pointer(editor, "drag", 8, 2);
    pointer(editor, "release", 8, 2);
    assert.deepEqual(editor.getMouseSelection(), {
      start: { line: 0, col: 4 },
      end: { line: 0, col: 7 },
    });
    const painted = editor.render(12);
    assert.equal(inverseCells(painted[2]), "다라마");
    assert.equal(inverseCells(painted[1]), "");
    assert.match(stripAnsi(painted[2]), /다라마바/);
  });

  test("CustomEditor configured padding > 2 still hit-tests row 1 at the visible ❯ gutter", async () => {
    const { CustomEditor } = await import(`${pathToFileURL(customEditorPath).href}?mouse=${Date.now()}`);
    const editor = makeCustomEditor(CustomEditor, 24, { paddingX: 4 });
    editor.setText("hello world");
    const first = editor.render(24);
    assert.equal(stripAnsi(first[1]).startsWith("❯ hello world"), true);
    assert.equal(editor.paddingX, 4);
    assert.equal(editor.getPaddingX(), 4);
    pointer(editor, "press", 2, 1);
    pointer(editor, "drag", 7, 1);
    pointer(editor, "release", 7, 1);
    assert.deepEqual(editor.getMouseSelection(), {
      start: { line: 0, col: 0 },
      end: { line: 0, col: 5 },
    });
    assert.equal(inverseCells(contentRow(editor.render(24))), "hello");

    editor.setText("abcdefghijklmnopqr");
    const wrapped = editor.render(24);
    assert.equal(stripAnsi(wrapped[2]).startsWith("    qr"), true);
    pointer(editor, "press", 4, 2);
    pointer(editor, "drag", 6, 2);
    pointer(editor, "release", 6, 2);
    assert.deepEqual(editor.getMouseSelection(), {
      start: { line: 0, col: 16 },
      end: { line: 0, col: 18 },
    });
    assert.equal(inverseCells(editor.render(24)[2]), "qr");
  });

  test("selection paint does not swallow the fake cursor reset", async () => {
    const { Editor } = await import(`${pathToFileURL(editorPath).href}?mouse=${Date.now()}`);
    const editor = makeEditor(Editor);
    editor.setText("abc\nxyz");
    editor.render(20);
    pointer(editor, "press", 0, 1);
    pointer(editor, "drag", 3, 2);
    pointer(editor, "release", 3, 2);
    assert.deepEqual(editor.getMouseSelection(), {
      start: { line: 0, col: 0 },
      end: { line: 1, col: 3 },
    });
    const painted = editor.render(20);
    assert.equal(inverseCells(painted[1]), "abc");
    assert.match(stripAnsi(painted[1]), /abc/);
    assert.match(stripAnsi(painted[2]), /xyz/);
    assert.equal(inverseOpenAtEnd(painted[2]), false, painted[2]);
    assert.match(painted[2], /\x1b\[(?:0|27)m/);
  });
}
