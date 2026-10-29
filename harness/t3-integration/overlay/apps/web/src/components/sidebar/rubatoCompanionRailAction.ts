/** One companion button's action; an off profile needs no existing conversation. */
export function companionRailAction<Environment extends string, Thread extends string>(
  item: { id: string; settings: { enabled: boolean }; threadId: Thread | null },
  environmentId: Environment | null,
) {
  if (!item.settings.enabled && environmentId !== null)
    return { kind: "enable", companionId: item.id, environmentId } as const;
  if (item.threadId === null || environmentId === null)
    return { kind: "settings", companionId: item.id } as const;
  return { kind: "open", companionId: item.id, environmentId, threadId: item.threadId } as const;
}
