// Cache warming on Rubato's terms.
//
// Stock pi warms only models whose catalog entry declares a `promptCache` lifetime, refreshes at
// 90% of it, stops 30 minutes into idle and gates each refresh on a 15% continuation estimate.
// No Rubato model declares a lifetime, so the warmer never ran (0 `cache_warm` entries in every
// session through 2026-09-23), and with the 1h Anthropic tier its first idle refresh (54m) would
// fall past the 30-minute idle limit anyway.
//
// Rubato's policy is anchored on the person, not on the last request: keep the cache warm for two
// hours after the latest user input, refreshing Claude every 40 minutes (1h tier) and Codex every
// 20 minutes (30m tier). Inside that window every refresh is sent; outside it none is. Other
// providers keep stock behaviour.
//
// Codex has no output-token cap on the wire, so a replay would generate a whole turn. Its refresh
// stops at the first output event instead: by then the prompt prefix has been processed, which is
// what refreshes the cache entry.
import { fileURLToPath } from "node:url";

const PACKAGE_AGENT = "@earendil-works/pi-coding-agent";
const VERSION = "0.86.1";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[cache-warming:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[cache-warming:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patch(id, path, preimageSha256, apply) {
  return Object.freeze({ id, packageName: PACKAGE_AGENT, version: VERSION, path, preimageSha256, apply });
}

export function patchCacheWarmer(source) {
  let next = replaceOnce(
    source,
    `/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */`,
    `/** Rubato refresh interval per provider; the entry lifetime is 1h (Anthropic) and 30m (Codex). */
export const RUBATO_WARMING_INTERVAL_MS = Object.freeze({
    anthropic: 40 * 60_000,
    "openai-codex": 20 * 60_000,
});
/** Rubato keeps warming this long after the latest user input. */
export const RUBATO_WARMING_HORIZON_MS = 2 * 60 * 60_000;
export function rubatoWarmingIntervalMs(model) {
    return RUBATO_WARMING_INTERVAL_MS[model?.provider];
}
/** Providers whose replay cannot be capped at one output token; the refresh stops after prefill. */
function stopsAfterPrefill(model) {
    return model?.provider === "openai-codex";
}
/**
 * Whether the latest response carried an Anthropic server compaction block. After one, the
 * request the warmer holds is the pre-compaction prefix: nothing will read it again, and
 * replaying it crosses the compaction trigger and makes the server summarize a second time.
 */
export function lastResponseCompacted(entries) {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.type !== "message" || entry.message?.role !== "assistant")
            continue;
        const content = entry.message.content;
        return Array.isArray(content) && content.some((block) => block?.type === "providerNative" && block.subtype === "compaction");
    }
    return false;
}
/** Timestamp of the latest user-authored message on the branch. */
export function lastUserInputAt(entries) {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.type === "message" && entry.message?.role === "user") {
            const at = entry.message.timestamp ?? Date.parse(entry.timestamp);
            return Number.isFinite(at) ? at : undefined;
        }
    }
    return undefined;
}
/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */`,
    "policy",
  );
  next = replaceOnce(
    next,
    `    if (!options?.reasoning || model.api !== "anthropic-messages")
        return true;
    return model.compat?.forceAdaptiveThinking === true;`,
    `    if (!options?.reasoning || model.api !== "anthropic-messages")
        return true;
    // Managed-effort models always send adaptive thinking (anthropic-messages buildParams).
    return model.compat?.forceAdaptiveThinking === true || model.compat?.supportsMidConvoEffort === true;`,
    "replayable",
  );
  next = replaceOnce(
    next,
    `        const ttlMs = getPromptCacheTtlMs(request.model, request.options);
        if (ttlMs === undefined) {`,
    `        const rubatoIntervalMs = request.options?.cacheRetention === "none" ? undefined : rubatoWarmingIntervalMs(request.model);
        const ttlMs = rubatoIntervalMs ?? getPromptCacheTtlMs(request.model, request.options);
        if (ttlMs === undefined) {`,
    "start-ttl",
  );
  next = replaceOnce(
    next,
    `        const delayMs = getCacheWarmingDelayMs(ttlMs);`,
    `        const delayMs = rubatoIntervalMs ?? getCacheWarmingDelayMs(ttlMs);`,
    "start-delay",
  );
  next = replaceOnce(
    next,
    `            nextWarmAt: 0,
            extensionOverride: false,
        };
        this.schedule(this.run);`,
    `            nextWarmAt: 0,
            extensionOverride: false,
            anchoredUntil: rubatoIntervalMs === undefined
                ? undefined
                : (lastUserInputAt(this.sessionManager.getBranch()) ?? Date.now()) + RUBATO_WARMING_HORIZON_MS,
        };
        this.schedule(this.run);`,
    "start-anchor",
  );
  next = replaceOnce(
    next,
    `        run.phase = "idle";
        const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
        if (run.nextWarmAt > deadline || Date.now() >= deadline) {
            this.stop("30-minute idle safety limit reached");
        }`,
    `        run.phase = "idle";
        const deadline = run.anchoredUntil ?? run.startedAt + MAX_IDLE_WARMING_AGE_MS;
        if (run.nextWarmAt > deadline || Date.now() >= deadline || (run.anchoredUntil !== undefined && run.nextWarmAt >= deadline)) {
            this.stop(run.anchoredUntil === undefined ? "30-minute idle safety limit reached" : "two hours since the latest user input");
        }`,
    "settled-deadline",
  );
  next = replaceOnce(
    next,
    `        const deadline = run.startedAt + (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
        if (run.nextWarmAt > deadline || Date.now() >= deadline) {
            this.stop(run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
            return;
        }`,
    `        const deadline = run.anchoredUntil ?? run.startedAt + (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
        // The window is "up to two hours": a refresh due exactly at the horizon is not sent.
        if (run.nextWarmAt > deadline || Date.now() >= deadline || (run.anchoredUntil !== undefined && run.nextWarmAt >= deadline)) {
            this.stop(run.anchoredUntil !== undefined
                ? "two hours since the latest user input"
                : run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
            return;
        }`,
    "schedule-deadline",
  );
  next = replaceOnce(
    next,
    `    async refresh(run) {
        run.timer = undefined;
        if (!this.validateRun(run))
            return;`,
    `    async refresh(run) {
        run.timer = undefined;
        if (!this.validateRun(run))
            return;
        // The response to the held request may have compacted since start(); that request is
        // then a dead prefix, and replaying it would compact again.
        if (lastResponseCompacted(this.sessionManager.getBranch())) {
            this.stop("server compaction replaced the prefix");
            return;
        }`,
    "refresh-compaction",
  );
  next = replaceOnce(
    next,
    `            const message = await this.models
                .streamSimple(run.model, run.context, {
                ...run.options,
                maxTokens: 1,
                maxRetries: 0,
                signal: run.controller.signal,
            })
                .result();
            if (!this.validateRun(run))
                return;
            if (message.stopReason !== "error" && message.stopReason !== "aborted") {
                const entry = this.sessionManager.appendUsage("cache_warm", message.provider, message.responseModel ?? message.model, message.usage, extensionOverride ? "extension override" : undefined);
                this.onWarmed?.(entry);
            }`,
    `            const warmController = new AbortController();
            const abortWarm = () => warmController.abort();
            run.controller.signal.addEventListener("abort", abortWarm, { once: true });
            let prefillOnly = false;
            let message;
            try {
                const events = this.models.streamSimple(run.model, run.context, {
                    ...run.options,
                    maxTokens: 1,
                    maxRetries: 0,
                    signal: warmController.signal,
                });
                if (stopsAfterPrefill(run.model)) {
                    for await (const event of events) {
                        if (event.type === "done" || event.type === "error")
                            break;
                        if (event.type !== "start") {
                            prefillOnly = true;
                            warmController.abort();
                            break;
                        }
                    }
                }
                message = await events.result();
            }
            finally {
                run.controller.signal.removeEventListener("abort", abortWarm);
            }
            if (!this.validateRun(run))
                return;
            if (prefillOnly || (message.stopReason !== "error" && message.stopReason !== "aborted")) {
                const note = [extensionOverride ? "extension override" : undefined, prefillOnly ? "stopped after prefill" : undefined]
                    .filter(Boolean).join("; ") || undefined;
                const entry = this.sessionManager.appendUsage("cache_warm", message.provider ?? run.model.provider, message.responseModel ?? message.model ?? run.model.id, message.usage, note);
                this.onWarmed?.(entry);
            }`,
    "refresh",
  );
  return replaceOnce(
    next,
    `        const continuationProbability = run.phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
        const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
        const expectedSavings = continuationProbability * missCost - warmCost;
        return {
            phase: run.phase,
            warmCost,
            missCost,
            continuationProbability,
            expectedSavings,
            economicsAvailable,
            action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
        };`,
    `        const anchored = run.anchoredUntil !== undefined;
        // Inside Rubato's user-anchored window every refresh is sent: the person asked for the
        // cache to be there when they come back, so no continuation guess applies.
        const continuationProbability = anchored || run.phase !== "idle" ? 1 : IDLE_CONTINUATION_PROBABILITY;
        const economicsAvailable = promptTokens > 0 && (anchored || cacheHitCost > 0 || cacheMissCost > 0);
        const expectedSavings = continuationProbability * missCost - warmCost;
        return {
            phase: run.phase,
            warmCost,
            missCost,
            continuationProbability,
            expectedSavings,
            economicsAvailable,
            action: anchored
                ? (promptTokens > 0 ? "warm" : "stop")
                : expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
        };`,
    "economics",
  );
}

/** Warm while idle by default; the person can still pick "off" or "streaming" in settings. */
export function patchSettingsWarmingDefault(source) {
  return replaceOnce(
    source,
    `        return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "streaming";`,
    `        return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "idle";`,
    "settings-default",
  );
}

export const patches = Object.freeze([
  patch("cache-warming:core/cache-warmer.js", "dist/core/cache-warmer.js", "cd488877ddf0bba1489ff6699bd8200ef645a9e6e028110ce675609bbe8fe556", patchCacheWarmer),
  patch("cache-warming:core/settings-manager.js", "dist/core/settings-manager.js", "5368b155ec26d88374cec9e66b8e588b5041a0fb0047414f70b34e13892c4f48", patchSettingsWarmingDefault),
]);
export const files = Object.freeze([]);
export const cacheWarmingFeature = Object.freeze({ id: "cache-warming", patches, files });
export const feature = cacheWarmingFeature;
export default cacheWarmingFeature;
export const sourcePath = fileURLToPath(import.meta.url);
