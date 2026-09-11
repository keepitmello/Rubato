const VALID_PRESETS = new Set([
  "auto",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "deepseek-v4-flash",
  "deepseek-v4-flash-0731",
  "deepseek-v4-pro",
  "glm-5.2",
  "glm-5.3",
  "grok-4.5",
  "grok-4.6",
  "kimi-k3",
  "kimi-k2-7",
  "kimi-k2-6",
  "gpt-5",
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6",
  "gpt-6-astra",
]);

export function parsePromptPreset(value) {
  if (value && VALID_PRESETS.has(value)) return value;
  return undefined;
}

export function loadPromptPresetSettings(settingsManager) {
  const globalSettings = settingsManager.getGlobalSettings?.() ?? {};
  const projectSettings = settingsManager.getProjectSettings?.() ?? {};
  return {
    promptPreset: parsePromptPreset(projectSettings.promptPreset)
      ?? parsePromptPreset(globalSettings.promptPreset)
      ?? "auto",
  };
}

export { VALID_PRESETS };
