import { createGoalExtension } from "./goal/extension.mjs";
import { createLoopExtension } from "./loop/extension.mjs";
import { createBtwExtension } from "./btw/extension.mjs";
import { createTtsrExtension } from "./ttsr/extension.mjs";
import { createModelFallbackExtension } from "./model-fallback/extension.mjs";
import { createImportReproExtension } from "./import-repro/extension.mjs";

export const USER_COMMAND_FACTORY_NAMES = Object.freeze([
  "rubato-goal",
  "rubato-loop",
  "rubato-btw",
  "rubato-ttsr",
  "rubato-model-fallback",
  "rubato-import-repro",
]);

/** Named factories for the six Senpi agent-side user commands.
 * Each name is independently toggleable via rubato-features.json / RUBATO_DISABLED_FEATURES.
 */
export function createUserCommandsAgentFactories(options = {}) {
  return [
    { name: "rubato-goal", factory: createGoalExtension(options) },
    { name: "rubato-loop", factory: createLoopExtension(options) },
    { name: "rubato-btw", factory: createBtwExtension(options) },
    { name: "rubato-ttsr", factory: createTtsrExtension(options) },
    { name: "rubato-model-fallback", factory: createModelFallbackExtension(options) },
    { name: "rubato-import-repro", factory: createImportReproExtension(options) },
  ];
}

export { createGoalExtension } from "./goal/extension.mjs";
export { createLoopExtension } from "./loop/extension.mjs";
export { createBtwExtension } from "./btw/extension.mjs";
export { createTtsrExtension } from "./ttsr/extension.mjs";
export { createModelFallbackExtension } from "./model-fallback/extension.mjs";
export { createImportReproExtension } from "./import-repro/extension.mjs";
export default createUserCommandsAgentFactories;

