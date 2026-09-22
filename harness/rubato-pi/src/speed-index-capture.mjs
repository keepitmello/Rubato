// Numeric capture is shared by the recorder and offline/live calculators.
// These versions describe observations, not a scoring formula.
export const SPEED_CAPTURE_VERSION = 1;
export const SPEED_CAPTURE_MILESTONES = Object.freeze([64, 256, 1024, 4096, 16384, 65536]);
const CHANNELS = ["Text", "Reasoning", "ToolArgument"];
const NUMBERS = [
  "streamEventCount", "maxContentGapMs",
  "firstToolCallEndMs", "lastToolCallEndMs", "toolCallEndCount",
  ...CHANNELS.flatMap((channel) => {
    const prefix = channel[0].toLowerCase() + channel.slice(1);
    return [`first${channel}Ms`, `last${channel}Ms`, `${prefix}DeltaCount`, `${prefix}CodeUnits`, `${prefix}MaxGapMs`];
  }),
];
const MILESTONES = ["textMilestones", "reasoningMilestones", "toolArgumentMilestones"];
export const SPEED_CAPTURE_FIELDS = Object.freeze([
  "captureVersion", "requestKind", "streamTerminalObserved", ...NUMBERS, ...MILESTONES,
]);

export function sanitizeCapture(raw) {
  if (raw?.captureVersion !== SPEED_CAPTURE_VERSION) return {};
  const capture = { captureVersion: SPEED_CAPTURE_VERSION };
  if (["user", "tool", "other"].includes(raw.requestKind)) capture.requestKind = raw.requestKind;
  if (typeof raw.streamTerminalObserved === "boolean") capture.streamTerminalObserved = raw.streamTerminalObserved;
  for (const key of NUMBERS) {
    const value = raw[key];
    if (!Number.isFinite(value) || value < 0) continue;
    if ((key.endsWith("Count") || key.endsWith("CodeUnits")) && !Number.isSafeInteger(value)) continue;
    capture[key] = value;
  }
  // Rebuild bounded numeric tuples; never copy nested provider content.
  for (const key of MILESTONES) {
    if (!Array.isArray(raw[key])) continue;
    const rows = [];
    for (const row of raw[key].slice(0, SPEED_CAPTURE_MILESTONES.length)) {
      if (!Array.isArray(row) || row.length !== 3) continue;
      const [target, units, ms] = row;
      if (!SPEED_CAPTURE_MILESTONES.includes(target) || !Number.isSafeInteger(units) || units < target ||
          !Number.isFinite(ms) || ms < 0) continue;
      const previous = rows.at(-1);
      if (previous && (target <= previous[0] || units < previous[1] || ms < previous[2])) continue;
      rows.push([target, units, ms]);
    }
    if (rows.length > 0) capture[key] = rows;
  }
  return capture;
}
