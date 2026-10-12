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

// 2026-10-12: the notes tools still declared search exposure, so tool_search pulled them
// back on every session_start. When the app reattached a session, the next request had no
// notes_write_file and no new_context, and the window could not be handed over.
test("tool_search's session_start leaves the notes tools on", async () => {
  const { createContextNotesTools } = await import("../../src/context-notes/tools.mjs");
  const { createToolSearchExtension } = await import("../../../pi-runtime/features/tool-search/index.mjs");
  const T = new Proxy({}, { get: () => (...args) => ({ args }) });
  const definitions = createContextNotesTools(() => null, T, () => true);
  const handlers = new Map();
  const registered = new Map(definitions.map((definition) => [definition.name, definition]));
  let active = ["read", "bash", "tool_search"];
  const pi = {
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (definition) => registered.set(definition.name, definition),
    registerLazyToolActivator: () => {},
    // The engine's catalog marks what a definition declared (tool-search/patches.mjs, catalog-metadata).
    getAllTools: () => [...registered.values()].map((definition) => ({
      ...definition,
      exposure: definition.exposure ?? "search",
      declaredExposure: definition.exposure === "search" ? "search" : "direct",
    })),
    getActiveTools: () => [...active],
    setActiveTools: (next) => { active = [...next]; },
  };
  createToolSearchExtension()(pi);

  syncNotesToolActivation(pi, true);
  for (const handler of handlers.get("session_start") ?? []) await handler({}, { sessionManager: { getEntries: () => [] } });

  for (const name of CONTEXT_NOTES_TOOL_NAMES) assert.ok(active.includes(name), `${name} stays active`);
});
