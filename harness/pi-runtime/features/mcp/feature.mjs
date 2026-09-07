import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const OWNED_FILES = [
  "compat.mjs",
  "errors.mjs",
  "extension.mjs",
  "index.mjs",
  "output-guard.mjs",
  "service.mjs",
  "THIRD_PARTY_NOTICES.md",
];

export const mcpFeature = Object.freeze({
  id: "mcp",
  patches: Object.freeze([]),
  files: Object.freeze(
    OWNED_FILES.map((name) => Object.freeze({
      target: "runtime",
      version: VERSION,
      path: `rubato-features/mcp/${name}`,
      sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
    })),
  ),
});
