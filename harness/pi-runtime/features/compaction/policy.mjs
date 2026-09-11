import { resolveClientCompactionThresholdRatio } from "./threshold.mjs";

function configuredOrAdaptiveThreshold(contextWindow, settings, lastYield) {
    const configured = resolveClientCompactionThresholdRatio({ model: settings?.model, settings });
    if (configured !== undefined) return configured;
    return computeEffectiveThreshold(contextWindow, lastYield);
}

const MIN_ADAPTIVE_THRESHOLD_RATIO = 0.4;
const MAX_ADAPTIVE_THRESHOLD_RATIO = 0.85;
const HIGH_YIELD_SAVING_RATIO = 0.5;
const LOW_YIELD_SAVING_RATIO = 0.1;
const YIELD_ADJUSTMENT_RATIO = 0.05;
const MIN_EFFECTIVE_KEEP_RECENT_TOKENS = 1024;
const RESERVE_WINDOW_FRACTION = 0.04;
const MAX_SCALED_RESERVE_TOKENS = 49_152;
const KEEP_RECENT_WINDOW_FRACTION = 0.05;
const MAX_SCALED_KEEP_RECENT_TOKENS = 60_000;
export const SPECULATIVE_FRACTION = 0.75;
function clampThresholdRatio(ratio) {
    return Math.min(MAX_ADAPTIVE_THRESHOLD_RATIO, Math.max(MIN_ADAPTIVE_THRESHOLD_RATIO, ratio));
}
function adjustThresholdRatio(ratio, savedTokens, contextWindow) {
    if (contextWindow <= 0) {
        return ratio;
    }
    const savedRatio = savedTokens / contextWindow;
    if (savedRatio > HIGH_YIELD_SAVING_RATIO) {
        return clampThresholdRatio(ratio - YIELD_ADJUSTMENT_RATIO);
    }
    if (savedRatio < LOW_YIELD_SAVING_RATIO) {
        return Math.min(baseThresholdRatioForWindow(contextWindow), clampThresholdRatio(ratio + YIELD_ADJUSTMENT_RATIO));
    }
    return ratio;
}
function adjustEffectiveThresholdRatio(ratio, savedTokens, tokensBefore, contextWindow) {
    if (tokensBefore <= 0) {
        return ratio;
    }
    const savedRatio = savedTokens / tokensBefore;
    if (savedRatio > HIGH_YIELD_SAVING_RATIO) {
        return ratio - YIELD_ADJUSTMENT_RATIO;
    }
    if (savedRatio < LOW_YIELD_SAVING_RATIO) {
        return Math.min(baseThresholdRatioForWindow(contextWindow), ratio + YIELD_ADJUSTMENT_RATIO);
    }
    return ratio;
}
export function baseThresholdRatioForWindow(contextWindow) {
    if (!(contextWindow > 0)) {
        return 0.5;
    }
    if (contextWindow <= 16_000) {
        return 0.45;
    }
    if (contextWindow <= 32_000) {
        return 0.5;
    }
    if (contextWindow <= 64_000) {
        return 0.55;
    }
    if (contextWindow <= 128_000) {
        return 0.6;
    }
    if (contextWindow <= 512_000) {
        return 0.7;
    }
    return 0.8;
}
export function resolveReserveTokens(contextWindow, configuredReserve) {
    return Math.max(configuredReserve, Math.min(Math.floor(RESERVE_WINDOW_FRACTION * contextWindow), MAX_SCALED_RESERVE_TOKENS));
}
/**
 * The single effective reserve for one window. Every consumer that reasons about
 * the usable prompt budget — the hard-limit valve, restoration, and deterministic
 * fallback acceptance — must resolve it here so acceptance can never admit a
 * context the hard valve would immediately compact again. Scaling is idempotent,
 * so re-resolving an already-scaled reserve never double-scales it.
 */
export function resolveEffectiveReserveTokens(contextWindow, settings) {
    return settings.reserveScalingEnabled === false
        ? settings.reserveTokens
        : resolveReserveTokens(contextWindow, settings.reserveTokens);
}
export function computeAdaptiveThresholdRatio(contextWindow, priorCompactionSavedTokens) {
    const ratio = baseThresholdRatioForWindow(contextWindow);
    if (priorCompactionSavedTokens === undefined) {
        return ratio;
    }
    return adjustThresholdRatio(ratio, priorCompactionSavedTokens, contextWindow);
}
export function computeEffectiveThreshold(contextWindow, lastYield) {
    let ratio = computeAdaptiveThresholdRatio(contextWindow);
    if (lastYield) {
        ratio = adjustEffectiveThresholdRatio(ratio, lastYield.savedTokens, lastYield.tokensBefore, contextWindow);
    }
    return clampThresholdRatio(ratio);
}
export function computeEffectiveKeepRecentTokens(setting, contextWindow, thresholdRatio, margin = 0.05) {
    const scaled = contextWindow > 409_600 && setting >= 10_000
        ? Math.max(setting, Math.min(Math.floor(KEEP_RECENT_WINDOW_FRACTION * contextWindow), MAX_SCALED_KEEP_RECENT_TOKENS))
        : setting;
    const capped = Math.floor(contextWindow * (1 - thresholdRatio - margin));
    return Math.min(scaled, Math.max(MIN_EFFECTIVE_KEEP_RECENT_TOKENS, capped));
}
export function shouldStartSpeculativeCompaction(usage, contextWindow, settings, lastYield, leadTokens) {
    if (settings.speculativeEnabled === false || usage.tokens === null || contextWindow <= 0) {
        return false;
    }
    if (typeof leadTokens === "number" && Number.isFinite(leadTokens) && leadTokens > 0) {
        const leadTrigger = Math.max(0, contextWindow * computeEffectiveThreshold(contextWindow, lastYield) - leadTokens);
        return usage.tokens >= leadTrigger;
    }
    const fraction = settings.speculativeFraction ?? SPECULATIVE_FRACTION;
    return usage.tokens >= contextWindow * configuredOrAdaptiveThreshold(contextWindow, settings, lastYield) * fraction;
}
export function isAtHardLimit(usage, contextWindow, reserveTokens, additionalTokens = 0) {
    return usage.tokens !== null && usage.tokens + additionalTokens + reserveTokens >= contextWindow;
}
export function shouldTriggerCompaction(usage, contextWindow, settings, lastYield) {
    if (!settings.enabled || usage.tokens === null || contextWindow <= 0) {
        return false;
    }
    return usage.tokens >= contextWindow * configuredOrAdaptiveThreshold(contextWindow, settings, lastYield);
}
