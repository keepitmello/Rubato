// Side chats (the right panel's Side chat; apps/server/src/RubatoSideChat.ts) are threads the
// server makes for one tab and deletes when it closes. They must never show where threads are
// listed, so the client's shell (the thread list every sidebar, search and notification reads)
// leaves them out. Their detail subscription is separate and still draws the panel.

/** Side chat threads carry this prefix; nothing else may. */
export const SIDE_CHAT_THREAD_PREFIX = "side-chat:";

export function isSideChatThreadId(threadId: string): boolean {
  return threadId.startsWith(SIDE_CHAT_THREAD_PREFIX) && threadId.length > SIDE_CHAT_THREAD_PREFIX.length;
}

type ShellThreads = { readonly id: string };

/** The snapshot without side chat threads; the same object when it has none. */
export function withoutSideChats<
  T extends { readonly threads: ReadonlyArray<ShellThreads>; readonly archivedThreads?: ReadonlyArray<ShellThreads> },
>(snapshot: T): T {
  const hidden = (threads: ReadonlyArray<ShellThreads> | undefined) =>
    threads?.some((thread) => isSideChatThreadId(thread.id)) ?? false;
  if (!hidden(snapshot.threads) && !hidden(snapshot.archivedThreads)) return snapshot;
  return {
    ...snapshot,
    threads: snapshot.threads.filter((thread) => !isSideChatThreadId(thread.id)),
    ...(snapshot.archivedThreads
      ? { archivedThreads: snapshot.archivedThreads.filter((thread) => !isSideChatThreadId(thread.id)) }
      : {}),
  };
}

/** A shell event that would put a side chat into the thread list. */
export function addsSideChat(event: { readonly kind: string; readonly thread?: { readonly id: string } }): boolean {
  return event.kind === "thread.updated" && event.thread !== undefined && isSideChatThreadId(event.thread.id);
}
