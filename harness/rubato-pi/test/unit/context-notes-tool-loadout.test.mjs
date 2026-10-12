import assert from "node:assert/strict";
import test from "node:test";

import { CONTEXT_NOTES_TOOL_NAMES, syncNotesToolActivation } from "../../src/context-notes/tools.mjs";

function fakePi(active) {
  const writes = [];
  const registered = [];
  return {
    writes,
    registered,
    getActiveTools: () => [...active],
    setActiveTools(next) { writes.push(next); active = [...next]; },
    registerTool(definition) { registered.push(definition); },
    get active() { return active; },
  };
}

// Notes mode turns all eleven on from the start, in one fixed order; summary mode takes them
// away. A resync never moves a tool that is already active.
test("notes mode activates every notes tool up front, and summary mode removes them", () => {
  const pi = fakePi(["read", "bash", "tool_search"]);

  syncNotesToolActivation(pi, true);
  assert.deepEqual(pi.active, ["read", "bash", "tool_search", ...CONTEXT_NOTES_TOOL_NAMES]);

  syncNotesToolActivation(pi, true);
  assert.equal(pi.writes.length, 1, "an unchanged loadout is not written again");

  pi.setActiveTools([...pi.active, "eval"]);
  syncNotesToolActivation(pi, false);
  assert.deepEqual(pi.active, ["read", "bash", "tool_search", "eval"]);

  syncNotesToolActivation(pi, true);
  assert.deepEqual(pi.active, ["read", "bash", "tool_search", "eval", ...CONTEXT_NOTES_TOOL_NAMES]);
});

test("a resumed session that activated some notes tools gets the rest without moving them", () => {
  const pi = fakePi(["read", "notes_write_file", "bash"]);
  syncNotesToolActivation(pi, true);
  assert.deepEqual(pi.active.slice(0, 3), ["read", "notes_write_file", "bash"]);
  assert.deepEqual([...pi.active].sort(), ["bash", "read", ...CONTEXT_NOTES_TOOL_NAMES].sort());
});
