/** Slim stock port of product session-metrics. The product module imports Senpi statusline/TUI. */
function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function collectSessionMetrics(ctx, snapshot = {}, _nowMs = Date.now()) {
  const model = ctx?.model ?? snapshot.model;
  const thinkingLevel = ctx?.thinkingLevel ?? snapshot.thinkingLevel;
  const context = ctx?.getContextUsage?.() ?? snapshot.contextUsage ?? {};
  const usedPercent = finite(context.percent ?? context.usedPercent);
  const windowTokens = finite(context.contextWindow ?? context.windowTokens ?? model?.contextWindow);
  return {
    model: {
      ...(model?.provider ? { provider: model.provider } : {}),
      ...(model?.id ? { id: model.id } : {}),
      label: String(model?.name ?? model?.id ?? "model"),
      ...(thinkingLevel ? { thinkingLevel: String(thinkingLevel) } : {}),
    },
    context: {
      ...(usedPercent === undefined ? {} : { usedPercent, remainingPercent: Math.max(0, 100 - usedPercent) }),
      ...(windowTokens === undefined ? {} : { windowTokens }),
    },
    cache: { expired: false },
  };
}
