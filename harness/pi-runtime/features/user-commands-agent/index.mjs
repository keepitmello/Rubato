import { createGoalExtension } from "./goal/extension.mjs";
import { createLoopExtension } from "./loop/extension.mjs";
import { createBtwExtension } from "./btw/extension.mjs";

export const USER_COMMAND_FACTORY_NAMES = Object.freeze([
  "rubato-goal",
  "rubato-loop",
  "rubato-btw",
]);

/** Named factories for the three Senpi agent-side user commands.
 * Each name is independently toggleable via rubato-features.json / RUBATO_DISABLED_FEATURES.
 */
export function createUserCommandsAgentFactories(options = {}) {
  return [
    { name: "rubato-goal", factory: createGoalExtension(options) },
    { name: "rubato-loop", factory: createLoopExtension(options) },
    { name: "rubato-btw", factory: createBtwExtension(options) },
  ];
}

export { createGoalExtension } from "./goal/extension.mjs";
export { createLoopExtension } from "./loop/extension.mjs";
export { createBtwExtension } from "./btw/extension.mjs";
export default createUserCommandsAgentFactories;

