export function importedWorkSessionId(threadId: string): string | null {
  const index = threadId.lastIndexOf(":");
  return threadId.startsWith("import:") && index > "import".length
    ? threadId.slice(index + 1) || null
    : null;
}

export function withoutCompanionWorkThreads<T extends {
  readonly id: string;
  readonly environmentId: string;
}>(
  threads: readonly T[],
  launches: ReadonlyMap<string, ReadonlySet<string>>,
  show: boolean,
): readonly T[] {
  if (show || launches.size === 0) return threads;
  const visible = threads.filter(({ id, environmentId }) => {
    const sessionId = importedWorkSessionId(id);
    return sessionId === null || !launches.get(environmentId)?.has(sessionId);
  });
  return visible.length === threads.length ? threads : visible;
}
