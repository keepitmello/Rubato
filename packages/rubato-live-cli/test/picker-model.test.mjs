import test from "node:test";
import assert from "node:assert/strict";
import { createPickerScreen, loadPinnedPiTui, pickerItems } from "../src/picker.mjs";

const sessions = [{
  liveSessionId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
  title: "Research",
  cwd: "/work/project",
  lifecycle: "ready",
  model: { label: "Opus" },
}];
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("picker model is derived only from canonical LiveSessionSummary fields", () => {
  const items = pickerItems(sessions);
  assert.equal(items[0].value, "__rubato_new__");
  assert.deepEqual(items[1], {
    value: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
    label: "Research",
    description: "Opus · /work/project · ready",
  });
});

test("picker loads pinned pi-tui without importing the Rubato engine", async () => {
  const tui = await loadPinnedPiTui();
  assert.equal(typeof tui.SelectList, "function");
  assert.equal(typeof tui.TuiAltScreen, "function");
});

test("picker starts on New session and Right plus Enter attaches the selected session", async () => {
  const tui = await loadPinnedPiTui();
  const selections = [];
  const screen = createPickerScreen(sessions, tui, (selection) => selections.push(selection));
  assert.equal(screen.activePane, "new");
  screen.handleInput("\x1b[C");
  assert.equal(screen.activePane, "sessions");
  screen.handleInput("\r");
  assert.deepEqual(selections, [{ kind: "attach", liveSessionId: sessions[0].liveSessionId }]);
});

test("wide picker renders sessions in a right split and narrow picker stacks safely", async () => {
  const tui = await loadPinnedPiTui();
  const screen = createPickerScreen(sessions, tui, () => {});
  const wide = screen.render(100).map(stripAnsi).join("\n");
  const narrow = screen.render(50).map(stripAnsi).join("\n");
  assert.match(wide, /New session\s+│\s+Existing sessions/);
  assert.match(wide, /\s+│\s+Research/);
  assert.doesNotMatch(wide, /→ Research/);
  assert.doesNotMatch(narrow, /│/);
  assert.ok(narrow.indexOf("Research") > narrow.indexOf("New session"));
});

test("mouse click on a right-pane row enters that session", async () => {
  const tui = await loadPinnedPiTui();
  const selections = [];
  const screen = createPickerScreen(sessions, tui, (selection) => selections.push(selection));
  screen.render(100);
  assert.equal(screen.handleMouse({ button: 0, x: 40, y: 3, release: false }), true);
  assert.deepEqual(selections, [{ kind: "attach", liveSessionId: sessions[0].liveSessionId }]);
});

test("mouse click on New session starts a session", async () => {
  const tui = await loadPinnedPiTui();
  const selections = [];
  const screen = createPickerScreen(sessions, tui, (selection) => selections.push(selection));
  screen.render(100);
  assert.equal(screen.handleMouse({ button: 0, x: 5, y: 2, release: false }), true);
  assert.deepEqual(selections, [{ kind: "new" }]);
});
