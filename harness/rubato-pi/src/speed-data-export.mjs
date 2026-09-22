/** Allowlisted, pseudonymous wire rows. Never serialize the source sample. */
import { createHmac } from "node:crypto";
import { sanitizeSample } from "./speed-index-store.mjs";

export const SPEED_DATA_VERSION = 1;
export const SPEED_DATA_DISABLED_FILE = "github-sync.disabled";
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/;
const ENUMS = {
  effort: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  effortSource: ["thinkingSelection", "thinkingLevelMap", "options.reasoning", "unknown"],
  requestKind: ["user", "tool", "other"],
  terminalStatus: ["stop", "toolUse", "error", "aborted", "length"],
  networkStatus: ["healthy", "degraded", "unknown", "unsupported"],
  networkSource: ["probe", "server_duration", "undeclared", "unsupported"],
  exclusion: ["aborted", "unknown_effort", "cursor_exec_resolved", "auxiliary_stream"],
};
const NUMBERS = [
  "clientDurationMs", "serverDurationMs", "networkRttMs",
  "newInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "fullInputTokens", "cacheHitRate",
  "streamEventCount", "maxContentGapMs", "firstToolCallEndMs", "lastToolCallEndMs", "toolCallEndCount",
  ...["Text", "Reasoning", "ToolArgument"].flatMap((title) => {
    const prefix = title[0].toLowerCase() + title.slice(1);
    return [`first${title}Ms`, `last${title}Ms`, `${prefix}CodeUnits`, `${prefix}DeltaCount`, `${prefix}MaxGapMs`];
  }),
];

export function pseudonym(secret, namespace, value) {
  return createHmac("sha256", secret).update(`${namespace}\0${value}`).digest("hex");
}

export function exportSpeedSample(raw, { deviceId, secret, recordKey, from, to }) {
  if (typeof deviceId !== "string" || !/^[a-f0-9]{32}$/.test(deviceId) ||
      typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret) || typeof recordKey !== "string") {
    throw new Error("export needs a local random device identity and secret");
  }
  // Old rows cannot answer delivery questions; do not backfill or upload them.
  if (raw?.schemaVersion !== 1 || raw?.epoch !== "v1" || raw?.captureVersion !== 1 || raw?.streamKind !== "main") return undefined;
  const time = typeof raw.at === "string" ? Date.parse(raw.at) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("export needs a finite [from, to) window");
  if (!Number.isFinite(time) || time < from || time >= to) return undefined;
  if (typeof raw.provider !== "string" || !ID.test(raw.provider) || typeof raw.model !== "string" || !ID.test(raw.model)) return undefined;
  const sample = sanitizeSample(raw);
  if (!sample) return undefined;
  if (sample.exclusion !== undefined && !ENUMS.exclusion.includes(sample.exclusion)) return undefined;
  const row = {
    exportVersion: SPEED_DATA_VERSION,
    deviceId,
    recordId: pseudonym(secret, "record", recordKey),
    schemaVersion: 1, epoch: "v1", captureVersion: 1, streamKind: "main",
    // Keep time-block analysis possible without disclosing exact wall times.
    at: new Date(Math.floor(time / 3_600_000) * 3_600_000).toISOString(),
    provider: raw.provider, model: raw.model,
  };
  if (typeof raw.processId === "string" && raw.processId.length > 0) {
    row.processId = pseudonym(secret, "process", raw.processId);
  }
  for (const [key, values] of Object.entries(ENUMS)) if (values.includes(sample[key])) row[key] = sample[key];
  // An unrecognized identity source must not become trusted through omission.
  if (row.effortSource === undefined) row.effortSource = "unknown";
  if (typeof sample.reasoning === "boolean") row.reasoning = sample.reasoning;
  if (typeof sample.streamTerminalObserved === "boolean") row.streamTerminalObserved = sample.streamTerminalObserved;
  for (const key of NUMBERS) {
    const value = sample[key];
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) continue;
    if ((key.endsWith("Count") || key.endsWith("CodeUnits")) && !Number.isSafeInteger(value)) continue;
    if (key === "cacheHitRate" && value > 1) continue;
    row[key] = value;
  }
  for (const key of ["textMilestones", "reasoningMilestones", "toolArgumentMilestones"]) {
    if (Array.isArray(sample[key])) row[key] = sample[key].map((tuple) => [...tuple]);
  }
  return row;
}
