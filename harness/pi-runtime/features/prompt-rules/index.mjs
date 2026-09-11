import { createInstructionExtension } from "./instructions.mjs";
import { createTodoExtension } from "./todo.mjs";
import { createRolePromptExtensionFactories } from "./role-prompt.mjs";

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
  factories.push(...createRolePromptExtensionFactories({ env }));
  return factories;
}

export { createInstructionExtension } from "./instructions.mjs";
export { createTodoExtension, TODO_STATE_ENTRY_TYPE } from "./todo.mjs";
export { createRolePromptExtension, createRolePromptExtensionFactories, ROLE_PROMPT_FACTORY_NAME } from "./role-prompt.mjs";

export default createPromptRulesExtensionFactories;
