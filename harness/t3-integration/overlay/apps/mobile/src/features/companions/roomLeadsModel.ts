import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import type { RoomLaunch } from "./roomModel";

type WorkThread = Pick<EnvironmentThreadShell, "archivedAt" | "deletedAt" | "settledOverride" | "updatedAt">
  & { readonly id: string; readonly environmentId: string };

export function roomWorkSessions(launches: readonly RoomLaunch[]): ReadonlySet<string> {
  const sessions = new Set<string>();
  for (const launch of launches) {
    if (launch.sessionId && !launch.error) sessions.add(launch.sessionId);
  }
  return sessions;
}

/** The transcript tells us who launched it. Only the live thread list can tell us it still belongs here. */
export function roomWorkThreads<T extends WorkThread>(
  threads: readonly T[], environmentId: string, sessions: ReadonlySet<string>, priority: (thread: T) => number,
): T[] {
  if (sessions.size === 0) return [];
  const rows: { thread: T; priority: number }[] = [];
  for (const thread of threads) {
    if (thread.environmentId !== environmentId || thread.archivedAt !== null || thread.deletedAt !== null ||
        thread.settledOverride === "settled" || !thread.id.startsWith("import:")) continue;
    if (sessions.has(thread.id.slice(thread.id.lastIndexOf(":") + 1))) {
      rows.push({ thread, priority: priority(thread) });
    }
  }
  return rows.sort((a, b) => a.priority - b.priority || b.thread.updatedAt.localeCompare(a.thread.updatedAt))
    .map(({ thread }) => thread);
}

export function roomLeadEndStatus(status: string | undefined): "stopped" | "completed" | "failed" | null {
  if (status === "interrupted" || status === "cancelled" || status === "stopped") return "stopped";
  if (status === "completed" || status === "failed") return status;
  return null;
}
