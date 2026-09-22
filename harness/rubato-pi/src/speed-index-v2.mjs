/**
 * One Speed, one frozen time basket. These weights are a product comparison
 * policy, not a fitted preference or a claim about real workload frequency.
 * No missing-cell renormalization, tail trimming, or uncertainty penalty.
 */
import { createHash } from "node:crypto";
import { deliveryCell, observeDelivery, speedSampleRejection } from "./speed-analysis.mjs";
import { identityKey, SAMPLE_WINDOW_MS } from "./speed-index.mjs";
import { isSpeedTierKey, speedTierKey } from "./speed-index-tier.mjs";

export const SPEED_V2_METRIC_VERSION = 2;
export const SPEED_V2_PROFILE_FILE = "profile-v2.json";
export const SPEED_V2_BLOCK_MS = 86_400_000;
export const SPEED_V2_BASKET = Object.freeze([
  Object.freeze({ metric: "wait", weight: 0.5 }),
  Object.freeze({ metric: "text:256", weight: 0.25 }),
  Object.freeze({ metric: "toolArgument:256", weight: 0.25 }),
]);
export const SPEED_V2_REFERENCE = Object.freeze({
  provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium",
  // An observed request without an override. NOT a claim of confirmed service.
  tierKey: "payload:unspecified:unknown",
});

export function speedV2Identity(sample) {
  return { provider: sample?.provider, model: sample?.model, effort: sample?.effort, tierKey: speedTierKey(sample) };
}
export function speedV2IdentityKey(identity) {
  return `${identityKey(identity)}\0${identity?.tierKey ?? speedTierKey(identity)}`;
}
export function speedDeviceKey(row) {
  return typeof row.deviceId === "string" && /^[a-f0-9]{32}$/.test(row.deviceId) ? row.deviceId : "local";
}
const cellId = (device, condition) => `${device}\0${condition}`;
const mean = (values) => values.reduce((sum, value) => sum + value / values.length, 0);
const sumIsOne = (values) => Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-9;
const comparableTier = (key) => isSpeedTierKey(key) && key.startsWith("payload:") &&
  !["unknown", "mixed"].includes(key.split(":")[1]);

function profileHash(profile) {
  const { hash, ...body } = profile;
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** A registered profile is a numeric artifact, never imported executable code. */
export function validateSpeedV2Profile(raw) {
  if (!raw || raw.version !== 2 || raw.metricVersion !== SPEED_V2_METRIC_VERSION ||
      typeof raw.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(raw.id) ||
      raw.blockMs !== SPEED_V2_BLOCK_MS ||
      raw.windowMs !== SAMPLE_WINDOW_MS ||
      !["provider", "model", "effort"].every((key) => typeof raw.reference?.[key] === "string" && raw.reference[key]) ||
      !comparableTier(raw.reference.tierKey) ||
      !Array.isArray(raw.devices) || !raw.devices.length || new Set(raw.devices).size !== raw.devices.length ||
      !raw.devices.every((id) => id === "local" || (typeof id === "string" && /^[a-f0-9]{32}$/.test(id))) ||
      !Array.isArray(raw.components) || raw.components.length !== SPEED_V2_BASKET.length ||
      !(raw.referenceTimeMs > 0) || !Number.isFinite(raw.referenceTimeMs) ||
      raw.hash !== profileHash(raw)) return undefined;
  let referenceTime = 0;
  for (const [index, component] of raw.components.entries()) {
    const policy = SPEED_V2_BASKET[index];
    if (!component || typeof component !== "object" ||
        component.metric !== policy.metric || component.weight !== policy.weight ||
        !Array.isArray(component.cells) || !component.cells.length) return undefined;
    const keys = new Set();
    for (const cell of component.cells) {
      if (!cell || typeof cell !== "object") return undefined;
      const key = cellId(cell.device, cell.condition);
      if (keys.has(key) || !raw.devices.includes(cell.device) ||
          !/^(user|tool):\d+:\d+:(lt50|gte50)$/.test(cell.condition) ||
          !(cell.weight > 0) || !Number.isFinite(cell.weight) ||
          !Number.isFinite(cell.referenceMeanMs) || cell.referenceMeanMs < 0 ||
          !Number.isSafeInteger(cell.referenceCount) || cell.referenceCount < 2 ||
          !Number.isSafeInteger(cell.referenceBlocks) || cell.referenceBlocks < 2 ||
          cell.referenceBlocks > cell.referenceCount) return undefined;
      keys.add(key);
      referenceTime += component.weight * cell.weight * cell.referenceMeanMs;
    }
    if (!sumIsOne(component.cells.map((cell) => cell.weight))) return undefined;
    for (const device of raw.devices) {
      const cells = component.cells.filter((cell) => cell.device === device);
      if (!cells.length) return undefined;
      // Every component is a fixed user/tool pair. A registered profile that
      // lost one role would score a different basket than the reference names,
      // so validation enforces the same shape registration does.
      const roles = new Set(cells.map((cell) => cell.condition.split(":")[0]));
      if (roles.size !== 2 || !roles.has("user") || !roles.has("tool")) return undefined;
    }
  }
  if (Math.abs(referenceTime - raw.referenceTimeMs) > 1e-9 * Math.max(1, referenceTime)) return undefined;
  return raw;
}

function eligibleRows(samples, identity, from, to) {
  if (!comparableTier(identity?.tierKey)) return [];
  const key = speedV2IdentityKey(identity);
  return samples.filter((row) => !speedSampleRejection(row, from, to) &&
    ["user", "tool"].includes(row.requestKind) && row.captureVersion === 1 &&
    speedV2IdentityKey(speedV2Identity(row)) === key);
}

// Blocks are UTC calendar days of the observation itself, so an hour-floored
// exported timestamp falls in exactly the same block as the raw one. A block
// origin taken from the first sample would shift every exported row.
const blockOf = (row) => Math.floor(Date.parse(row.at) / SPEED_V2_BLOCK_MS);

function observations(rows, metric) {
  const byCell = new Map();
  for (const row of rows) {
    const condition = deliveryCell(row)?.key;
    if (!condition) continue;
    const observation = observeDelivery(row, metric);
    const device = speedDeviceKey(row);
    const key = cellId(device, condition);
    const cell = byCell.get(key) ?? { device, condition, values: [], missing: {}, total: 0 };
    cell.total += 1;
    if (observation.ms !== undefined) {
      cell.values.push({ ms: observation.ms, block: blockOf(row) });
    } else cell.missing[observation.missing] = (cell.missing[observation.missing] ?? 0) + 1;
    byCell.set(key, cell);
  }
  return byCell;
}

function evaluate(rows, components) {
  const missing = [];
  const weak = [];
  const blocks = new Set();
  const cells = [];
  let timeMs = 0;
  let matched = 0;
  let total = 0;
  for (const component of components) {
    const observed = observations(rows, component.metric);
    for (const expected of component.cells) {
      const cell = observed.get(cellId(expected.device, expected.condition));
      const values = cell?.values ?? [];
      const cellBlocks = new Set(values.map((value) => value.block));
      const weight = component.weight * expected.weight;
      const name = `${component.metric}/${expected.device}/${expected.condition}`;
      if (!values.length) missing.push(name);
      else if (cellBlocks.size < 2) weak.push(name);
      for (const block of cellBlocks) blocks.add(block);
      const meanMs = values.length ? mean(values.map((value) => value.ms)) : null;
      if (meanMs !== null) timeMs += weight * meanMs;
      matched += values.length;
      total += cell?.total ?? 0;
      cells.push({ metric: component.metric, device: expected.device, condition: expected.condition,
        weight, meanMs, count: values.length, total: cell?.total ?? 0,
        blocks: cellBlocks.size, missing: cell?.missing ?? {}, values });
    }
  }
  // Each cell must survive removal of any one whole time block. Two blocks is
  // a structural consequence of that test, not "two days proves confidence".
  const sensitivity = [];
  if (!missing.length && !weak.length) {
    for (const block of [...blocks].sort((a, b) => a - b)) {
      const without = cells.reduce((sum, cell) => sum + cell.weight *
        mean(cell.values.filter((value) => value.block !== block).map((value) => value.ms)), 0);
      sensitivity.push({ omittedBlock: block, timeMs: without });
    }
  }
  return {
    timeMs: missing.length ? null : timeMs, missing, weak, matched, total,
    blocks: blocks.size,
    cells: cells.map(({ values, ...cell }) => cell),
    sensitivity,
  };
}

/**
 * Register only from the reference, never from the intersection of target
 * models. Equal devices -> equal observed roles -> equal input/cache cells.
 * Missing text/tool observations cannot silently remove a component.
 */
export function prepareSpeedV2Profile(samples, {
  id = "delivery-basket-v2",
  reference = SPEED_V2_REFERENCE,
  to = Date.now(), from = to - SAMPLE_WINDOW_MS,
  devices,
} = {}) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("profile needs an increasing time window");
  const rows = eligibleRows(samples, reference, from, to);
  const registered = [...new Set(devices ?? rows.map(speedDeviceKey))].sort();
  if (!registered.length || !rows.length) return { status: "unavailable", reason: "reference_samples", profile: null };
  const components = [];
  for (const policy of SPEED_V2_BASKET) {
    const observed = [...observations(rows, policy.metric).values()].filter((cell) => cell.values.length);
    const cells = [];
    for (const device of registered) {
      const matching = observed.filter((cell) => cell.device === device);
      const roles = [...new Set(matching.map((cell) => cell.condition.split(":")[0]))].sort();
      // Every component is fixed as a user/tool pair. A role we never observed
      // cannot be dropped and its weight handed to the other role: that would
      // freeze a different basket than the one the reference describes.
      if (roles.length !== 2 || roles[0] !== "tool" || roles[1] !== "user") {
        return { status: "unavailable", reason: "reference_roles", metric: policy.metric, device, roles, profile: null };
      }
      for (const role of roles) {
        const roleCells = matching.filter((cell) => cell.condition.startsWith(`${role}:`)).sort((a, b) => a.condition.localeCompare(b.condition));
        for (const cell of roleCells) {
          cells.push({
            device, condition: cell.condition, weight: 1 / registered.length / roles.length / roleCells.length,
            referenceMeanMs: mean(cell.values.map((value) => value.ms)),
            referenceCount: cell.values.length,
            referenceBlocks: new Set(cell.values.map((value) => value.block)).size,
          });
        }
      }
    }
    components.push({ ...policy, cells });
  }
  const checked = evaluate(rows, components);
  if (checked.missing.length || checked.weak.length || !(checked.timeMs > 0)) {
    return { status: "unavailable", reason: checked.weak.length ? "reference_blocks" : "reference_time", profile: null, diagnostics: checked };
  }
  const body = {
    version: 2, metricVersion: SPEED_V2_METRIC_VERSION, id,
    reference: { provider: reference.provider, model: reference.model, effort: reference.effort, tierKey: reference.tierKey },
    referenceWindow: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    windowMs: SAMPLE_WINDOW_MS, blockMs: SPEED_V2_BLOCK_MS,
    devices: registered, components, referenceTimeMs: checked.timeMs,
  };
  const profile = { ...body, hash: profileHash(body) };
  if (!validateSpeedV2Profile(profile)) throw new Error("invalid reference profile");
  return { status: "ready", profile, diagnostics: checked };
}

/** One point estimate or unavailable. Sensitivity never discounts the score. */
export function scoreSpeedV2(samples, identity, rawProfile, { now = Date.now() } = {}) {
  const unavailable = (reason, extra = {}) => ({
    metricVersion: SPEED_V2_METRIC_VERSION, status: "unavailable", reason,
    score: undefined, matched: 0, valid: 0, coverage: 0, ...extra,
  });
  const profile = validateSpeedV2Profile(rawProfile);
  if (!profile) return unavailable("no_profile");
  if (!Number.isFinite(now)) return unavailable("clock");
  if (!comparableTier(identity?.tierKey)) return unavailable("unobserved_tier", { profileId: profile.id });
  const rows = eligibleRows(samples, identity, now - profile.windowMs, now);
  const checked = evaluate(rows, profile.components);
  const extra = {
    profileId: profile.id, profileHash: profile.hash,
    observedThrough: new Date(now).toISOString(),
    matched: checked.matched, valid: checked.total,
    coverage: checked.total ? checked.matched / checked.total : 0,
    diagnostics: checked,
  };
  if (checked.missing.length) return unavailable("target_cells", extra);
  if (checked.weak.length) return unavailable("target_blocks", extra);
  if (!(checked.timeMs > 0)) return unavailable("zero_time_resolution", extra);
  const score = Math.round(100 * profile.referenceTimeMs / checked.timeMs);
  if (!Number.isSafeInteger(score) || score < 0) return unavailable("numeric_range", extra);
  return { ...extra, metricVersion: SPEED_V2_METRIC_VERSION, status: "ready", score };
}
