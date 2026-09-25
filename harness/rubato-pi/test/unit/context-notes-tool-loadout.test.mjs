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

// Notes tools stay out of the prefix: notes mode only makes them findable, tool_search
// activates one when the model asks, and summary mode takes them away again.
test("notes mode makes the notes tools searchable without activating them", () => {
  const definitions = CONTEXT_NOTES_TOOL_NAMES.map((name) => ({ name, exposure: "search", allowLazyActivation: false }));
  const pi = fakePi(["read", "bash", "tool_search"]);

  syncNotesToolActivation(pi, true, definitions);
  assert.deepEqual(pi.active, ["read", "bash", "tool_search"]);
  assert.equal(pi.writes.length, 0);
  assert.ok(pi.registered.every((definition) => definition.allowLazyActivation === true));
  assert.equal(pi.registered.length, CONTEXT_NOTES_TOOL_NAMES.length);

  pi.setActiveTools([...pi.active, "notes_write_file"]);
  syncNotesToolActivation(pi, false, definitions);
  assert.deepEqual(pi.active, ["read", "bash", "tool_search"]);
  assert.ok(definitions.every((definition) => definition.allowLazyActivation === false));
});
