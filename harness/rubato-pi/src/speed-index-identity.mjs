/**
 * Call-boundary identity: provider × actually routed model × applied effort.
 * Never reconstructed from footer UI / session thinkingLevel.
 */

const EFFORT_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function resolveAppliedEffort(model, options = {}) {
  const selection = options.thinkingSelection;
  if (typeof selection?.level === "string" && selection.level.length > 0) {
    return {
      effort: selection.level,
      source: "thinkingSelection",
      reasoning: selection.level === "off" ? false : true,
    };
  }
  const requested = options.reasoning;
  const map = model?.thinkingLevelMap;
  if (requested === undefined || requested === null || requested === "off") {
    if (map && Object.prototype.hasOwnProperty.call(map, "off") && map.off === null) {
      return { effort: undefined, source: "unknown", reasoning: "unknown" };
    }
    if (typeof map?.off === "string") {
      return { effort: map.off, source: "thinkingLevelMap", reasoning: false };
    }
    return { effort: "off", source: "options.reasoning", reasoning: false };
  }
  if (map && Object.prototype.hasOwnProperty.call(map, requested)) {
    const mapped = map[requested];
    if (mapped === null) return { effort: undefined, source: "unknown", reasoning: "unknown" };
    if (typeof mapped === "string") {
      return { effort: mapped, source: "thinkingLevelMap", reasoning: true };
    }
  }
  if (!EFFORT_LEVELS.includes(requested)) {
    return { effort: undefined, source: "unknown", reasoning: "unknown" };
  }
  return { effort: requested, source: "options.reasoning", reasoning: true };
}

export function resolveRoutedModelId(model, options = {}) {
  const selection = options.thinkingSelection;
  if (typeof selection?.legacyVariantId === "string" && selection.legacyVariantId.length > 0) {
    return selection.legacyVariantId;
  }
  return model?.id;
}

export function resolveCallIdentity(model, options = {}) {
  const applied = resolveAppliedEffort(model, options);
  return {
    provider: model?.provider,
    model: resolveRoutedModelId(model, options),
    effort: applied.effort,
    effortSource: applied.effort == null ? "unknown" : applied.source,
    reasoning: applied.reasoning,
  };
}

export function hasCursorExecResolved(message, isResolved) {
  if (typeof isResolved !== "function" || !message) return false;
  return (message.content ?? []).some((part) => part?.type === "toolCall" && isResolved(part) === true);
}
