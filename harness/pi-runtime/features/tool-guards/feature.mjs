import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const OWNED_FILES = [
  "apply-patch.mjs",
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
