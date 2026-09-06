// Live mode is process.env.RUBATO_CONTEXT_MODE. A user-set value has no origin
// marker and wins. A session-resolved value is marked ORIGIN=session so a child
// process re-resolves from its own model and session record.
export const HISTORY_NOTES_MODE = "history-notes";
export const SUMMARY_MODE = "summary";
export const CONTEXT_MODE_ORIGIN = "session";

let resolvedThisProcess = false;

function validateMode(value) {
  if (value !== HISTORY_NOTES_MODE && value !== SUMMARY_MODE) {
    throw new Error("RUBATO_CONTEXT_MODE는 history-notes 또는 summary여야 해요.");
  }
  return value;
}

export function isUserExplicitContextMode(env = process.env) {
  return Boolean(env.RUBATO_CONTEXT_MODE?.trim()) && env.RUBATO_CONTEXT_MODE_ORIGIN !== CONTEXT_MODE_ORIGIN;
}

export function hasResolvedContextMode() {
  return resolvedThisProcess;
}

export function resetContextModeResolution() {
  resolvedThisProcess = false;
}

export function contextMode(env = process.env) {
  const raw = env.RUBATO_CONTEXT_MODE?.trim();
  if (!raw) return HISTORY_NOTES_MODE;
  if (env.RUBATO_CONTEXT_MODE_ORIGIN !== CONTEXT_MODE_ORIGIN) return validateMode(raw);
  if (env === process.env && !resolvedThisProcess) return HISTORY_NOTES_MODE;
  return validateMode(raw);
}

export function historyNotesEnabled(env = process.env) {
  return contextMode(env) === HISTORY_NOTES_MODE;
}

export function setContextMode(mode, env = process.env) {
  const next = validateMode(mode);
  env.RUBATO_CONTEXT_MODE = next;
  env.RUBATO_CONTEXT_MODE_ORIGIN = CONTEXT_MODE_ORIGIN;
  if (env === process.env) resolvedThisProcess = true;
  return next;
}

function integer(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 값은 ${minimum}~${maximum} 사이의 정수여야 해요.`);
  }
  return value;
}

export function contextNotesConfig(env = process.env) {
  return Object.freeze({
    mode: contextMode(env),
    windowTokens: integer(env, "RUBATO_CONTEXT_WINDOW_TOKENS", undefined, 8192, 10_000_000),
    reminderTokens: integer(env, "RUBATO_CONTEXT_REMINDER_TOKENS", 6144, 1024, 100_000),
    maxNoteBytes: 1_000_000,
    maxOutputChars: 24_000,
    maxHintBytes: 4000,
    hintFiles: 5,
  });
}

export function windowBudget(model, config = contextNotesConfig()) {
  const full = Number(model?.contextWindow);
  if (!Number.isSafeInteger(full) || full < 8192) {
    throw new Error("모델의 문맥 한도를 읽지 못했어요. 새 문맥 모드에서는 한도가 명시된 모델을 사용해 주세요.");
  }
  // Codex-aligned stages on the physical window: reminder at target-6144,
  // strong checkpoint at 90%, harness cut at 95%. An explicit override is the
  // 90% line, still capped so it cannot pass the physical 90% ceiling.
  const target = Math.min(config.windowTokens ?? Math.floor(full * 0.9), Math.floor(full * 0.9));
  const hard = Math.floor(full * 0.95);
  return { target, hard, reminder: Math.min(config.reminderTokens, Math.floor(target / 2)), full };
}
