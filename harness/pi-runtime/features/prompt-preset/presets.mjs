import { parsePromptPreset } from "./settings.mjs";
import { buildPresetTuning } from "./tunings.mjs";

function normalizeModelId(modelId) {
    return modelId.toLowerCase().replace(/\s+/g, "-");
}
// GPT-6 Astra id shapes verified against the OpenAI model page, codex's
// models.json, and Bedrock's catalog (2026-09-04): gpt-6-astra, gpt-6-astra-fast,
// dated snapshots, openai/gpt-6-astra, openai.gpt-6-astra, global.openai.gpt-6-astra,
// and the display name "GPT-6 Astra". Bare "gpt-6" and "astra" stay out: the guide
// names no other GPT-6 model, and a future sibling deserves its own preset.
function hasGpt6AstraSignal(value) {
    return /(?:^|[/@:._-])gpt[._-]?6[._-]astra(?:$|[/@:._-])/.test(normalizeModelId(value));
}
function isGpt6AstraModel(model) {
    return hasGpt6AstraSignal(model.id) || (model.name !== undefined && hasGpt6AstraSignal(model.name));
}
function extractGpt5Version(modelId) {
    const normalized = normalizeModelId(modelId);
    if (normalized.includes("gpt-5.6")) {
        return "gpt-5.6";
    }
    if (normalized.includes("gpt-5.5")) {
        return "gpt-5.5";
    }
    if (normalized.includes("gpt-5.4")) {
        return "gpt-5.4";
    }
    if (normalized.includes("gpt-5.3")) {
        return "gpt-5.3-codex";
    }
    if (normalized.includes("gpt-5.2")) {
        return "gpt-5.2";
    }
    return undefined;
}
function hasKimiK26Signal(value) {
    return /(?:^|[/@._-])kimi-k2(?:[._-]|p)6(?:$|[/@._:-])/.test(normalizeModelId(value));
}
function isKimiK26Model(model) {
    return hasKimiK26Signal(model.id) || (model.name !== undefined && hasKimiK26Signal(model.name));
}
function hasKimiK27Signal(value) {
    return /(?:^|[/@._-])kimi-k2(?:[._-]|p)7(?:$|[/@._:-])/.test(normalizeModelId(value));
}
function isKimiK27Model(model) {
    return hasKimiK27Signal(model.id) || (model.name !== undefined && hasKimiK27Signal(model.name));
}
function hasKimiK3Signal(value) {
    const normalized = normalizeModelId(value);
    return normalized === "k3" || /(?:^|[/@._-])kimi-k3(?:$|[/@._:-])/.test(normalized);
}
function isKimiK3Model(model) {
    return hasKimiK3Signal(model.id) || (model.name !== undefined && hasKimiK3Signal(model.name));
}
// DeepSeek V4 id shapes verified against the OpenRouter live API, models.dev,
// and senpi's generated provider catalogs (2026-07-31): deepseek-v4-flash,
// deepseek/deepseek-v4-flash-0731, deepseek-ai/DeepSeek-V4-Pro,
// accounts/fireworks/models/deepseek-v4-flash, aihubmix's alicloud-deepseek-v4-*,
// and trailing tags (:free, -free, :thinking, -nothinking, -cheaper, -lightning, -el).
function hasDeepseekV4Flash0731Signal(value) {
    return /(?:^|[/@:._-])deepseek[._-]v4[._-]flash[._-]0731(?:$|[/@:._-])/.test(normalizeModelId(value));
}
function isDeepseekV4Flash0731Model(model) {
    return (hasDeepseekV4Flash0731Signal(model.id) || (model.name !== undefined && hasDeepseekV4Flash0731Signal(model.name)));
}
function hasDeepseekV4FlashSignal(value) {
    return /(?:^|[/@:._-])deepseek[._-]v4[._-]flash(?:$|[/@:._-])/.test(normalizeModelId(value));
}
function isDeepseekV4FlashModel(model) {
    return hasDeepseekV4FlashSignal(model.id) || (model.name !== undefined && hasDeepseekV4FlashSignal(model.name));
}
function hasDeepseekV4ProSignal(value) {
    return /(?:^|[/@:._-])deepseek[._-]v4[._-]pro(?:$|[/@:._-])/.test(normalizeModelId(value));
}
function isDeepseekV4ProModel(model) {
    return hasDeepseekV4ProSignal(model.id) || (model.name !== undefined && hasDeepseekV4ProSignal(model.name));
}
function hasGlm52Signal(value) {
    return /(?:^|[/@._-])glm(?:[._-]|p)5(?:[._-]|p)2(?:$|[/@._:-])/.test(normalizeModelId(value));
}
function isGlm52Model(model) {
    return hasGlm52Signal(model.id) || (model.name !== undefined && hasGlm52Signal(model.name));
}
function hasGlm53Signal(value) {
    return /(?:^|[/@._-])glm(?:[._-]|p)5(?:[._-]|p)3(?:$|[/@._:-])/.test(normalizeModelId(value));
}
function isGlm53Model(model) {
    return hasGlm53Signal(model.id) || (model.name !== undefined && hasGlm53Signal(model.name));
}
function hasGrok45Signal(value) {
    // Match any Grok 4.5 id shape: grok-4.5, grok4.5, grok45, grok-4p5, provider:model,
    // path/prefix ids, and trailing tags (:thinking, -latest). Keep 4.3 / 4.20 / 3 out.
    return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?5(?:$|[/@._:-])/.test(normalizeModelId(value));
}
function isGrok45Model(model) {
    return hasGrok45Signal(model.id) || (model.name !== undefined && hasGrok45Signal(model.name));
}
function hasGrok46Signal(value) {
    // Same id shapes as hasGrok45Signal with a 4.6 minor version. Keep 4.5 / 4.3 / 4.20 / 3 out.
    return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?6(?:$|[/@._:-])/.test(normalizeModelId(value));
}
function isGrok46Model(model) {
    return hasGrok46Signal(model.id) || (model.name !== undefined && hasGrok46Signal(model.name));
}
// Claude Mythos shares each Fable release's prompting guide ("Prompting Claude
// Fable 5.1" covers Fable 5.1 and Mythos 5.1; "Prompting Claude Fable 5"
// covers Fable 5 and Mythos 5), so Mythos ids route to the matching Fable preset.
const CLAUDE_FABLE_51_MARKERS = ["fable-5-1", "fable-5.1", "mythos-5-1", "mythos-5.1"];
const CLAUDE_FABLE_5_MARKERS = ["fable-5", "mythos-5"];
function isClaudeFable51Model(modelId) {
    const normalized = normalizeModelId(modelId);
    return CLAUDE_FABLE_51_MARKERS.some((marker) => normalized.includes(marker));
}
function isClaudeFable5Model(modelId) {
    const normalized = normalizeModelId(modelId);
    return CLAUDE_FABLE_5_MARKERS.some((marker) => normalized.includes(marker));
}
function isClaudeOpus5Model(modelId) {
    return normalizeModelId(modelId).includes("opus-5");
}
function extractClaudeOpusVersion(modelId) {
    const normalized = normalizeModelId(modelId);
    if (normalized.includes("opus-4-8")) {
        return "claude-opus-4-8";
    }
    if (normalized.includes("opus-4-7")) {
        return "claude-opus-4-7";
    }
    if (normalized.includes("opus-4-6")) {
        return "claude-opus-4-6";
    }
    if (normalized.includes("opus-4-5") || normalized.includes("opus-4.5")) {
        return "claude-opus-4-5";
    }
    return undefined;
}
export function resolvePresetName(model, settings) {
    if (settings.promptPreset !== "auto") {
        return settings.promptPreset;
    }
    const modelPromptPreset = parsePromptPreset(model.promptPreset);
    if (modelPromptPreset && modelPromptPreset !== "auto") {
        return modelPromptPreset;
    }
    if (isGpt6AstraModel(model)) {
        return "gpt-6-astra";
    }
    const gpt5Version = extractGpt5Version(model.id);
    if (gpt5Version) {
        return gpt5Version;
    }
    if (isKimiK3Model(model)) {
        return "kimi-k3";
    }
    if (isKimiK27Model(model)) {
        return "kimi-k2-7";
    }
    if (isKimiK26Model(model)) {
        return "kimi-k2-6";
    }
    // The dotted release must resolve before the generic fable-5 substring.
    if (isClaudeFable51Model(model.id)) {
        return "claude-fable-5-1";
    }
    if (isClaudeFable5Model(model.id)) {
        return "claude-fable-5";
    }
    if (isClaudeOpus5Model(model.id)) {
        return "claude-opus-5";
    }
    const claudeVersion = extractClaudeOpusVersion(model.id);
    if (claudeVersion) {
        return claudeVersion;
    }
    if (isGlm53Model(model)) {
        return "glm-5.3";
    }
    if (isGlm52Model(model)) {
        return "glm-5.2";
    }
    // The dated snapshot must resolve before the generic flash alias.
    if (isDeepseekV4Flash0731Model(model)) {
        return "deepseek-v4-flash-0731";
    }
    if (isDeepseekV4FlashModel(model)) {
        return "deepseek-v4-flash";
    }
    if (isDeepseekV4ProModel(model)) {
        return "deepseek-v4-pro";
    }
    if (isGrok46Model(model)) {
        return "grok-4.6";
    }
    if (isGrok45Model(model)) {
        return "grok-4.5";
    }
    return undefined;
}
function withDefaults(options = {}) {
    return {
        cwd: options.cwd ?? "",
        selectedTools: options.selectedTools ?? [],
        toolSnippets: options.toolSnippets ?? {},
        promptGuidelines: options.promptGuidelines ?? [],
        contextFiles: options.contextFiles ?? [],
        skills: options.skills ?? [],
    };
}

export function resolvePreset(model, settings, options) {
    const name = resolvePresetName(model, settings);
    if (!name) return undefined;
    return { name, prompt: buildPresetTuning(name, withDefaults(options)) };
}
