import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const RUNTIME_FILES = Object.freeze([
  "index.mjs",
  "session-title.mjs",
  "extension.mjs",
]);

export const patches = Object.freeze([]);
export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/session-title/${name}`,
  sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
})));

export const sessionTitleFeature = Object.freeze({ id: "session-title", patches, files });
export const feature = sessionTitleFeature;
export default sessionTitleFeature;
