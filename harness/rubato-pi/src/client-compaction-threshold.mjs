/**
 * Client-side compaction trigger ratio.
 *
 * Anthropic server compaction is a different lane and is not resolved here.
 *
 * Stock Codex (openai/codex, no model_auto_compact_token_limit):
 *   raw window 272,000 × 90% = 244,800
 *   (`ModelInfo::auto_compact_token_limit` uses the raw window, not the 95%
 *   usable window shown in /status.)
 *
 * Grok (Cursor or xAI): compact when about 10% of the window remains.
 *
 * Override in ~/.rubato-pi/agent/settings.json:
 *
 *   "compaction": {
 *     "thresholdRatio": 0.9,
 *     "models": {
 *       "openai-codex/gpt-5.6-sol": 0.88
 *     }
 *   }
 *
 * Resolution: settings.models (most specific) > settings.thresholdRatio >
 * baked per-model defaults > 0.9.
 */

export const CODEX_STOCK_WINDOW = 272_000;
export const CODEX_STOCK_THRESHOLD_RATIO = 0.9;
export const CODEX_STOCK_TRIGGER_TOKENS = 244_800;
export const GROK_REMAINING_THRESHOLD_RATIO = 0.9;
export const DEFAULT_CLIENT_COMPACTION_THRESHOLD_RATIO = 0.9;

/** @type {Record<string, number>} */
export const DEFAULT_CLIENT_COMPACTION_THRESHOLD_MODELS = Object.freeze({
  "openai-codex": CODEX_STOCK_THRESHOLD_RATIO,
  "*grok*": GROK_REMAINING_THRESHOLD_RATIO,
});

/**
 * @param {unknown} raw
 * @returns {number | undefined}
 */
export function normalizeThresholdRatio(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return normalizeThresholdRatio(/** @type {{ thresholdRatio?: unknown }} */ (raw).thresholdRatio);
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if (raw <= 0 || raw > 1) return undefined;
  return raw;
}

/**
 * @param {unknown} model
 * @returns {{ provider: string, id: string, key: string }}
 */
export function modelRef(model) {
  if (!model || typeof model !== "object") return { provider: "", id: "", key: "" };
  const provider = typeof model.provider === "string" ? model.provider : "";
  const id = typeof model.id === "string" ? model.id : "";
  return { provider, id, key: provider && id ? `${provider}/${id}` : provider || id };
}

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
export function thresholdPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * @param {string} pattern
 * @param {{ provider: string, id: string, key: string }} ref
 * @returns {number}
 */
export function thresholdPatternScore(pattern, ref) {
  if (!pattern) return 0;
  if (pattern === ref.key) return 1000 + pattern.length;
  if (pattern === ref.id) return 500 + pattern.length;
  if (pattern === ref.provider) return 400 + pattern.length;
  if (!pattern.includes("*")) return 0;
  const re = thresholdPatternToRegExp(pattern);
  if (ref.key && re.test(ref.key)) return 300 + pattern.length;
  if (ref.id && re.test(ref.id)) return 200 + pattern.length;
  if (ref.provider && re.test(ref.provider)) return 100 + pattern.length;
  return 0;
}

/**
 * @param {unknown} map
 * @param {unknown} model
 * @returns {number | undefined}
 */
export function pickThresholdRatioFromMap(map, model) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
  const ref = modelRef(model);
  let bestScore = 0;
  let bestRatio;
  for (const [pattern, raw] of Object.entries(map)) {
    const ratio = normalizeThresholdRatio(raw);
    if (ratio === undefined) continue;
    const score = thresholdPatternScore(pattern, ref);
    if (score > bestScore) {
      bestScore = score;
      bestRatio = ratio;
    }
  }
  return bestRatio;
}

/**
 * @param {{
 *   model?: unknown,
 *   settings?: { thresholdRatio?: unknown, models?: unknown, thresholdByModel?: unknown },
 * }} [input]
 * @returns {number | undefined}
 */
export function resolveClientCompactionThresholdRatio(input = {}) {
  const settings = input.settings ?? {};
  const model = input.model ?? settings.model;
  const fromModels = pickThresholdRatioFromMap(settings.models ?? settings.thresholdByModel, model);
  if (fromModels !== undefined) return fromModels;
  const global = normalizeThresholdRatio(settings.thresholdRatio);
  if (global !== undefined) return global;
  return pickThresholdRatioFromMap(DEFAULT_CLIENT_COMPACTION_THRESHOLD_MODELS, model)
    ?? DEFAULT_CLIENT_COMPACTION_THRESHOLD_RATIO;
}

/**
 * @param {number} contextWindow
 * @param {number} ratio
 * @returns {number}
 */
export function compactTriggerTokens(contextWindow, ratio) {
  return Math.floor(contextWindow * ratio);
}
