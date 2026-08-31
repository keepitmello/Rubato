import test from "node:test";
import assert from "node:assert/strict";
import { loadPinnedPiTui, pickerItems } from "../src/picker.mjs";

test("picker model is derived only from canonical LiveSessionSummary fields", () => {
  const items = pickerItems([{
    liveSessionId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
    title: "Research",
    cwd: "/work/project",
    lifecycle: "ready",
    model: { label: "Opus" },
  }]);
  assert.deepEqual(items[0], {
    value: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
    label: "Research",
    description: "Opus · /work/project · ready",
  });
  assert.equal(items[1].value, "__rubato_new__");
});

test("picker loads pinned pi-tui without importing the Rubato engine", async () => {
  const tui = await loadPinnedPiTui();
  assert.equal(typeof tui.SelectList, "function");
  assert.equal(typeof tui.TuiAltScreen, "function");
});
