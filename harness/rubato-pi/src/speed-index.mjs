/**
 * Pure Speed Index math. Scores are derived from samples + an immutable baseline.
 * They are never persisted.
 *
 * Higher is faster. 100 means the group's typical matched call takes as long as
 * the frozen reference cell. The product rewards finishing the same input sooner
 * and does not normalize by output tokens.
 */

export const SPEED_INDEX_METRIC_VERSION = 1;
export const SPEED_INDEX_EPOCH = "v1";
export const SPEED_INDEX_SCHEMA_VERSION = 1;

export const REFERENCE_IDENTITY = Object.freeze({
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  effort: "medium",
});

export const MIN_REFERENCE_CALLS = 500;
export const MIN_CELL_CALLS = 20;
export const MAX_IQR_RATIO = 1;
/**
 * Speed answers "how fast is this model in the current session?". One matched
 * call in this session is a real answer, so the live floor is 1 and there is no
 * 30-day window on the scoring path.
 */
export const MIN_MATCHED_LIVE = 1;
export const MATCHED_CAP = 200;
export const SAMPLE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Baseline origins. v1 is the frozen local reference; v0 is the bundled fallback. */
export const LOCAL_ORIGIN = "local-v1";
export const PROVISIONAL_ORIGIN = "bundled-v0";

export const SCOREABLE_TERMINALS = Object.freeze(["stop", "toolUse"]);
export const MAIN_STREAM_KIND = "main";

export function identityKey({ provider, model, effort } = {}) {
  return `${provider ?? ""}\u0000${model ?? ""}\u0000${effort ?? ""}`;
}

export function sameIdentity(a, b) {
  return identityKey(a) === identityKey(b);
}

export function fullInputTokens(sample) {
  const hasAny = [sample?.newInputTokens, sample?.cacheReadTokens, sample?.cacheWriteTokens]
    .some((value) => Number.isFinite(value) && value >= 0);
  const summed = hasAny
    ? (sample?.newInputTokens ?? 0) + (sample?.cacheReadTokens ?? 0) + (sample?.cacheWriteTokens ?? 0)
    : undefined;
  const reported = Number.isFinite(sample?.fullInputTokens) && sample.fullInputTokens >= 0
    ? sample.fullInputTokens
    : undefined;
  if (summed !== undefined && reported !== undefined) return Math.max(reported, summed);
  return reported ?? summed;
}

export function cacheHitRate(sample) {
  const stored = sample?.cacheHitRate;
  const full = fullInputTokens(sample);
  const read = sample?.cacheReadTokens;
  const recomputed = Number.isFinite(full) && full > 0 && Number.isFinite(read) && read >= 0
    ? Math.min(1, read / full)
    : undefined;
  if (Number.isFinite(stored) && stored >= 0 && stored <= 1) return stored;
  return recomputed;
}

/** Power-of-two half-open band: 8192 is 8–16k (2^13 .. 2^14). */
export function inputBand(tokens) {
  if (!Number.isFinite(tokens) || tokens < 0) return undefined;
  if (tokens < 1) return { lo: 0, hi: 1 };
  const exp = Math.floor(Math.log2(tokens));
  return { lo: 2 ** exp, hi: 2 ** (exp + 1) };
}

export function cacheBand(rate) {
  if (!Number.isFinite(rate) || rate < 0) return undefined;
  return rate < 0.5 ? "lt50" : "gte50";
}

export function cellKey(band, cache) {
  if (!band || !cache) return undefined;
  return `${band.lo}:${band.hi}:${cache}`;
}

export function sampleCell(sample) {
  const band = inputBand(fullInputTokens(sample));
  const cache = cacheBand(cacheHitRate(sample));
  const key = cellKey(band, cache);
  if (!key) return undefined;
  return { key, ...band, cacheBand: cache };
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function iqr(values) {
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  if (q1 === undefined || q3 === undefined) return undefined;
  return q3 - q1;
}

export function mad(values, center = median(values)) {
  if (center === undefined) return undefined;
  return median(values.map((value) => Math.abs(value - center)));
}

export function isScoreableSample(sample) {
  if (!sample || sample.schemaVersion !== SPEED_INDEX_SCHEMA_VERSION) return false;
  if (sample.epoch !== SPEED_INDEX_EPOCH) return false;
  if (sample.streamKind !== MAIN_STREAM_KIND) return false;
  if (!SCOREABLE_TERMINALS.includes(sample.terminalStatus)) return false;
  if (sample.exclusion) return false;
  if (!sample.provider || !sample.model) return false;
  if (sample.effort == null || sample.effort === "" || sample.effortSource === "unknown") return false;
  if (!Number.isFinite(sample.clientDurationMs) || sample.clientDurationMs <= 0) return false;
  if (fullInputTokens(sample) === undefined) return false;
  if (cacheHitRate(sample) === undefined) return false;
  return effectiveDuration(sample) !== undefined;
}

export function effectiveDuration(sample) {
  if (
    sample?.networkSource === "server_duration"
    && Number.isFinite(sample?.serverDurationMs)
    && sample.serverDurationMs > 0
  ) {
    return sample.serverDurationMs;
  }
  if (!Number.isFinite(sample?.clientDurationMs) || sample.clientDurationMs <= 0) return undefined;
  if (sample?.networkStatus === "healthy") return sample.clientDurationMs;
  // Probe warmup has not classified the route yet. That is not a slow path, so the
  // first turns in a session can still paint Speed N. Degraded stays out.
  if (sample?.networkStatus === "unknown" && sample?.networkSource === "probe") {
    return sample.clientDurationMs;
  }
  return undefined;
}

export function isCalibrationCandidate(sample) {
  return isScoreableSample(sample) && sameIdentity(sample, REFERENCE_IDENTITY);
}

/**
 * One schema, two origins. A missing `origin` is a pre-origin local baseline and
 * stays local. Anything else — wrong epoch, wrong reference, torn hash — fails
 * closed to `undefined` so the footer falls back rather than scoring on garbage.
 */
export function validateBaseline(raw, { origin } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (raw.status !== "frozen") return undefined;
  if (raw.version !== SPEED_INDEX_EPOCH) return undefined;
  if (raw.metricVersion !== SPEED_INDEX_METRIC_VERSION) return undefined;
  if (!raw.reference || !sameIdentity(raw.reference, REFERENCE_IDENTITY)) return undefined;
  if (!Array.isArray(raw.cells)) return undefined;
  if (raw.hash !== baselineHash(raw)) return undefined;
  const actual = raw.origin ?? LOCAL_ORIGIN;
  if (actual !== LOCAL_ORIGIN && actual !== PROVISIONAL_ORIGIN) return undefined;
  if (origin !== undefined && actual !== origin) return undefined;
  return raw;
}

export function isProvisionalBaseline(baseline) {
  return baseline?.origin === PROVISIONAL_ORIGIN;
}

export function freezeBaseline(samples, {
  now = () => Date.now(),
  minReferenceCalls = MIN_REFERENCE_CALLS,
  minCellCalls = MIN_CELL_CALLS,
  maxIqrRatio = MAX_IQR_RATIO,
} = {}) {
  const reference = [];
  for (const sample of samples ?? []) {
    if (!isScoreableSample(sample)) continue;
    if (!sameIdentity(sample, REFERENCE_IDENTITY)) continue;
    reference.push(sample);
  }
  if (reference.length < minReferenceCalls) {
    return {
      status: "incomplete",
      reason: "insufficient_reference_calls",
      count: reference.length,
      required: minReferenceCalls,
    };
  }
  const buckets = new Map();
  for (const sample of reference) {
    const cell = sampleCell(sample);
    if (!cell) continue;
    const duration = effectiveDuration(sample);
    if (duration === undefined) continue;
    const rows = buckets.get(cell.key) ?? [];
    rows.push(duration);
    buckets.set(cell.key, rows);
  }
  const cells = [];
  for (const [key, durations] of [...buckets].sort(([a], [b]) => a.localeCompare(b))) {
    const [lo, hi, cache] = key.split(":");
    const cellMedian = median(durations);
    const cellIqr = iqr(durations);
    const ratio = cellMedian > 0 ? cellIqr / cellMedian : Number.POSITIVE_INFINITY;
    const supported = durations.length >= minCellCalls && ratio <= maxIqrRatio;
    cells.push({
      key,
      inputLo: Number(lo),
      inputHi: Number(hi),
      cacheBand: cache,
      count: durations.length,
      medianMs: cellMedian,
      iqrMs: cellIqr,
      iqrRatio: ratio,
      supported,
    });
  }
  const payload = {
    version: SPEED_INDEX_EPOCH,
    metricVersion: SPEED_INDEX_METRIC_VERSION,
    origin: LOCAL_ORIGIN,
    reference: { ...REFERENCE_IDENTITY },
    calibration: {
      count: reference.length,
      at: new Date(now()).toISOString(),
      windowMs: SAMPLE_WINDOW_MS,
    },
    cells,
    supportedCells: cells.filter((cell) => cell.supported).length,
  };
  return {
    status: "frozen",
    ...payload,
    hash: baselineHash(payload),
  };
}

/**
 * Aggregate-only freeze for the bundled v0. Input is `{ durationMs, fullInputTokens,
 * cacheHitRate }` rows already stripped of identity by the offline generator; the
 * output keeps per-cell statistics and never a single row.
 */
export function freezeProvisionalBaseline(rows, {
  now = () => Date.now(),
  origin = PROVISIONAL_ORIGIN,
  minReferenceCalls = MIN_CELL_CALLS,
  minCellCalls = MIN_CELL_CALLS,
  maxIqrRatio = MAX_IQR_RATIO,
} = {}) {
  const buckets = new Map();
  let count = 0;
  for (const row of rows ?? []) {
    const duration = row?.durationMs;
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const cell = sampleCell(row);
    if (!cell) continue;
    count += 1;
    const durations = buckets.get(cell.key) ?? [];
    durations.push(duration);
    buckets.set(cell.key, durations);
  }
  if (count < minReferenceCalls) {
    return { status: "incomplete", reason: "insufficient_reference_calls", count, required: minReferenceCalls };
  }
  const cells = [];
  for (const [key, durations] of [...buckets].sort(([a], [b]) => a.localeCompare(b))) {
    const [lo, hi, cache] = key.split(":");
    const cellMedian = median(durations);
    const cellIqr = iqr(durations);
    const ratio = cellMedian > 0 ? cellIqr / cellMedian : Number.POSITIVE_INFINITY;
    cells.push({
      key,
      inputLo: Number(lo),
      inputHi: Number(hi),
      cacheBand: cache,
      count: durations.length,
      medianMs: cellMedian,
      iqrMs: cellIqr,
      iqrRatio: ratio,
      supported: durations.length >= minCellCalls && ratio <= maxIqrRatio,
    });
  }
  const payload = {
    version: SPEED_INDEX_EPOCH,
    metricVersion: SPEED_INDEX_METRIC_VERSION,
    origin,
    reference: { ...REFERENCE_IDENTITY },
    calibration: {
      count,
      at: new Date(now()).toISOString(),
      provisional: true,
    },
    cells,
    supportedCells: cells.filter((cell) => cell.supported).length,
  };
  return { status: "frozen", ...payload, hash: baselineHash(payload) };
}

export function baselineHash(baseline) {
  const cells = (baseline.cells ?? []).map((cell) => [
    cell.inputLo,
    cell.inputHi,
    cell.cacheBand,
    cell.count,
    cell.medianMs,
    cell.iqrMs,
    cell.supported,
  ]);
  const body = JSON.stringify({
    version: baseline.version,
    metricVersion: baseline.metricVersion,
    reference: baseline.reference,
    origin: baseline.origin ?? LOCAL_ORIGIN,
    cells,
  });
  let hash = 2166136261;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Local v1 wins on cells it actually supports. Bundled v0 keeps covering the
 * input bands a sparse local freeze never measured, so a large-context Claude
 * call is not scored against a 2–8k Sol cell or dropped as unmatched.
 */
export function mergeBaselines(preferred, fallback) {
  const primary = preferred?.status === "frozen" ? preferred : undefined;
  const secondary = fallback?.status === "frozen" ? fallback : undefined;
  if (!primary) return secondary;
  if (!secondary) return primary;
  const byKey = new Map();
  for (const cell of secondary.cells ?? []) byKey.set(cell.key, cell);
  for (const cell of primary.cells ?? []) {
    const current = byKey.get(cell.key);
    // A sparse local freeze must not hide a supported bundled cell behind an
    // unsupported stub of the same key (the 64k Sol cell is count=1 locally).
    if (cell.supported || !current?.supported) byKey.set(cell.key, cell);
  }
  const cells = [...byKey.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return {
    ...primary,
    cells,
    supportedCells: cells.filter((cell) => cell.supported).length,
  };
}

function supportedCellMedian(baseline, key) {
  if (!baseline || baseline.status !== "frozen" || !key) return undefined;
  const match = baseline.cells?.find((entry) => entry.key === key && entry.supported);
  if (!match || !(match.medianMs > 0)) return undefined;
  return match.medianMs;
}

export function referenceDurationFor(sample, baseline, fallbackBaseline) {
  const cell = sampleCell(sample);
  if (!cell) return undefined;
  return supportedCellMedian(baseline, cell.key) ?? supportedCellMedian(fallbackBaseline, cell.key);
}

export function speedRatio(sample, baseline, fallbackBaseline) {
  const reference = referenceDurationFor(sample, baseline, fallbackBaseline);
  const duration = effectiveDuration(sample);
  if (reference === undefined || duration === undefined || duration <= 0) return undefined;
  return reference / duration;
}

function sampleTime(sample, nowMs) {
  const at = Date.parse(sample?.at ?? "");
  return Number.isFinite(at) ? at : nowMs;
}

/**
 * `windowMs: undefined` means "no time window" — the live path already scopes
 * samples to the current session, so age is not a second filter.
 */
export function groupCandidates(samples, identity, { now = Date.now(), windowMs } = {}) {
  const cutoff = windowMs === undefined ? undefined : now - windowMs;
  return (samples ?? []).filter((sample) => (
    isScoreableSample(sample)
    && sameIdentity(sample, identity)
    && (cutoff === undefined || sampleTime(sample, now) >= cutoff)
  ));
}

export function matchedGroupSamples(samples, identity, baseline, options) {
  const candidates = groupCandidates(samples, identity, options);
  const matched = [];
  for (const sample of candidates) {
    const ratio = speedRatio(sample, baseline, options?.fallbackBaseline);
    if (ratio === undefined) continue;
    matched.push({ sample, ratio });
  }
  return { candidates, matched };
}

export function scoreFromRatios(ratios) {
  if (!Array.isArray(ratios) || ratios.length === 0) return undefined;
  const logs = ratios.filter((ratio) => Number.isFinite(ratio) && ratio > 0).map((ratio) => Math.log(ratio));
  if (logs.length === 0) return undefined;
  return Math.round(100 * Math.exp(median(logs)));
}

/**
 * Cached score/status API for later UI. Never scans the filesystem.
 */
export function scoreGroup(samples, identity, baseline, {
  now = Date.now(),
  windowMs,
  cap = MATCHED_CAP,
  minMatched = MIN_MATCHED_LIVE,
  fallbackBaseline,
} = {}) {
  if (!identity?.provider || !identity?.model || identity.effort == null || identity.effort === "") {
    return { status: "unavailable", reason: "identity", score: undefined, matched: 0, valid: 0, coverage: 0 };
  }
  if (!baseline || baseline.status !== "frozen") {
    return { status: "unavailable", reason: "no_baseline", score: undefined, matched: 0, valid: 0, coverage: 0 };
  }
  const { candidates, matched } = matchedGroupSamples(samples, identity, baseline, { now, windowMs, fallbackBaseline });
  const coverage = candidates.length === 0 ? 0 : matched.length / candidates.length;
  const retained = matched
    .sort((a, b) => sampleTime(b.sample, now) - sampleTime(a.sample, now))
    .slice(0, cap);
  if (matched.length < minMatched) {
    return {
      status: "unavailable",
      reason: "samples",
      score: undefined,
      matched: matched.length,
      valid: candidates.length,
      coverage,
    };
  }
  const score = scoreFromRatios(retained.map((row) => row.ratio));
  if (score === undefined) {
    return { status: "unavailable", reason: "samples", score: undefined, matched: matched.length, valid: candidates.length, coverage };
  }
  return { status: "ready", score, matched: matched.length, valid: candidates.length, coverage };
}

export function formatSpeedIndex(result) {
  if (!result || result.status === "unavailable" || result.score == null) {
    return { text: "Speed —", status: "unavailable" };
  }
  return { text: `Speed ${result.score}`, status: "ready" };
}
