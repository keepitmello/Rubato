// The pure half of companionThreads.ts: which threads a companion's room takes out of the list.
export type ThreadRef = { readonly environmentId: string; readonly id: string };

export function withoutThreads<T extends ThreadRef>(
  threads: ReadonlyArray<T>,
  hidden: ReadonlyArray<{ readonly environmentId: string; readonly threadId: string | null }>,
): ReadonlyArray<T> {
  const keys = new Set(
    hidden.flatMap((item) => (item.threadId ? [`${item.environmentId}\u0000${item.threadId}`] : [])),
  );
  return keys.size === 0
    ? threads
    : threads.filter((thread) => !keys.has(`${thread.environmentId}\u0000${thread.id}`));
}
