const USAGE = "Usage: /loop [interval] <prompt>\nExamples:\n  /loop 5m check the deploy\n  /loop check the deploy every 20m\n  /loop stop [id|all]\n  /loop status\n  /loop pause [id|all]\n  /loop resume [id|all]";
const LEADING_INTERVAL_RE = /^\d+[smhd]$/;
const TRAILING_EVERY_RE = /(?:^|\s)every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i;
const LOOP_SUBCOMMANDS = ["stop", "status", "pause", "resume"];

function normalizeUnit(unit) {
  const lower = unit.toLowerCase();
  if (lower.startsWith("s")) return "s";
  if (lower.startsWith("m")) return "m";
  if (lower.startsWith("h")) return "h";
  return "d";
}

function parseIntervalToken(token) {
  return { value: Number.parseInt(token.slice(0, -1), 10), unit: token.slice(-1), raw: token };
}

function parseTarget(rest) {
  const trimmed = rest.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "implicit") return { type: "implicit" };
  if (trimmed.toLowerCase() === "all") return { type: "all" };
  return { type: "id", id: trimmed.split(/\s+/)[0] };
}

function classifyInterval(interval, remaining, originalArgs) {
  if (interval.value === 0) return { kind: "invalid", reason: "Interval amount must be greater than zero.", usage: USAGE };
  const prompt = remaining.trim();
  if (prompt === "") return { kind: "bare", interval, originalArgs };
  return { kind: "fixed", interval, prompt, originalArgs };
}

export function parseLoopArgs(raw) {
  const originalArgs = raw;
  const trimmed = raw.trim();
  if (trimmed !== "") {
    const firstToken = trimmed.split(/\s+/)[0].toLowerCase();
    if (LOOP_SUBCOMMANDS.includes(firstToken)) {
      if (firstToken === "status") return { kind: "status", originalArgs };
      return { kind: firstToken, target: parseTarget(trimmed.slice(firstToken.length)), originalArgs };
    }
  }
  const leadingMatch = /^\s*(\d+[smhd])\b/.exec(raw);
  if (leadingMatch !== null && LEADING_INTERVAL_RE.test(leadingMatch[1] ?? "")) {
    return classifyInterval(parseIntervalToken(leadingMatch[1]), raw.slice(leadingMatch[0].length).trim(), originalArgs);
  }
  const match = TRAILING_EVERY_RE.exec(raw);
  if (match) {
    const interval = { value: Number.parseInt(match[1], 10), unit: normalizeUnit(match[2]), raw: match[1] + normalizeUnit(match[2]) };
    return classifyInterval(interval, raw.slice(0, raw.length - match[0].length).trim(), originalArgs);
  }
  if (trimmed === "") return { kind: "bare", originalArgs };
  return { kind: "dynamic", prompt: trimmed, originalArgs };
}

export function completeLoopArguments(argumentPrefix) {
  const prefix = argumentPrefix.trim().toLowerCase();
  const matches = LOOP_SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(prefix));
  if (matches.length === 0) return null;
  return matches.map((subcommand) => ({ value: subcommand, label: subcommand }));
}

export function intervalToMs(interval) {
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return interval.value * (unitMs[interval.unit] ?? 1000);
}

export const LOOP_ARGUMENT_HINT = "[interval] [prompt] | stop [id|all] | status | pause | resume";
export const LOOP_COMMAND_DESCRIPTION = "Repeat a prompt on a fixed interval or a self-paced schedule (e.g. /loop 5m check the deploy)";

