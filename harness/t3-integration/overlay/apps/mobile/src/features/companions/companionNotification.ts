// Where a tap on a companion's message notification goes: that companion's room (route
// CompanionRoom, linking companions/:companionId). The push relay nests the ids under `rubato`
// (kind companion-message), so T3's own notification routing, which reads top-level ids, leaves it
// alone; the app's notification router asks this first.

/** The room link for a companion-message notification's data, or null for any other notification. */
export function companionNotificationLink(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const rubato = (data as { rubato?: unknown }).rubato;
  if (!rubato || typeof rubato !== "object") return null;
  const { kind, companionId, environmentId, threadId } = rubato as Record<string, unknown>;
  if (kind !== "companion-message" || typeof companionId !== "string" || companionId === "") return null;
  const query = new URLSearchParams();
  if (typeof environmentId === "string" && environmentId) query.set("environmentId", environmentId);
  if (typeof threadId === "string" && threadId) query.set("threadId", threadId);
  const search = query.toString();
  return `/companions/${encodeURIComponent(companionId)}${search ? `?${search}` : ""}`;
}
