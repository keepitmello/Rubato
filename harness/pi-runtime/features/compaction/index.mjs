import { createCompactionExtension } from "./extension.mjs";

export const COMPACTION_FACTORY_NAME = "rubato-compaction";

export function createCompactionExtensionFactories({
  settingsManager,
  env = process.env,
  fetchImpl,
  now,
} = {}) {
  if (!settingsManager) throw new TypeError("compaction requires the parent SettingsManager");
  return [{
    name: COMPACTION_FACTORY_NAME,
    factory: createCompactionExtension({ settingsManager, env, fetchImpl, now }),
  }];
}

export { createCompactionExtension } from "./extension.mjs";
export { shouldRunIdleCompaction } from "./idle.mjs";
export { isTripped, recordFailure, recordSuccess } from "./circuit-breaker.mjs";
export { shouldTriggerCompaction } from "./policy.mjs";
export { isOpenAiRemoteCompactionModel } from "./openai-remote-model.mjs";
export default createCompactionExtensionFactories;
