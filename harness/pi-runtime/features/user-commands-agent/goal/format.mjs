export function formatGoalElapsedSeconds(value) {
  const seconds = Math.max(0, Math.trunc(value));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 60) return minutes + "m";
  const hours = Math.trunc(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours >= 24) {
    const days = Math.trunc(hours / 24);
    const remainingHours = hours % 24;
    return days + "d " + remainingHours + "h " + remainingMinutes + "m";
  }
  if (remainingMinutes === 0) return hours + "h";
  return hours + "h " + remainingMinutes + "m";
}

export function formatTokensCompact(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (abs >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.trunc(value));
}

export function goalStatusLabel(status) {
  return status;
}

export function formatGoalForTool(goal, wakeSources) {
  if (!goal) return "No active goal is set.";
  const lines = [
    "Objective: " + goal.objective,
    "Status: " + goalStatusLabel(goal.status),
    "Time used: " + formatGoalElapsedSeconds(goal.timeUsedSeconds),
    "Tokens used: " + formatTokensCompact(goal.tokensUsed),
  ];
  if (goal.blockedReason) lines.push("Blocked reason: " + goal.blockedReason);
  const live = Object.entries(wakeSources ?? {}).filter(([, count]) => count > 0);
  if (live.length > 0) {
    lines.push("Wake sources: " + live.map(([source, count]) => source + "=" + count).join(", "));
  }
  return lines.join("\n");
}

