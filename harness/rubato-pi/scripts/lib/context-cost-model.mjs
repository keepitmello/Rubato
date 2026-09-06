// Offline accounting only. No imports from providers, no network, no model calls.
// A counterfactual replay fixes productive work and varies memory overhead.
// It is not a predictor of future retrieval choices or task quality.
export function number(value, name, min = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new Error(`${name}: ${min} 이상의 유한한 숫자가 필요해요.`);
  return value;
}
export function fraction(value, name) {
  number(value, name);
  if (value > 1) throw new Error(`${name}: 0~1 사이여야 해요.`);
  return value;
}
export function priceUsage(usage, prices) {
  for (const key of ["input", "cacheRead", "cacheWrite", "output"]) number(usage[key], key);
  const oneHour = number(usage.cacheWrite1h ?? 0, "cacheWrite1h");
  if (oneHour > usage.cacheWrite) throw new Error("1시간 캐시 쓰기는 전체 캐시 쓰기의 부분집합이어야 해요.");
  const inputTotal = usage.input + usage.cacheRead + usage.cacheWrite;
  const long = prices.longThreshold !== undefined && inputTotal > number(prices.longThreshold, "price.longThreshold", 1);
  const inputMultiplier = long ? number(prices.longInputMultiplier, "price.longInputMultiplier", 1) : 1;
  const outputMultiplier = long ? number(prices.longOutputMultiplier, "price.longOutputMultiplier", 1) : 1;
  const parts = {
    input: usage.input * number(prices.input, "price.input") * inputMultiplier / 1e6,
    cacheRead: usage.cacheRead * number(prices.cacheRead, "price.cacheRead") * inputMultiplier / 1e6,
    cacheWrite: ((usage.cacheWrite - oneHour) * number(prices.cacheWrite, "price.cacheWrite") +
      (oneHour ? oneHour * number(prices.cacheWrite1h, "price.cacheWrite1h") : 0)) * inputMultiplier / 1e6,
    output: usage.output * number(prices.output, "price.output") * outputMultiplier / 1e6,
  };
  return { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0), longContext: long };
}

export function simulate(trace, options, prices) {
  if (!Array.isArray(trace?.calls) || trace.calls.length === 0) throw new Error("계산할 모델 요청이 없어요.");
  const defaults = {
    mode: "summary", thresholdTokens: 244800, contextWindowTokens: 272000,
    staticTokens: 8000, historyStaticExtraTokens: 1200, retainedRecentTokens: 0,
    summaryTokens: 5000, summaryOutputTokens: 5000, checkpointTokens: 2000, checkpointOutputTokens: 2000,
    bootstrapTokens: 400, instructionTokens: 128, toolResultOverheadTokens: 80,
    managementOutputTokens: 128, checkpointExtraCalls: 1, resumeNoteCalls: 1,
    retrievalTokens: 0, retrievalCalls: 0, summaryRetrievalTokens: 0, summaryRetrievalCalls: 0,
    summaryCacheHitFraction: 1, cacheHitFraction: 1, staticReuseFraction: 1,
    cacheTtlMs: 300000, extraCallMs: 10000, cacheWrite1h: false, writeMisses: true,
    growthMultiplier: 1,
  };
  for (const key of Object.keys(options ?? {})) if (key !== "name" && !(key in defaults)) throw new Error(`알 수 없는 계산 설정이에요: ${key}`);
  const c = { ...defaults, ...options };
  for (const key of ["writeMisses", "cacheWrite1h"]) if (typeof c[key] !== "boolean") throw new Error(`${key}: 참 또는 거짓이어야 해요.`);
  if (!["summary", "history-notes"].includes(c.mode)) throw new Error("mode가 올바르지 않아요.");
  for (const [key, value] of Object.entries(c)) if (typeof defaults[key] === "number") number(value, key);
  for (const key of ["cacheHitFraction", "summaryCacheHitFraction", "staticReuseFraction"]) fraction(c[key], key);
  for (const key of ["checkpointExtraCalls", "resumeNoteCalls", "retrievalCalls", "summaryRetrievalCalls"]) {
    if (!Number.isInteger(c[key])) throw new Error(`${key}: 정수가 필요해요.`);
  }
  if (c.growthMultiplier <= 0 || c.thresholdTokens <= 0 || c.contextWindowTokens <= 0) throw new Error("문맥 한도와 배율은 양수여야 해요.");
  if (c.thresholdTokens > c.contextWindowTokens) throw new Error("실험 임계점이 물리적 문맥 한도보다 커요.");
  if (c.mode === "history-notes" && c.resumeNoteCalls < 1) throw new Error("이 구현은 전환 후 노트를 읽어야 하므로 resumeNoteCalls는 1 이상이어야 해요.");
  if ((c.retrievalTokens > 0 && c.retrievalCalls === 0) || (c.summaryRetrievalTokens > 0 && c.summaryRetrievalCalls === 0)) {
    throw new Error("원문 재입력량이 있으면 검색 요청 횟수도 지정해 주세요.");
  }
  const fixed = c.staticTokens + (c.mode === "history-notes" ? c.historyStaticExtraTokens : 0);
  let context = fixed, cachedPrefix = 0, time = 0, lastRequest = -Infinity, workInWindow = 0;
  const ledger = [];
  let transitions = 0;
  function charge(kind, added, output, hitFraction = c.cacheHitFraction, contextOutput = 0) {
    context += added;
    if (context > c.contextWindowTokens) throw new Error(`${kind}: 입력이 물리적 문맥 한도를 넘어요 (${Math.ceil(context)}).`);
    const warm = time - lastRequest < c.cacheTtlMs;
    const read = warm ? Math.min(context, cachedPrefix) * hitFraction : 0;
    const misses = context - read;
    const usage = { input: c.writeMisses ? 0 : misses, cacheRead: read,
      cacheWrite: c.writeMisses ? misses : 0, cacheWrite1h: c.writeMisses && c.cacheWrite1h ? misses : 0, output };
    const cost = priceUsage(usage, prices);
    ledger.push({ kind, timeMs: time, contextTokens: context, ...usage, costUSD: cost.total });
    cachedPrefix = context; lastRequest = time; context += contextOutput;
    if (kind !== "productive") time += c.extraCallMs;
  }
  function restoreHistory(tokens, calls) {
    for (let n = 0; n < calls; n++) {
      charge("history_lookup", 0, c.managementOutputTokens, c.cacheHitFraction, c.managementOutputTokens);
      context += tokens / calls + c.toolResultOverheadTokens;
    }
  }
  function transition() {
    if (c.mode === "summary") {
      charge("summary_generation", c.instructionTokens, c.summaryOutputTokens, c.summaryCacheHitFraction);
    } else {
      charge("checkpoint_generation", c.instructionTokens, c.checkpointOutputTokens, c.cacheHitFraction, c.checkpointTokens);
      for (let n = 0; n < c.checkpointExtraCalls; n++) {
        charge("checkpoint_tool_round", c.toolResultOverheadTokens, c.managementOutputTokens, c.cacheHitFraction, c.managementOutputTokens);
      }
    }
    context = fixed + (c.mode === "summary" ? c.summaryTokens + c.retainedRecentTokens : c.bootstrapTokens);
    // This is an explicit reuse assumption, not a guarantee by any provider.
    cachedPrefix = Math.min(cachedPrefix, fixed) * c.staticReuseFraction;
    transitions++; workInWindow = 0;
    if (c.mode === "history-notes") {
      for (let n = 0; n < c.resumeNoteCalls; n++) {
        charge("note_lookup", 0, c.managementOutputTokens, c.cacheHitFraction, c.managementOutputTokens);
        context += c.checkpointTokens / c.resumeNoteCalls + c.toolResultOverheadTokens;
      }
      restoreHistory(c.retrievalTokens, c.retrievalCalls);
    } else restoreHistory(c.summaryRetrievalTokens, c.summaryRetrievalCalls);
  }
  for (const call of trace.calls) {
    const growth = number(call.newTokens, "call.newTokens") * c.growthMultiplier;
    time += number(call.gapMs ?? 0, "call.gapMs");
    if (context + growth >= c.thresholdTokens && workInWindow > 0) transition();
    if (context + growth >= c.thresholdTokens) throw new Error("전환 후에도 다음 작업이 실험 한도에 들어가지 않아요. 해당 후보는 유효하지 않아요.");
    charge("productive", growth, number(call.outputTokens, "call.outputTokens"));
    workInWindow++;
  }
  // No forced final compaction: all candidates finish the same productive work.
  const byKind = {};
  for (const row of ledger) byKind[row.kind] = (byKind[row.kind] ?? 0) + row.costUSD;
  const sum = key => ledger.reduce((a, x) => a + x[key], 0);
  return { mode: c.mode, thresholdTokens: c.thresholdTokens, transitions, productiveCalls: trace.calls.length,
    totalCalls: ledger.length, totalCostUSD: sum("costUSD"), inputTokens: sum("input"), cacheReadTokens: sum("cacheRead"),
    cacheWriteTokens: sum("cacheWrite"), outputTokens: sum("output"), costByKind: byKind, assumptions: c };
}
