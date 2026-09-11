import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const RUNTIME_FILES = Object.freeze([
  "index.mjs",
  "tui.mjs",
  "open-in-editor.mjs",
  "THIRD_PARTY_NOTICES.md",
  "history-search/index.mjs",
  "history-search/filter.mjs",
  "history-search/overlay.mjs",
  "history-search/catalog-index.mjs",
  "help/index.mjs",
  "help/panel.mjs",
  "help/markdown.mjs",
  "diff/index.mjs",
  "files/index.mjs",
  "redraws/index.mjs",
]);

export const patches = Object.freeze([]);
export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: "rubato-features/user-commands-session/" + name,
  sourcePath: fileURLToPath(new URL("./" + name, import.meta.url)),
})));

export const feature = Object.freeze({ id: "user-commands-session", patches, files });
export default feature;
