import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_NOTES_MODE, SUMMARY_MODE, contextMode } from "./config.mjs";
import {
  INIT_ENTRY,
  MODE_ENTRY,
  PREPARE_ENTRY,
  REMINDER_ENTRY,
  isWindowCompaction,
  branchWindow,
} from "./protocol.mjs";

// Add rows here when another model should start in history-notes by default.
export const HISTORY_NOTES_DEFAULT_MODELS = Object.freeze([
  Object.freeze({ provider: "openai-codex", id: "gpt-6-astra" }),
]);

const NOTES_WINDOW_TYPES = new Set([INIT_ENTRY, PREPARE_ENTRY, REMINDER_ENTRY]);

export const SUMMARY_SESSION_TOOL_ERROR = "이 세션은 요약 모드로 실행 중이에요. 작업 노트 도구는 사용할 수 없어요.";
export const SUMMARY_SESSION_COMMAND_NOTICE = "이 세션은 요약 모드로 실행 중이에요. 작업 노트 명령은 사용할 수 없어요.";
export const NOTES_TO_SUMMARY_REFUSED = "이미 작업 노트 창이 있는 세션은 요약 모드로 바꿀 수 없어요. 노트 도구 없이 원문을 압축하면 복구할 수 없어요.";
export const NOTES_RESUME_IN_SUMMARY = "이 세션은 작업 노트 방식으로 이어져 있어요. history-notes 모드로 다시 열어 주세요. summary 비교 실험은 새 세션에서 시작해 주세요.";

export function defaultContextModeForModel(model = {}) {
  const provider = model.provider ?? "";
  const id = model.id ?? model.modelId ?? "";
  const notes = HISTORY_NOTES_DEFAULT_MODELS.some((entry) => entry.provider === provider && entry.id === id);
  return notes ? HISTORY_NOTES_MODE : SUMMARY_MODE;
}

export function flagValue(args = [], name) {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === name && typeof args[i + 1] === "string" && args[i + 1].length > 0) return args[i + 1];
    if (typeof token === "string" && token.startsWith(prefix) && token.length > prefix.length) {
      return token.slice(prefix.length);
    }
  }
  return undefined;
}

export function startingModelFromLaunch({
  args = [],
  agentDir,
  readFile = readFileSync,
  exists = existsSync,
} = {}) {
  const modelArg = flagValue(args, "--model");
  const providerArg = flagValue(args, "--provider");
  let provider = providerArg;
  let id = modelArg;
  if (typeof modelArg === "string") {
    const slash = modelArg.indexOf("/");
    if (slash > 0) {
      if (!provider) provider = modelArg.slice(0, slash);
      id = modelArg.slice(slash + 1);
    }
  }
  if (!provider || !id) {
    const settings = readSettings(agentDir, { readFile, exists });
    provider = provider || settings.defaultProvider;
    id = id || settings.defaultModel;
  }
  return { provider, id };
}

export function peekSessionContextMode(file, { readFile = readFileSync } = {}) {
  if (!file) return undefined;
  let text;
  try { text = readFile(file, "utf8"); }
  catch { return undefined; }
  let recorded;
  let notes = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); }
    catch { continue; }
    if (entry?.type === "custom" && entry.customType === MODE_ENTRY) {
      const mode = entry.data?.mode;
      if (mode === HISTORY_NOTES_MODE || mode === SUMMARY_MODE) recorded = mode;
    }
    if (isNotesWindowEntry(entry)) notes = true;
  }
  if (recorded) return recorded;
  if (notes) return HISTORY_NOTES_MODE;
  return undefined;
}

export function resolveLaunchContextMode({
  args = [],
  env = process.env,
  agentDir,
  readFile = readFileSync,
  exists = existsSync,
} = {}) {
  if (env.RUBATO_CONTEXT_MODE?.trim()) return contextMode(env);
  const sessionFile = flagValue(args, "--session");
  if (sessionFile) {
    const peeked = peekSessionContextMode(sessionFile, { readFile });
    if (peeked) return peeked;
  }
  return defaultContextModeForModel(startingModelFromLaunch({ args, agentDir, readFile, exists }));
}

export function recordedModeFromBranch(branch = []) {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === MODE_ENTRY) {
      const mode = entry.data?.mode;
      if (mode === HISTORY_NOTES_MODE || mode === SUMMARY_MODE) return mode;
    }
  }
  return undefined;
}

export function isNotesWindowEntry(entry) {
  if (isWindowCompaction(entry)) return true;
  return entry?.type === "custom" && NOTES_WINDOW_TYPES.has(entry.customType);
}

export function hasNotesWindowEntries(branch = []) {
  return branch.some(isNotesWindowEntry);
}

export function hasNotesWindowBoundary(branch = []) {
  if (branch.some((entry) => isWindowCompaction(entry) || (entry?.type === "custom" && entry.customType === PREPARE_ENTRY))) {
    return true;
  }
  try {
    const window = branchWindow(branch);
    return Boolean(window && window.number > 0);
  } catch {
    return true;
  }
}

export function modelModeLabel(model = {}) {
  const id = model.id ?? "";
  if (id === "gpt-6-astra" || id.includes("astra")) return "Astra";
  if (id.includes("fable")) return "Fable";
  return model.name || id || "이 모델";
}

export function contextModePrompt(model, nextMode) {
  const label = modelModeLabel(model);
  if (nextMode === HISTORY_NOTES_MODE) {
    return `${label}는 작업 노트 모드가 기본이에요. 이 세션을 작업 노트 모드로 바꿀까요?`;
  }
  return `${label}는 요약 모드가 기본이에요. 이 세션을 요약 모드로 바꿀까요?`;
}

export function modePairKey(currentMode, model = {}) {
  return `${currentMode}|${model.provider ?? ""}/${model.id ?? ""}`;
}

export async function considerContextModeSwitch({
  model,
  source,
  currentMode,
  branch = [],
  confirm,
  notify,
  declined,
} = {}) {
  if (source === "restore" || source === "fallback" || source === "fallback-revert") {
    return { action: "keep" };
  }
  const wanted = defaultContextModeForModel(model);
  if (!model || wanted === currentMode) return { action: "keep" };
  const key = modePairKey(currentMode, model);
  if (declined?.has(key)) return { action: "keep" };
  if (wanted === SUMMARY_MODE && hasNotesWindowBoundary(branch)) {
    notify?.(NOTES_TO_SUMMARY_REFUSED, "warning");
    return { action: "keep", refused: true };
  }
  if (typeof confirm !== "function") {
    notify?.("모델을 바꿨지만 문맥 모드는 그대로예요. 확인 대화 상자를 쓸 수 없어요.", "info");
    return { action: "keep" };
  }
  const ok = await confirm("문맥 모드", contextModePrompt(model, wanted));
  if (!ok) {
    declined?.add(key);
    return { action: "keep", declined: true };
  }
  return { action: "switch", mode: wanted };
}

function readSettings(agentDir, { readFile, exists }) {
  if (!agentDir) return {};
  const path = join(agentDir, "settings.json");
  if (!exists(path)) return {};
  try {
    const parsed = JSON.parse(readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
