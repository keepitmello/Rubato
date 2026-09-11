import { fileURLToPath } from "node:url";

import { patches as compactionPatches } from "./patches.mjs";

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
  "notes-flag.mjs",
  "guidance.mjs",
  "anthropic-server-compaction.mjs",
  "anthropic-server-compaction-wire.mjs",
  "patches.mjs",
  "relationship.md",
  "THIRD_PARTY_NOTICES.md",
]);

const source = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const runtimeFile = (name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/compaction/${name}`,
  sourcePath: source(`./${name}`),
});
const packageFile = (packageName, path, relative) => Object.freeze({
  target: "package",
  packageName,
  version: VERSION,
  path,
  sourcePath: source(relative),
});

export const patches = compactionPatches;
export const files = Object.freeze([
  ...RUNTIME_FILES.map(runtimeFile),
  packageFile("@earendil-works/pi-coding-agent", "dist/rubato-features/compaction/threshold.mjs", "./threshold.mjs"),
  packageFile("@earendil-works/pi-coding-agent", "dist/rubato-features/compaction/guidance.mjs", "./guidance.mjs"),
  packageFile("@earendil-works/pi-ai", "dist/rubato-features/compaction/notes-flag.mjs", "./notes-flag.mjs"),
  packageFile("@earendil-works/pi-ai", "dist/rubato-features/compaction/guidance.mjs", "./guidance.mjs"),
  packageFile("@earendil-works/pi-ai", "dist/rubato-features/compaction/anthropic-server-compaction.mjs", "./anthropic-server-compaction.mjs"),
  packageFile("@earendil-works/pi-ai", "dist/rubato-features/compaction/anthropic-server-compaction-wire.mjs", "./anthropic-server-compaction-wire.mjs"),
]);

export const compactionFeature = Object.freeze({ id: "compaction", patches, files });
export const feature = compactionFeature;
export default compactionFeature;
