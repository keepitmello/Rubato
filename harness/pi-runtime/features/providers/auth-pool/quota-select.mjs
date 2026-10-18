// Allocate a new session once, in proportion to the pace
// each account can sustain until its next resets. Explicit account choices
// bypass this allocator. Percentages from different windows are normalized by
// window length; the tightest applicable window sets the account's pace.
export function quotaWeight(windows, modelId, now) {
  const family = /claude-(opus|sonnet|haiku|fable)/.exec(modelId ?? "")?.[1];
  const rates = [];
  for (const window of windows ?? []) {
    const scoped = /^seven_day_(.+)$/.exec(window.id ?? "");
    if (scoped && scoped[1] !== family) continue;
    const used = window.usedPercent;
    const reset = Date.parse(window.resetsAt);
    const duration = window.windowDurationMins * 60_000;
    if (typeof used !== "number" || !Number.isFinite(used) || !Number.isFinite(reset)
      || !Number.isFinite(duration) || duration <= 0) continue;
    // A reset that has passed is not still a block, nor proof of unlimited
    // capacity. Use the full-window baseline until a new observation arrives.
    const rate = reset <= now ? 1
      : Math.max(0, 1 - used / 100) * duration / Math.max(60_000, reset - now);
    rates.push(rate);
  }
  return rates.length ? Math.min(...rates) : 1;
}

export function selectQuotaSlot(slots, { usage, modelId, now = Date.now(), random = Math.random } = {}) {
  const weighted = slots.map((slot) => ({
    slot,
    weight: quotaWeight(usage?.[slot.name]?.windows, modelId, now),
  }));
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) throw new Error("All accounts have exhausted their measured quota; wait for the next reset.");
  let draw = random() * total;
  for (const entry of weighted) {
    draw -= entry.weight;
    if (draw < 0 && entry.weight > 0) return entry.slot;
  }
  return weighted.findLast((entry) => entry.weight > 0)?.slot;
}
