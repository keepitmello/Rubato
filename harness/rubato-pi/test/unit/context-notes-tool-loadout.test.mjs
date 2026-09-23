import assert from "node:assert/strict";
import test from "node:test";

import { CONTEXT_NOTES_TOOL_NAMES, syncNotesToolActivation } from "../../src/context-notes/tools.mjs";

function fakePi(active) {
  const writes = [];
  return {
    writes,
    getActiveTools: () => [...active],
    setActiveTools(next) { writes.push(next); active = [...next]; },
    get active() { return active; },
  };
}

// The tool list heads the cached prefix, so a resync may add or remove notes tools
// but must never move one that is already there.
test("notes mode activates every notes tool once and a resync never reorders", () => {
  const pi = fakePi(["read", "bash"]);
  syncNotesToolActivation(pi, true);
  assert.deepEqual(pi.active, ["read", "bash", ...CONTEXT_NOTES_TOOL_NAMES]);

  pi.setActiveTools([...pi.active, "tool_search"]);
  const before = [...pi.active];
  const writes = pi.writes.length;
  syncNotesToolActivation(pi, true);
  assert.deepEqual(pi.active, before);
  assert.equal(pi.writes.length, writes);

  syncNotesToolActivation(pi, false);
  assert.deepEqual(pi.active, ["read", "bash", "tool_search"]);
});
