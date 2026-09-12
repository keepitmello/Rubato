import { loadPromptPresetSettings } from "./settings.mjs";
import { resolvePreset, resolvePresetName } from "./presets.mjs";
import { presetMarker } from "./tunings.mjs";

function eventOptionsToBuilderInput(event, ctx) {
  const options = event.systemPromptOptions ?? {};
  return {
    cwd: options.cwd ?? ctx.cwd,
    selectedTools: options.selectedTools,
    toolSnippets: options.toolSnippets,
    promptGuidelines: options.promptGuidelines,
    contextFiles: options.contextFiles,
    skills: options.skills,
  };
}

/** Stock 0.85.1 maps --system-prompt / loader systemPrompt onto customPrompt. */
export function hasUserSystemPrompt(options) {
  return Boolean(options?.customPrompt);
}

function withUserAppends(presetPrompt, options) {
  const append = options?.appendSystemPrompt;
  if (!append) return presetPrompt;
  if (presetPrompt.includes(append)) return presetPrompt;
  return `${presetPrompt}\n\n${append}`;
}

export function applyPresetBody(event, preset) {
  const marker = presetMarker(preset.name);
  const existing = event.systemPrompt ?? "";
  if (existing.includes(marker)) return existing;
  const body = withUserAppends(preset.prompt, event.systemPromptOptions);
  return `${marker}\n${body}\n\n${existing}`;
}

function refreshHeader(ctx, settingsManager, event) {
  const model = event?.model ?? ctx.model;
  const options = event?.systemPromptOptions ?? ctx.getSystemPromptOptions?.();
  if (!model || hasUserSystemPrompt(options) || typeof ctx.ui?.setHeader !== "function") {
    ctx.ui?.setHeader?.(undefined);
    return;
  }
  const presetName = resolvePresetName(model, loadPromptPresetSettings(settingsManager));
  if (!presetName) {
    ctx.ui.setHeader(undefined);
    return;
  }
  ctx.ui.setHeader((_tui, theme) => ({
    render: () => [theme.fg("accent", theme.bold(`Optimized system prompt applied: ${presetName}`))],
    invalidate: () => {},
  }));
}

/**
 * Public hook: stock 0.85.1 consumes before_agent_start.systemPrompt.
 * model_select return is ignored by stock; the next before_agent_start applies the new model.
 * An explicit customPrompt (completed role prompt / --system-prompt) outranks the preset body.
 */
export function createPromptPresetExtension({ settingsManager } = {}) {
  if (!settingsManager) throw new TypeError("prompt-preset requires the parent SettingsManager");
  return (pi) => {
    pi.on("before_agent_start", async (event, ctx) => {
      const model = ctx.model;
      if (!model) return undefined;
      if (hasUserSystemPrompt(event.systemPromptOptions)) return undefined;
      const preset = resolvePreset(model, loadPromptPresetSettings(settingsManager), eventOptionsToBuilderInput(event, ctx));
      if (!preset) return undefined;
      return { systemPrompt: applyPresetBody(event, preset) };
    });
    pi.on("session_start", async (_event, ctx) => {
      refreshHeader(ctx, settingsManager);
    });
    pi.on("model_select", async (event, ctx) => {
      refreshHeader(ctx, settingsManager, event);
    });
  };
}

export default createPromptPresetExtension;
