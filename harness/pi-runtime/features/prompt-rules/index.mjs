import { createInstructionExtension } from "./instructions.mjs";
import { createTodoExtension } from "./todo.mjs";

/**
 * Build stock-Pi extension factories from the canonical services created by the
 * parent runtime.  No process-global SettingsManager or Senpi import is used.
 */
export function createPromptRulesExtensionFactories({
  settingsManager,
  env = process.env,
  includeInstructions = true,
  includeTodo = true,
} = {}) {
  if (!settingsManager) {
    throw new TypeError("prompt-rules requires the parent SettingsManager");
  }
  const factories = [];
  if (includeInstructions) {
    factories.push({
      name: "rubato-prompt-rules",
      factory: createInstructionExtension({ settingsManager, env }),
    });
  }
  if (includeTodo) {
    factories.push({
      name: "rubato-todo",
      factory: createTodoExtension(),
    });
  }
  return factories;
}

export { createInstructionExtension } from "./instructions.mjs";
export { createTodoExtension, TODO_STATE_ENTRY_TYPE } from "./todo.mjs";

export default createPromptRulesExtensionFactories;
