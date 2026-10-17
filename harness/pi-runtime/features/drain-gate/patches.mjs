// A restart waits for running work instead of cutting it (gate.mjs). Every agent loop counts
// itself in and out, and waits at the gate right before it would send its next model request.
import { fileURLToPath } from "node:url";

import { PI_VERSION as VERSION } from "../../pi-version.mjs";

const PACKAGE_NAME = "@earendil-works/pi-agent-core";
const IMPORT_ANCHOR = 'import { getDefaultStreamFn } from "./stream-fn.js";\n';
const IMPORT = 'import { rubatoDrainGate } from "./rubato-features/drain-gate/gate.mjs";\n';
const LOOP_ANCHOR = "async function runLoop(initialContext, newMessages, initialConfig, signal, emit, streamFunction) {\n";
const REQUEST_ANCHOR = "            // Stream assistant response\n";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[drain-gate:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) throw new Error(`[drain-gate:${label}] expected anchor is ambiguous`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchAgentLoop(source) {
  if (source.includes("rubatoDrainGate")) throw new Error("[drain-gate:agent-loop] expected pristine feature seam");
  let next = replaceOnce(source, IMPORT_ANCHOR, IMPORT_ANCHOR + IMPORT, "import");
  next = replaceOnce(next, LOOP_ANCHOR, `async function runLoop(initialContext, newMessages, initialConfig, signal, emit, streamFunction) {
    // Rubato (drain-gate): a restart waits until every running loop stands at the gate.
    const leaveDrainGate = rubatoDrainGate.enter();
    try {
        return await runLoopThroughGate(initialContext, newMessages, initialConfig, signal, emit, streamFunction);
    }
    finally {
        leaveDrainGate();
    }
}
async function runLoopThroughGate(initialContext, newMessages, initialConfig, signal, emit, streamFunction) {
`, "loop");
  next = replaceOnce(next, REQUEST_ANCHOR, `            // Rubato (drain-gate): while a restart drains the engine, the next request waits
            // here. The abort that closes the session ends the run without a message, so the
            // session stops at the tool results above and the next engine continues from them.
            if (rubatoDrainGate.draining && await rubatoDrainGate.park(signal)) {
                await emit({ type: "agent_end", messages: newMessages });
                return;
            }
${REQUEST_ANCHOR}`, "request");
  return next;
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/rubato-features/drain-gate/gate.mjs",
    sourcePath: fileURLToPath(new URL("./gate.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  Object.freeze({
    id: "drain-gate:agent-loop",
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/agent-loop.js",
    preimageSha256: "65def8c7f3fa01e38fe05467520efc8673c22ea8197833a3b04b29c8a60cb1e3",
    apply: patchAgentLoop,
  }),
]);

export const feature = Object.freeze({ id: "drain-gate", patches, files });
export default feature;
