import assert from "node:assert/strict";
import { readPinnedVersions } from "../../src/launch.mjs";
import { PIN } from "../../src/policy.mjs";
import { pickNode, listNodeCandidates } from "../../src/select-node.mjs";

const pin = readPinnedVersions();
assert.deepEqual(pin, { engine: PIN.engine, senpi: PIN.senpi });
const node = pickNode(listNodeCandidates(undefined, [process.execPath]));
assert.ok(node && node.major >= 24, "Node 24+ required");
console.log(`local smoke ok pin=${pin.engine}+${pin.senpi} node=${node.text}`);
