export function parseGoalCommand(rawArgs) {
  const trimmed = String(rawArgs ?? "").trim();
  if (trimmed === "") return { kind: "show" };
  switch (trimmed.toLowerCase()) {
    case "pause":
      return { kind: "setStatus", status: "paused" };
    case "resume":
      return { kind: "setStatus", status: "active" };
    case "clear":
      return { kind: "clear" };
    default:
      return { kind: "setObjective", objective: trimmed };
  }
}

