import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Product overlay adds live-applied keys so they do not hot-reload the TUI. */
export const ROUTINE_SETTINGS_KEYS = new Set([
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
]);

export function isSettingsPath(path, agentDir, cwd) {
  const resolvedPath = resolve(path);
  return ["settings.jsonc", "settings.json"].some((name) => (
    resolvedPath === resolve(agentDir, name) ||
    resolvedPath === resolve(cwd, ".pi", name)
  ));
}

function parseSettingsObject(content) {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function changedTopLevelKeys(previous, next) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changed = [];
  for (const key of keys) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changed.push(key);
  }
  return changed.sort();
}

function isRoutineOnlySettingsChange(previousContent, nextContent) {
  if (previousContent === undefined || nextContent === undefined) return false;
  const previous = parseSettingsObject(previousContent);
  const next = parseSettingsObject(nextContent);
  if (previous === undefined || next === undefined) return false;
  const changedKeys = changedTopLevelKeys(previous, next);
  return changedKeys.length > 0 && changedKeys.every((key) => ROUTINE_SETTINGS_KEYS.has(key));
}

export function updateSettingsContentSnapshot(contents, path) {
  const key = resolve(path);
  try {
    contents.set(key, readFileSync(path, "utf8"));
  } catch {
    contents.delete(key);
  }
}

export function excludeRoutineOnlySettingsChanges(paths, contents, agentDir, cwd) {
  return paths.filter((path) => {
    if (!isSettingsPath(path, agentDir, cwd)) return true;
    const previousContent = contents.get(resolve(path));
    let nextContent;
    try {
      nextContent = readFileSync(path, "utf8");
    } catch {
      nextContent = undefined;
    }
    updateSettingsContentSnapshot(contents, path);
    return !isRoutineOnlySettingsChange(previousContent, nextContent);
  });
}
