import type { RoomLaunch } from "./roomModel";

export function roomLeadRows(launches: readonly RoomLaunch[]) {
  const seen = new Set<string>();
  // Hermes on iOS does not provide Array.prototype.toSorted.
  return [...launches].sort((a, b) => b.at - a.at).filter((launch) => {
    if (launch.error || (!launch.sessionId && launch.done !== null)) return false;
    const key = launch.sessionId ?? launch.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function roomLeadEndStatus(status: string | undefined): "stopped" | "completed" | "failed" | null {
  if (status === "interrupted" || status === "cancelled" || status === "stopped") return "stopped";
  if (status === "completed" || status === "failed") return status;
  return null;
}
