import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const RUNTIME_FILES = Object.freeze([
  "index.mjs",
  "extension.mjs",
  "policy.mjs",
  "idle.mjs",
  "circuit-breaker.mjs",
  "threshold.mjs",
  "openai-remote-model.mjs",
  "openai-remote.mjs",
  "relationship.md",
  "THIRD_PARTY_NOTICES.md",
]);

export const patches = Object.freeze([]);
export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/compaction/${name}`,
  sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
})));

export const compactionFeature = Object.freeze({ id: "compaction", patches, files });
export const feature = compactionFeature;
export default compactionFeature;
