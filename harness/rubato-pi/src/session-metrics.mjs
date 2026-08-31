import {
  cacheStatus,
  formatModelWithEffort,
  latestAssistantUsage,
  remainingPercent,
  resolveCachePolicy,
  sessionCacheHitPercent,
} from "./statusline.mjs";

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function branchEntries(ctx) {
  return ctx?.sessionManager?.getBranch?.() ?? [];
}

function latestAssistantEntry(entries) {
  const usage = latestAssistantUsage(entries);
  if (!usage) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "assistant" && entry.message.usage === usage) {
      return entry;
    }
  }
  return undefined;
}

export function collectSessionMetrics(ctx, snapshot = {}, nowMs = Date.now()) {
  const entries = branchEntries(ctx);
  const model = ctx?.model ?? snapshot.model;
  const thinkingLevel = ctx?.thinkingLevel ?? snapshot.thinkingLevel;
  const context = ctx?.getContextUsage?.() ?? snapshot.contextUsage ?? {};
  const usedPercent = finite(context.percent ?? context.usedPercent);
  const windowTokens = finite(context.contextWindow ?? context.windowTokens ?? model?.contextWindow);
  const policy = resolveCachePolicy(model);
  const assistantEntry = latestAssistantEntry(entries);
  const observedAt = finite(assistantEntry?.message?.timing?.sentAt ?? assistantEntry?.message?.timestamp);
  const status = cacheStatus(entries, policy, nowMs);
  const hitPercent = sessionCacheHitPercent(entries);
  const expiresAt = policy?.ttlSeconds && policy.kind !== "opaque" && observedAt !== undefined
    ? new Date(observedAt + policy.ttlSeconds * 1000).toISOString()
    : undefined;
  const assistantAt = finite(assistantEntry?.message?.timestamp ?? assistantEntry?.message?.timing?.sentAt);

  return {
    model: {
      ...(model?.provider ? { provider: model.provider } : {}),
      ...(model?.id ? { id: model.id } : {}),
      label: formatModelWithEffort(model?.id, thinkingLevel, model),
      ...(thinkingLevel ? { thinkingLevel: String(thinkingLevel) } : {}),
    },
    context: {
      ...(usedPercent === undefined ? {} : { usedPercent, remainingPercent: remainingPercent(usedPercent) }),
      ...(windowTokens === undefined ? {} : { windowTokens }),
    },
    cache: {
      ...(policy?.kind ? { policy: policy.kind } : {}),
      ...(hitPercent == null ? {} : { hitPercent }),
      ...(expiresAt ? { expiresAt } : {}),
      expired: status?.expired ?? false,
    },
    ...(assistantAt === undefined ? {} : { lastAssistantAt: new Date(assistantAt).toISOString() }),
  };
}
