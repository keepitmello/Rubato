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
export { summaryCompactionAllowed } from "./extension.mjs";
export { COMPACTION_BRIEFING_GUIDANCE } from "./guidance.mjs";
export { contextMode, historyNotesEnabled, summaryModeActive } from "./notes-flag.mjs";
export { supportsAnthropicServerCompaction, ANTHROPIC_SERVER_COMPACTION_BETA } from "./anthropic-server-compaction.mjs";
export { applyAnthropicServerCompactionParams, applyAnthropicServerCompaction } from "./anthropic-server-compaction-wire.mjs";
export default createCompactionExtensionFactories;
