import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const OWNED_FILES = ["index.mjs", "registry.mjs"];

export const mcpProducersFeature = Object.freeze({
  id: "mcp-producers",
  patches: Object.freeze([]),
  files: Object.freeze(
    OWNED_FILES.map((name) => Object.freeze({
      target: "runtime",
      version: VERSION,
      path: `rubato-features/mcp-producers/${name}`,
      sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
    })),
  ),
});
