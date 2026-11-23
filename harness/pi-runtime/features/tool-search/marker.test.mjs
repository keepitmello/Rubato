import assert from "node:assert/strict";
import test from "node:test";
import { emitActivationMarker, parseActivationMarkers, rehydrate } from "./marker.mjs";

test("each history message is searched for activation markers once, whatever the number of rehydrations", () => {
  let serialized = 0;
  const counted = (message) => ({ ...message, toJSON() { serialized += 1; const { toJSON: _toJSON, ...plain } = this; return plain; } });
  const activation = { name: "linear_search", registrationId: "mcp\0linear\0search" };
  const history = [
    counted({ role: "user", content: "find the issue" }),
    counted({ role: "toolResult", content: [{ type: "text", text: emitActivationMarker([activation]) }] }),
    counted({ role: "assistant", content: [{ type: "text", text: "done" }] }),
  ];
  const docs = new Map([[activation.name, { ...activation, source: "mcp", allowLazyActivation: true }]]);
  assert.deepEqual(rehydrate(history, docs), ["linear_search"]);
  assert.deepEqual(rehydrate(history, docs), ["linear_search"]);
  assert.deepEqual(parseActivationMarkers(history), [{ version: 2, activations: [activation] }]);
  assert.equal(serialized, history.length);
  history.push(counted({ role: "user", content: "next" }));
  rehydrate(history, docs);
  assert.equal(serialized, history.length, "only the new message is read");
});
