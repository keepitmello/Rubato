import { createPromptPresetExtension } from "./extension.mjs";

export const PROMPT_PRESET_FACTORY_NAME = "rubato-prompt-preset";

/** Named stock-Pi factory. Uses the parent SettingsManager; never constructs another. */
export function createPromptPresetExtensionFactories({
  settingsManager,
  env = process.env,
} = {}) {
  if (!settingsManager) throw new TypeError("prompt-preset requires the parent SettingsManager");
  return [{
    name: PROMPT_PRESET_FACTORY_NAME,
    factory: createPromptPresetExtension({ settingsManager, env }),
  }];
}

export { createPromptPresetExtension } from "./extension.mjs";
export { resolvePreset, resolvePresetName } from "./presets.mjs";
export { loadPromptPresetSettings, parsePromptPreset } from "./settings.mjs";
export default createPromptPresetExtensionFactories;
