import { fileURLToPath } from "node:url";

const VERSION = "0.85.1";
const RUNTIME_FILES = Object.freeze([
  "index.mjs",
  "THIRD_PARTY_NOTICES.md",
  "goal/extension.mjs",
  "goal/command.mjs",
  "goal/store.mjs",
  "goal/prompt.mjs",
  "goal/format.mjs",
  "goal/todo-nag.mjs",
  "loop/extension.mjs",
  "loop/parse.mjs",
  "btw/extension.mjs",
  "btw/side-query.mjs",
  "ttsr/extension.mjs",
  "model-fallback/extension.mjs",
  "import-repro/extension.mjs",
]);

export const patches = Object.freeze([]);
export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/user-commands-agent/${name}`,
  sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
})));

export const userCommandsAgentFeature = Object.freeze({ id: "user-commands-agent", patches, files });
export const feature = userCommandsAgentFeature;
export default userCommandsAgentFeature;
