// 모델마다 문맥 창을 어떻게 끝내는지(문맥 전략)와 그 선들을 여기 한 곳에서 정한다.
//
// 작업 노트/원문 기록은 모든 모델이 쓴다. 창을 끝내는 방식만 모델의 경제성으로 고른다
// (2026-09-23 핸드오프 §4, 사용자 결정):
//
//   notes-rollover     Codex(openai-codex/* — Sol·Terra·Luna·Astra, `-sub` 포함): 같은 레인·272K 창이라
//                      한 전략이다. 90% 목표, 95% 비상선, 90~95% 는 노트 갱신 + new_context 전용 구간.
//                      Grok: 200K 가격 경계에서는 자르지 않고 300K 부터 자연 경계에서 전환,
//                      320K 에서 적극 유도, 400K 비상선.
//   server-compaction  Claude: Anthropic 서버 컴팩션이 창을 소유한다. 자동 임계점은 없고
//                      서버 trigger 는 아래 비상선(hardSafetyLine)만 쓴다.
//   hard-safety        그 밖의 모든 모델(DeepSeek, Gemini …): 자동 전환 없음. 모델이 부르는
//                      new_context 만 있고, 물리 한도 직전의 비상선만 둔다.
//
// 비상선 = 창 - 출력 예약 - 여유분. 고정 숫자가 아니라 창에서 계산한다. 출력 예약은
// Pi 의 compaction.reserveTokens(기본 16,384)를 창의 4%(최대 49,152)까지 늘린 값 —
// Rubato 가 응답 몫으로 설정해 두는 예약이지, 모델 카탈로그의 최대 출력(DeepSeek 384K)이
// 아니다. 요청의 max_tokens 는 엔진이 남은 창에 맞춰 줄인다.
//
// 이 파일은 import 가 없다. pi-ai(서버 컴팩션 와이어), providers, context-notes 에 같은
// 파일로 스테이징되어 세 곳이 같은 숫자를 쓴다.

export const NOTES_ROLLOVER_STRATEGY = "notes-rollover";
export const SERVER_COMPACTION_STRATEGY = "server-compaction";
export const HARD_SAFETY_STRATEGY = "hard-safety";

/** Anthropic 서버 컴팩션(compact_20260112)을 쓰는 Claude 모델. `-sub` 는 같은 모델의 두 번째 계정이다. */
export const ANTHROPIC_SERVER_COMPACTION_MODEL_IDS = Object.freeze([
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-fable-5-1",
]);

export const DEFAULT_REMINDER_TOKENS = 6144;
export const DEFAULT_NOTE_NUDGE_RATIO = 0.2;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_384;
const OUTPUT_RESERVE_WINDOW_FRACTION = 0.04;
const MAX_SCALED_OUTPUT_RESERVE_TOKENS = 49_152;
const SAFETY_MARGIN_MIN_TOKENS = 8192;
const SAFETY_MARGIN_WINDOW_FRACTION = 0.02;

export const GROK_SOFT_TOKENS = 300_000;
export const GROK_TARGET_TOKENS = 320_000;
export const GROK_HARD_TOKENS = 400_000;
// 500K 창 기준 비율. 더 작은 창의 Grok 이 오면 같은 모양으로 줄인다.
const GROK_REFERENCE_WINDOW = 500_000;

const SERVER_COMPACTION_IDS = new Set(ANTHROPIC_SERVER_COMPACTION_MODEL_IDS);

function wireModelId(model) {
  const id = typeof model?.id === "string" ? model.id : model?.modelId;
  if (typeof id !== "string") return "";
  return id.endsWith("-sub") ? id.slice(0, -4) : id;
}

export function isAnthropicServerCompactionModel(model) {
  if (!model || typeof model !== "object" || model.provider !== "anthropic") return false;
  return SERVER_COMPACTION_IDS.has(wireModelId(model));
}

// The whole Codex lane shares one window shape, so it shares Astra's rollover strategy.
function isCodex(model) {
  return model?.provider === "openai-codex" && wireModelId(model) !== "";
}

function isGrok(model) {
  const id = wireModelId(model);
  return (model?.provider === "xai" || model?.provider === "cursor") && id.startsWith("grok-4.7");
}

export function contextStrategy(model) {
  if (isAnthropicServerCompactionModel(model)) return SERVER_COMPACTION_STRATEGY;
  if (isCodex(model) || isGrok(model)) return NOTES_ROLLOVER_STRATEGY;
  return HARD_SAFETY_STRATEGY;
}

function envInteger(env, name, minimum, maximum) {
  const raw = env?.[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 값은 ${minimum}~${maximum} 사이의 정수여야 해요.`);
  }
  return value;
}

function envRatio(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} 값은 0~1 사이의 비율이어야 해요. 0이면 주기 안내를 끕니다.`);
  }
  return value;
}

/** 환경 변수로 바꿀 수 있는 예산 값. 비워 두면 창에서 계산한다. */
export function contextBudgetSettings(env = process.env) {
  return Object.freeze({
    noteNudgeRatio: envRatio(env, "RUBATO_CONTEXT_NOTE_NUDGE_RATIO", DEFAULT_NOTE_NUDGE_RATIO),
    outputReserveTokens: envInteger(env, "RUBATO_CONTEXT_OUTPUT_RESERVE_TOKENS", 1024, 2_000_000),
    safetyMarginTokens: envInteger(env, "RUBATO_CONTEXT_SAFETY_MARGIN_TOKENS", 0, 2_000_000),
  });
}

export function outputReserveTokens(model, settings = contextBudgetSettings()) {
  const full = Number(model?.contextWindow);
  const scaled = settings.outputReserveTokens ?? Math.max(DEFAULT_OUTPUT_RESERVE_TOKENS,
    Math.min(Math.floor(OUTPUT_RESERVE_WINDOW_FRACTION * full), MAX_SCALED_OUTPUT_RESERVE_TOKENS));
  const modelMax = Number(model?.maxTokens);
  return Number.isSafeInteger(modelMax) && modelMax > 0 ? Math.min(scaled, modelMax) : scaled;
}

export function safetyMarginTokens(model, settings = contextBudgetSettings()) {
  const full = Number(model?.contextWindow);
  return settings.safetyMarginTokens ?? Math.max(SAFETY_MARGIN_MIN_TOKENS, Math.floor(SAFETY_MARGIN_WINDOW_FRACTION * full));
}

/**
 * 물리 한도 직전의 비상선. 창을 모르면 undefined — 부르는 쪽이 선을 지어내지 않는다.
 * 작은 창에서 예약이 창을 다 먹지 않도록 창의 절반 아래로는 내려가지 않는다.
 */
export function hardSafetyLine(model, settings = contextBudgetSettings()) {
  const full = Number(model?.contextWindow);
  if (!Number.isSafeInteger(full) || full <= 0) return undefined;
  const line = full - outputReserveTokens(model, settings) - safetyMarginTokens(model, settings);
  return Math.max(Math.floor(full / 2), line);
}

/**
 * 한 창의 선들. 없는 선은 undefined 다.
 *   soft       이 위에서 노트가 최신이면 턴 경계에서 전환한다 (자연 경계).
 *   target     이 위에서는 노트 갱신 + new_context 만 하도록 유도한다.
 *   hard       이 위의 새 요청은 체크포인트 턴이 아니면 막는다.
 *   reminderAt 마지막 안내를 한 번 붙이는 지점 (soft - reminder).
 *   nudgeTokens 마지막 노트 이후 이만큼 쌓이면 노트 갱신 안내를 붙인다.
 *   safetyLine 비상선 계산값. server-compaction 에서는 서버 trigger 로 나간다.
 */
export function windowBudget(model, config = {}) {
  const full = Number(model?.contextWindow);
  if (!Number.isSafeInteger(full) || full < 8192) {
    throw new Error("모델의 문맥 한도를 읽지 못했어요. 새 문맥 모드에서는 한도가 명시된 모델을 사용해 주세요.");
  }
  const settings = { ...contextBudgetSettings({}), ...config };
  const strategy = contextStrategy(model);
  const safetyLine = hardSafetyLine(model, settings);
  let soft, target, hard;
  if (strategy === NOTES_ROLLOVER_STRATEGY && isGrok(model)) {
    const scale = Math.min(1, full / GROK_REFERENCE_WINDOW);
    hard = Math.floor(GROK_HARD_TOKENS * scale);
    target = Math.floor(GROK_TARGET_TOKENS * scale);
    soft = Math.floor(GROK_SOFT_TOKENS * scale);
  } else if (strategy === NOTES_ROLLOVER_STRATEGY) {
    // Codex-aligned stages on the physical window: reminder at target-6144,
    // rollover-only buffer from 90%, harness line at 95%.
    target = Math.floor(full * 0.9);
    hard = Math.floor(full * 0.95);
    soft = target;
  } else if (strategy === HARD_SAFETY_STRATEGY) {
    soft = target = hard = safetyLine;
  }
  // An explicit override lowers the rollover target; it never raises a line.
  if (target !== undefined && strategy === NOTES_ROLLOVER_STRATEGY && settings.windowTokens !== undefined) {
    target = Math.min(target, settings.windowTokens);
    soft = Math.min(soft, target);
  }
  const reminderTokens = settings.reminderTokens ?? DEFAULT_REMINDER_TOKENS;
  const reminder = soft === undefined ? undefined : Math.min(reminderTokens, Math.floor(soft / 2));
  const ratio = settings.noteNudgeRatio ?? DEFAULT_NOTE_NUDGE_RATIO;
  return {
    strategy,
    full,
    soft,
    target,
    hard,
    reminder,
    reminderAt: soft === undefined ? undefined : soft - reminder,
    nudgeTokens: ratio > 0 ? Math.floor(full * ratio) : undefined,
    safetyLine,
  };
}
