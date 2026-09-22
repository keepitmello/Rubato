/**
 * Offline, experimental delivery-time analysis. Nothing here changes the live
 * Speed score, fits a baseline, writes samples, or contacts a provider.
 */
import * as legacy from "./speed-index.mjs";
import { SPEED_CAPTURE_MILESTONES, SPEED_CAPTURE_VERSION } from "./speed-index-capture.mjs";
import { isSpeedTierKey, speedTierKey } from "./speed-index-tier.mjs";

export const DELIVERY_METRICS = Object.freeze([
  "wait",
  ...["text", "toolArgument"].flatMap((channel) => SPEED_CAPTURE_MILESTONES.map((k) => `${channel}:${k}`)),
]);
const METRICS = [...DELIVERY_METRICS, "reasoning:first", "toolEnd:first", "toolEnd:last"];
const REQUEST_KINDS = ["user", "tool", "other"];
const finiteNonnegative = (value) => Number.isFinite(value) && value >= 0;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const identityOf = (sample) => ({
  provider: sample.provider, model: sample.model, effort: sample.effort, tierKey: speedTierKey(sample),
});
const analysisIdentityKey = (sample) => `${legacy.identityKey(sample)}\0${speedTierKey(sample)}`;

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

function support(rows) {
  const times = rows.map((row) => Date.parse(row.at));
  return {
    calls: rows.length,
    days: new Set(times.map((time) => Math.floor(time / 86_400_000))).size,
    hourBlocks: new Set(times.map((time) => Math.floor(time / 3_600_000))).size,
    processes: new Set(rows.map((row) => row.processId).filter((id) => typeof id === "string" && id)).size,
  };
}

function stats(values) {
  return {
    count: values.length,
    meanMs: values.length ? values.reduce((sum, value) => sum + value / values.length, 0) : null,
    medianMs: legacy.median(values) ?? null,
    p90Ms: legacy.percentile(values, 0.9) ?? null,
  };
}

/** Reuse existing input/cache bands, with request origin as a separate axis. */
export function deliveryCell(sample) {
  if (!REQUEST_KINDS.includes(sample?.requestKind)) return undefined;
  const numericFields = ["newInputTokens", "cacheReadTokens", "cacheWriteTokens", "fullInputTokens", "cacheHitRate"];
  if (numericFields.some((key) => sample[key] !== undefined && !finiteNonnegative(sample[key]))) return undefined;
  if (sample.cacheHitRate > 1) return undefined;
  const cell = legacy.sampleCell(sample);
  if (!cell || !Number.isFinite(cell.hi)) return undefined;
  // The legacy key alone would discard request origin.
  return { ...cell, requestKind: sample.requestKind, key: `${sample.requestKind}:${cell.key}` };
}

function missingReason(sample, channelPresent = false) {
  if (sample.streamEventCount === 0) return "unobserved_stream";
  if (sample.exclusion === "aborted" || sample.terminalStatus === "aborted") return "cancelled_before";
  if (sample.terminalStatus === "error") return "error_before";
  if (!sample.streamTerminalObserved) return "incomplete_stream";
  if (legacy.SCOREABLE_TERMINALS.includes(sample.terminalStatus)) return channelPresent ? "normal_short" : "no_channel";
  return "other_terminal_before";
}

function validMs(sample, value) {
  return finiteNonnegative(value) && value <= sample.clientDurationMs;
}

function channelObservation(sample, prefix) {
  const title = prefix[0].toUpperCase() + prefix.slice(1);
  const first = sample[`first${title}Ms`];
  const last = sample[`last${title}Ms`];
  const units = sample[`${prefix}CodeUnits`];
  const count = sample[`${prefix}DeltaCount`];
  const milestones = sample[`${prefix}Milestones`] ?? [];
  if (first === undefined && last === undefined && units === undefined && count === undefined && milestones.length === 0) {
    return { absent: true };
  }
  if (!validMs(sample, first) || !validMs(sample, last) || first > last ||
      !positiveInteger(units) || !positiveInteger(count) || count > units || !Array.isArray(milestones)) {
    return { invalid: true };
  }
  // Do not repair malformed tuples or interpolate a coarse chunk into a faster
  // crossing. Every reached checkpoint must have its actual delivery event.
  const expected = SPEED_CAPTURE_MILESTONES.filter((target) => target <= units);
  if (milestones.length !== expected.length) return { invalid: true };
  let previousUnits = 0;
  let previousMs = first;
  for (const [index, row] of milestones.entries()) {
    if (!Array.isArray(row) || row.length !== 3) return { invalid: true };
    const [target, actual, ms] = row;
    if (target !== expected[index] || !positiveInteger(actual) || actual < target || actual > units ||
        actual < previousUnits || !validMs(sample, ms) || ms < previousMs || ms > last) return { invalid: true };
    previousUnits = actual;
    previousMs = ms;
  }
  return { first, last, units, milestones };
}

/** Reached events remain valid even when a later event fails or is cancelled. */
export function observeDelivery(sample, metric) {
  if (!METRICS.includes(metric)) throw new Error(`unknown delivery metric: ${metric}`);
  if (sample?.captureVersion !== SPEED_CAPTURE_VERSION) return { missing: "unsupported_capture" };
  if (!finiteNonnegative(sample.clientDurationMs) || !Number.isSafeInteger(sample.streamEventCount) ||
      sample.streamEventCount < 0 || typeof sample.streamTerminalObserved !== "boolean") return { missing: "invalid_capture" };
  if (sample.streamEventCount === 0) return { missing: "unobserved_stream" };

  if (metric.startsWith("toolEnd:")) {
    const first = sample.firstToolCallEndMs;
    const last = sample.lastToolCallEndMs;
    if (first === undefined && last === undefined && sample.toolCallEndCount === undefined) {
      return { missing: missingReason(sample) };
    }
    if (!positiveInteger(sample.toolCallEndCount) || !validMs(sample, first) || !validMs(sample, last) || first > last) {
      return { missing: "invalid_capture" };
    }
    return { ms: metric === "toolEnd:first" ? first : last };
  }
  if (metric === "wait") {
    const channels = ["text", "toolArgument"].map((prefix) => channelObservation(sample, prefix));
    if (channels.some((channel) => channel.invalid)) return { missing: "invalid_capture" };
    const firsts = channels.filter((channel) => !channel.absent).map((channel) => channel.first);
    return firsts.length ? { ms: Math.min(...firsts) } : { missing: missingReason(sample) };
  }
  const [prefix, target] = metric.split(":");
  const channel = channelObservation(sample, prefix);
  if (channel.invalid) return { missing: "invalid_capture" };
  if (channel.absent) return { missing: missingReason(sample) };
  if (target === "first") return { ms: channel.first };
  const tuple = channel.milestones.find(([k]) => k === Number(target));
  if (!tuple) return { missing: missingReason(sample, true) };
  return { ms: tuple[2], afterFirstMs: tuple[2] - channel.first, actualUnits: tuple[1] };
}

function metricSummary(rows, metric) {
  const observed = rows.map((row) => ({ row, observation: observeDelivery(row, metric) }));
  const reached = observed.filter(({ observation }) => observation.ms !== undefined);
  return {
    ...stats(reached.map(({ observation }) => observation.ms)),
    total: rows.length,
    coverage: rows.length ? reached.length / rows.length : 0,
    missing: countBy(observed.filter(({ observation }) => observation.missing).map(({ observation }) => observation.missing)),
    reachedTerminals: countBy(reached.map(({ row }) => terminalOf(row))),
    support: support(reached.map(({ row }) => row)),
    ...(metric.includes(":") && !metric.endsWith("first") && !metric.endsWith("last") ? {
      afterFirst: stats(reached.map(({ observation }) => observation.afterFirstMs)),
      overshootCount: reached.filter(({ observation }) => observation.actualUnits > Number(metric.split(":")[1])).length,
    } : {}),
  };
}

function terminalOf(sample) {
  if (sample.exclusion === "aborted") return "aborted";
  return ["stop", "toolUse", "error", "aborted", "length"].includes(sample.terminalStatus) ? sample.terminalStatus : "other";
}

function summaries(rows) {
  return Object.fromEntries(METRICS.map((metric) => [metric, metricSummary(rows, metric)]));
}

export function speedSampleRejection(sample, from, to) {
  if (!sample || sample.schemaVersion !== legacy.SPEED_INDEX_SCHEMA_VERSION || sample.epoch !== legacy.SPEED_INDEX_EPOCH) return "schema";
  const time = typeof sample.at === "string" ? Date.parse(sample.at) : NaN;
  if (!Number.isFinite(time)) return "timestamp";
  if (time < from || time >= to) return "outside_window";
  if (sample.streamKind !== "main") return "non_main";
  if (!["provider", "model", "effort"].every((key) => typeof sample[key] === "string" && sample[key].length > 0) ||
      sample.effortSource === "unknown") return "identity";
  // Cancellation is not a reason to erase an already reached delivery point.
  if (sample.exclusion && sample.exclusion !== "aborted") return "excluded_stream";
  return undefined;
}

export function validateDeliveryProfile(profile) {
  if (!profile || profile.version !== 1 || typeof profile.id !== "string" || !profile.id ||
      !DELIVERY_METRICS.includes(profile.metric) || !Array.isArray(profile.cells) || !profile.cells.length ||
      !["provider", "model", "effort"].every((key) => typeof profile.reference?.[key] === "string" && profile.reference[key])) {
    throw new Error("profile needs version 1, id, delivery metric, reference identity, and fixed weighted cells");
  }
  const keys = new Set();
  let total = 0;
  for (const cell of profile.cells) {
    if (typeof cell?.key !== "string" || !/^(user|tool|other):\d+:\d+:(lt50|gte50)$/.test(cell.key) ||
        keys.has(cell.key) || !Number.isFinite(cell.weight) || cell.weight <= 0) {
      throw new Error("profile cells need unique request/input/cache keys and positive finite weights");
    }
    keys.add(cell.key);
    total += cell.weight;
  }
  if (Math.abs(total - 1) > 1e-9) throw new Error("profile cell weights must sum to 1; missing cells are never reweighted");
  const tierKey = profile.reference.tierKey ?? "unobserved";
  if (!isSpeedTierKey(tierKey)) throw new Error("profile reference needs a valid observed tier key");
  return {
    version: 1, id: profile.id, metric: profile.metric, reference: { ...identityOf(profile.reference), tierKey },
    cells: profile.cells.map(({ key, weight }) => ({ key, weight })),
  };
}

/** One metric per profile: no arbitrary mixing of first output and delivery. */
export function compareDeliveryProfile(groups, rawProfile) {
  const profile = validateDeliveryProfile(rawProfile);
  function weighted(group) {
    const byKey = new Map((group?.cells ?? []).map((cell) => [cell.key, cell]));
    const cells = profile.cells.map(({ key, weight }) => {
      const metric = byKey.get(key)?.metrics[profile.metric];
      return { key, weight, count: metric?.count ?? 0, total: metric?.total ?? 0,
        coverage: metric?.coverage ?? 0, meanMs: metric?.meanMs ?? null, support: metric?.support ?? support([]) };
    });
    const missing = cells.filter((cell) => cell.count === 0 || cell.meanMs === null).map((cell) => cell.key);
    return { cells, missing, meanMs: missing.length ? null : cells.reduce((sum, cell) => sum + cell.weight * cell.meanMs, 0) };
  }
  const referenceGroup = groups.find((group) => legacy.sameIdentity(group.identity, profile.reference) &&
    group.identity.tierKey === profile.reference.tierKey);
  const reference = weighted(referenceGroup);
  return {
    profile,
    reference,
    results: groups.map((group) => {
      const target = weighted(group);
      const available = reference.meanMs > 0 && target.meanMs > 0;
      return {
        identity: group.identity, ...target,
        status: available ? "experimental" : "unavailable",
        reason: reference.missing.length ? "reference_cells" : target.missing.length ? "target_cells"
          : !available ? "zero_time_resolution" : null,
        index: available ? 100 * reference.meanMs / target.meanMs : null,
      };
    }),
  };
}

export function analyzeSpeedSamples(samples, {
  to = Date.now(),
  from = to - legacy.SAMPLE_WINDOW_MS,
  baseline,
  profile,
} = {}) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("analysis needs a finite, increasing [from, to) window");
  const excluded = [];
  const byIdentity = new Map();
  for (const sample of samples) {
    const reason = speedSampleRejection(sample, from, to);
    if (reason) { excluded.push(reason); continue; }
    const key = analysisIdentityKey(sample);
    const rows = byIdentity.get(key) ?? [];
    rows.push(sample);
    byIdentity.set(key, rows);
  }
  const groups = [...byIdentity].sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => {
    const identity = identityOf(rows[0]);
    const captured = rows.filter((row) => row.captureVersion === SPEED_CAPTURE_VERSION);
    const byCell = new Map();
    for (const row of captured) {
      const cell = deliveryCell(row);
      if (!cell) continue;
      const bucket = byCell.get(cell.key) ?? { cell, rows: [] };
      bucket.rows.push(row);
      byCell.set(cell.key, bucket);
    }
    return {
      identity,
      rows: rows.length,
      captured: captured.length,
      unsupportedCapture: rows.length - captured.length,
      unknownCondition: captured.length - [...byCell.values()].reduce((sum, bucket) => sum + bucket.rows.length, 0),
      support: support(captured),
      terminals: countBy(captured.map(terminalOf)),
      network: countBy(captured.map((row) => ["healthy", "degraded", "unknown"].includes(row.networkStatus) ? row.networkStatus : "unclassified")),
      // Descriptive only: this aggregate still has the model's observed mix.
      metrics: summaries(captured),
      cells: [...byCell].sort(([a], [b]) => a.localeCompare(b)).map(([, bucket]) => ({
        ...bucket.cell, support: support(bucket.rows), metrics: summaries(bucket.rows),
      })),
      legacyReplay: legacy.scoreGroup(rows, identity, baseline, { now: to, windowMs: to - from, cap: Infinity, minMatched: 1 }),
    };
  });
  return {
    analysisVersion: 2,
    mode: "offline_experimental",
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), endExclusive: true },
    inputRows: samples.length,
    excluded: countBy(excluded),
    referenceIdentity: { ...legacy.REFERENCE_IDENTITY },
    legacyReplay: {
      formula: legacy.REFERENCE_PACE ? "output_pace" : "input_cache_baseline",
      scope: "all eligible rows in this window, not the live session or its 200-call cap",
    },
    limitations: [
      "Group metrics are descriptive, not adjusted rankings. Only explicit profiles have fixed condition weights.",
      "Reached-point means are conditional on reaching the point. Coverage and missing reasons are part of the result.",
      "No confidence intervals: calls from one process/hour are not independent observations.",
      "Provider buffering, task content, device/network, and hidden reasoning remain confounded.",
      "Tier keys separate payload requests, weaker declarations, provider-reported service, and uncaptured history.",
      "First/last toolEnd are provider block ends, not tool execution readiness. Reasoning:first is diagnostic only.",
      "No imputation, server-time substitution, degraded-network removal, or throughput extrapolation.",
    ],
    groups,
    comparison: profile ? compareDeliveryProfile(groups, profile) : null,
  };
}
