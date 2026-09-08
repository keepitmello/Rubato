import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const FILES = ["bash-timeout.mjs", "hooks.mjs", "index.mjs", "permission.mjs", "THIRD_PARTY_NOTICES.md"];

export const toolPolicyFeature = Object.freeze({
  id: "tool-policy",
  patches: Object.freeze([]),
  files: Object.freeze(FILES.map((name) => Object.freeze({
    target: "runtime",
    version: VERSION,
    path: `rubato-features/tool-policy/${name}`,
    sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
  }))),
});
