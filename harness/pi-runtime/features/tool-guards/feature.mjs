import { fileURLToPath } from "node:url";

import { PI_VERSION as VERSION } from "../../pi-version.mjs";
const OWNED_FILES = [
  "apply-patch.mjs",
  "demote-unavailable.mjs",
  "index.mjs",
  "loop-guard.mjs",
  "patch-engine.mjs",
  "patch-format.mjs",
  "tool-pair.mjs",
  "THIRD_PARTY_NOTICES.md",
];

export const toolGuardsFeature = Object.freeze({
  id: "tool-guards",
  patches: Object.freeze([]),
  files: Object.freeze(OWNED_FILES.map((name) => Object.freeze({
    target: "runtime",
    version: VERSION,
    path: `rubato-features/tool-guards/${name}`,
    sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
  }))),
});
