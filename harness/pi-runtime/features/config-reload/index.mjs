import { createConfigReloadExtension } from "./extension.mjs";

export const CONFIG_RELOAD_FACTORY_NAME = "rubato-config-reload";

export function createConfigReloadExtensionFactories({
  settingsManager,
  agentDir,
  cwd,
  requestReload,
  subscribe,
  debounceMs,
} = {}) {
  if (!settingsManager) throw new TypeError("config-reload requires the parent SettingsManager");
  if (!agentDir) throw new TypeError("config-reload requires agentDir");
  return [{
    name: CONFIG_RELOAD_FACTORY_NAME,
    factory: createConfigReloadExtension({
      settingsManager,
      agentDir,
      cwd,
      requestReload,
      subscribe,
      debounceMs,
    }),
  }];
}

export { createConfigReloadExtension } from "./extension.mjs";
export { excludeRoutineOnlySettingsChanges } from "./routine-settings.mjs";
export { excludeGeneratedExtensionShims } from "./shim-filter.mjs";
export default createConfigReloadExtensionFactories;
