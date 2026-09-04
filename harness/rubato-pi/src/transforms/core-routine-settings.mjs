import { replaceOnce } from "./core-replace.mjs";

const NEEDLE = `const ROUTINE_SETTINGS_KEYS = new Set([
    "defaultModel",
    "defaultProvider",
    "defaultThinkingLevel",
    "modelThinkingLevels",
    "modelLastOnThinkingLevels",
    "modelServiceTiers",
    "lastChangelogVersion",
    "tipsHistory",
]);`;

const REPLACEMENT = `const ROUTINE_SETTINGS_KEYS = new Set([
    "defaultModel",
    "defaultProvider",
    "defaultThinkingLevel",
    "modelThinkingLevels",
    "modelLastOnThinkingLevels",
    "modelServiceTiers",
    "lastChangelogVersion",
    "tipsHistory",
    "theme",
    "hideThinkingBlock",
    "tips",
    "retry",
    "promptCache",
    "compaction",
]);`;

export function isRoutineSettingsUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/builtin/config-reload/routine-settings.js");
}

/**
 * Settings writes for keys a running session already applies live (theme,
 * retry, compaction thresholds) must not hot-reload the TUI. A reload emits
 * session_shutdown{reason:"reload"} and used to make the hub kill the pane.
 */
export function injectRoutineSettings(source) {
  return replaceOnce(source, NEEDLE, REPLACEMENT, "routine settings keys");
}
