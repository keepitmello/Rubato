// A requested tier is not proof of the service the provider delivered.
// "unspecified" means we SAW a payload without an override, never inferred a
// normal tier from an old sample that did not capture this metadata.
export const SPEED_TIER_CAPTURE_VERSION = 1;
const TIERS = ["auto", "default", "standard", "priority", "flex", "fast"];
const REQUEST_TIERS = [...TIERS, "unspecified", "unknown", "mixed"];
const SOURCES = ["payload", "options", "model", "unknown"];
export const SPEED_TIER_FIELDS = Object.freeze([
  "tierCaptureVersion", "requestedServiceTier", "servedServiceTier", "tierRequestSource",
]);
const knownTier = (value) => TIERS.includes(value) ? value : undefined;

export function createSpeedTierCapture(model, options) {
  const option = knownTier(options?.serviceTier);
  const inherited = knownTier(model?.serviceTier);
  return {
    tierCaptureVersion: SPEED_TIER_CAPTURE_VERSION,
    requestedServiceTier: option ?? inherited ?? "unknown",
    tierRequestSource: option ? "options" : inherited ? "model" : "unknown",
    servedServiceTier: "unknown",
  };
}

/** Observe the payload AFTER the caller's before-provider-request hook. */
export function observeSpeedRequestTier(capture, payload, model) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const anthropic = model?.provider === "anthropic" || model?.api === "anthropic-messages";
  const raw = anthropic ? payload.speed : payload.service_tier;
  const tier = raw === undefined ? "unspecified" : knownTier(raw) ?? "unknown";
  // Multiple attempts with different final payloads must not become one
  // apparently clean standard/priority sample.
  capture.requestedServiceTier = capture.tierRequestSource === "payload" &&
    capture.requestedServiceTier !== tier ? "mixed" : tier;
  capture.tierRequestSource = "payload";
}

/** Most current adapters omit this response field. Do not guess from cost. */
export function observeSpeedResponseTier(capture, message) {
  const tier = knownTier(message?.serviceTier ?? message?.service_tier);
  if (tier) capture.servedServiceTier = tier;
}

export function sanitizeSpeedTier(raw) {
  if (raw?.tierCaptureVersion !== SPEED_TIER_CAPTURE_VERSION) return {};
  return {
    tierCaptureVersion: SPEED_TIER_CAPTURE_VERSION,
    requestedServiceTier: REQUEST_TIERS.includes(raw.requestedServiceTier) ? raw.requestedServiceTier : "unknown",
    tierRequestSource: SOURCES.includes(raw.tierRequestSource) ? raw.tierRequestSource : "unknown",
    servedServiceTier: knownTier(raw.servedServiceTier) ?? "unknown",
  };
}

/** Full provenance stays in the comparison key; unknown never means normal. */
export function speedTierKey(raw) {
  const tier = sanitizeSpeedTier(raw);
  if (!tier.tierCaptureVersion) return "unobserved";
  return `${tier.tierRequestSource}:${tier.requestedServiceTier}:${tier.servedServiceTier}`;
}

export function isSpeedTierKey(key) {
  if (key === "unobserved") return true;
  if (typeof key !== "string") return false;
  const parts = key.split(":");
  return parts.length === 3 && SOURCES.includes(parts[0]) &&
    REQUEST_TIERS.includes(parts[1]) && [...TIERS, "unknown"].includes(parts[2]);
}
