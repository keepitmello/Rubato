import test from "node:test";
import assert from "node:assert/strict";
import { createPickerScreen, loadPinnedPiTui, pickerItems, renderPickerStars } from "../src/picker.mjs";

const sessions = [{
  liveSessionId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
  title: "Research",
  cwd: "/work/project",
  lifecycle: "ready",
  model: { label: "Opus" },
}];
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("background stars twinkle without painting over the selection panel", () => {
  const options = { width: 119, height: 39, left: 16, top: 10, panelWidth: 86, panelHeight: 8 };
  const panel = Array.from({ length: 18 }, (_, y) => y < 10 ? "" : "menu".padEnd(86));
  const first = renderPickerStars(panel, { ...options, time: 0 }).map(stripAnsi);
  const later = renderPickerStars(panel, { ...options, time: 2300 }).map(stripAnsi);
  assert.notDeepEqual(first, later);
  assert(first.some((line) => /[·⠂✦]/u.test(line)));
  for (let y = 10; y < 18; y++) {
    assert.equal(first[y].slice(16, 102), panel[y]);
    assert.equal(later[y].slice(16, 102), panel[y]);
  }
  assert(first.every((line) => [...line].length === 119));
});

test("picker animation has one timer and stops before handoff", async (t) => {
  const api = await loadPinnedPiTui();
  t.mock.timers.enable({ apis: ["setInterval"] });
  let frames = 0;
  const screen = createPickerScreen(sessions, api, () => {}, () => frames++);
  t.after(() => screen.dispose());
  screen.startAnimation();
  screen.startAnimation();
  t.mock.timers.tick(120);
  assert.equal(frames, 1);
  screen.dispose();
  t.mock.timers.tick(120);
  assert.equal(frames, 1);
});

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
  const rows = screen.render(100).map(stripAnsi);
  const y = rows.findIndex((row) => row.includes("Research"));
  const x = rows[y].indexOf("Research");
  assert.equal(screen.handleMouse({ button: 0, x, y, release: false }), true);
  assert.deepEqual(selections, [{ kind: "attach", liveSessionId: sessions[0].liveSessionId }]);
});

test("mouse click on New session starts a session", async () => {
  const tui = await loadPinnedPiTui();
  const selections = [];
  const screen = createPickerScreen(sessions, tui, (selection) => selections.push(selection));
  const rows = screen.render(100).map(stripAnsi);
  const y = rows.findIndex((row) => row.includes("New session"));
  const x = rows[y].indexOf("New session");
  assert.equal(screen.handleMouse({ button: 0, x, y, release: false }), true);
  assert.deepEqual(selections, [{ kind: "new" }]);
});

test("picker screen is a TUI child that can be invalidated on startup", async () => {
  const tuiApi = await loadPinnedPiTui();
  const screen = createPickerScreen(sessions, tuiApi, () => {});
  const terminal = {
    start() {},
    stop() {},
    write() {},
    get columns() { return 80; },
    get rows() { return 24; },
  };
  const tui = new tuiApi.TuiAltScreen(terminal, false, undefined, { mouse: true });
  tui.addChild(screen);
  tui.setFocus(screen);
  assert.doesNotThrow(() => tui.invalidate());
});

test("picker handoff stop does not dump the picker onto the next renderer", async () => {
  const tuiApi = await loadPinnedPiTui();
  const writes = [];
  const terminal = {
    start() {},
    stop() {},
    write(data) { writes.push(String(data)); },
    showCursor() {},
    hideCursor() {},
    get columns() { return 80; },
    get rows() { return 24; },
  };
  const tui = new tuiApi.TuiAltScreen(terminal, false, undefined, { mouse: true });
  tui.addChild(createPickerScreen(sessions, tuiApi, () => {}));
  tui.setFocus(tui.children[0]);
  tui.start();
  tui.stop({ preserveScreen: true });
  assert.doesNotMatch(writes.join(""), /Existing sessions|New session/);
});

test("picker is centered from its first frame and recomputes both axes on resize", async () => {
  const api = await loadPinnedPiTui();
  let height = 40;
  const screen = createPickerScreen(sessions, api, () => {}, () => {}, () => height);
  const wide = screen.render(140);
  const first = wide.findIndex((line) => line.includes("𝒓𝒖𝒃𝒂𝒕𝒐"));
  assert(first > 5);
  assert(stripAnsi(wide[first]).startsWith(" ".repeat(27)));
  assert(wide.every((line) => api.visibleWidth(line) <= 140));
  height = 12;
  const narrow = screen.render(30);
  assert(narrow.length <= height);
  assert(narrow.every((line) => api.visibleWidth(line) <= 30));
  assert(narrow.some((line) => line.includes("Research")));
});

test("centered picker ignores margin clicks and maps scrolled rows to actual sessions", async () => {
  const api = await loadPinnedPiTui();
  const many = Array.from({ length: 30 }, (_, i) => ({ ...sessions[0], liveSessionId: `id-${i}`, title: `Session ${i}` }));
  const selected = [];
  const screen = createPickerScreen(many, api, (value) => selected.push(value), () => {}, () => 24);
  screen.handleInput("\x1b[C");
  for (let i = 0; i < 20; i++) screen.handleInput("\x1b[B");
  const lines = screen.render(140).map(stripAnsi);
  assert.equal(screen.handleMouse({ button: 0, x: 0, y: 0 }), false);
  const y = lines.findIndex((line) => /Session 20\b/.test(line));
  assert(y >= 0);
  assert(screen.handleMouse({ button: 0, x: lines[y].indexOf("Session 20"), y }));
  assert.equal(selected[0].liveSessionId, "id-20");
});
