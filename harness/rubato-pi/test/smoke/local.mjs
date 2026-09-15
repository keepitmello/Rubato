import assert from "node:assert/strict";
import { pickNode, listNodeCandidates } from "../../src/select-node.mjs";

const node = pickNode(listNodeCandidates(undefined, [process.execPath]));
assert.ok(node && node.major >= 24, "Node 24+ required");
console.log(`local smoke ok node=${node.text}`);
