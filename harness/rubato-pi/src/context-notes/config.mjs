// One process has one context policy. Do not switch it during a running session.
export const HISTORY_NOTES_MODE = "history-notes";
export const SUMMARY_MODE = "summary";

export function contextMode(env = process.env) {
  const value = env.RUBATO_CONTEXT_MODE?.trim() || HISTORY_NOTES_MODE;
  if (value !== HISTORY_NOTES_MODE && value !== SUMMARY_MODE) {
    throw new Error("RUBATO_CONTEXT_MODE는 history-notes 또는 summary여야 해요.");
  }
  return value;
}

export function historyNotesEnabled(env = process.env) {
  return contextMode(env) === HISTORY_NOTES_MODE;
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
  // Leave room for output and token-estimation error. The override is an input
  // experiment budget, not permission to exceed the provider's context limit.
  const ceiling = Math.floor(full * 0.9);
  const target = Math.min(config.windowTokens ?? Math.floor(full * 0.8), ceiling);
  return { target, reminder: Math.min(config.reminderTokens, Math.floor(target / 2)), full };
}
