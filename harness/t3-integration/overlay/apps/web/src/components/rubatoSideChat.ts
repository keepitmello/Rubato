import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

import { readThread } from "~/state/entities";
import { rubatoHttpAccess } from "~/state/rubatoHttp";
import { readPreparedConnection } from "~/state/session";

// The right panel's Side chat: forks of the thread's conversation, opened beside it. The server
// half is /rubato/side-chat (RubatoSideChat.ts); the panel is RubatoSideChatPanel.tsx, which
// lists the thread's side chats and opens one. A side chat stays until it is deleted from the
// panel or its thread is deleted; one that was never asked anything is deleted when you leave it.

const OPEN_ROUTE = "/rubato/side-chat";
const LIST_ROUTE = "/rubato/side-chat/list";
const CLOSE_ROUTE = "/rubato/side-chat/close";

export interface SideChatEntry {
  readonly threadId: string;
  readonly createdAt: string;
}

export const sideChatRef = (environmentId: EnvironmentId, threadId: string): ScopedThreadRef =>
  scopeThreadRef(environmentId, ThreadId.make(threadId));

type SideChatSource = {
  readonly latestTurn: unknown;
  readonly messages: ReadonlyArray<unknown>;
};

/**
 * A side chat copies a conversation; a thread that never ran has none to copy. A thread imported
 * from the engine has its messages but no T3 turn yet.
 */
export function sideChatSourceReady(thread: SideChatSource | null, runsOnRubato: boolean): boolean {
  return runsOnRubato && thread !== null && (thread.latestTurn !== null || thread.messages.length > 0);
}

async function post<T>(ref: ScopedThreadRef, route: string): Promise<T> {
  const prepared = readPreparedConnection(ref.environmentId);
  if (!prepared) throw new Error("This Mac is not connected.");
  const access = await rubatoHttpAccess(prepared);
  if (!access) throw new Error("Side chat is not available on this connection.");
  const response = await fetch(`${access.baseUrl}${route}`, {
    method: "POST",
    credentials: access.credentials,
    headers: { ...access.headers, "content-type": "application/json" },
    body: JSON.stringify({ threadId: ref.threadId }),
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!response.ok || payload === null) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload;
}

/** Forks `owner`'s conversation into a new side chat and answers with its thread. */
export async function createSideChat(owner: ScopedThreadRef): Promise<ScopedThreadRef> {
  const { threadId } = await post<{ threadId?: string }>(owner, OPEN_ROUTE);
  if (!threadId) throw new Error("Rubato made no side chat.");
  return sideChatRef(owner.environmentId, threadId);
}

/** `owner`'s side chats, newest first. */
export async function listSideChats(owner: ScopedThreadRef): Promise<ReadonlyArray<SideChatEntry>> {
  return (await post<{ sideChats?: ReadonlyArray<SideChatEntry> }>(owner, LIST_ROUTE)).sideChats ?? [];
}

export async function deleteSideChat(side: ScopedThreadRef): Promise<void> {
  await post(side, CLOSE_ROUTE);
}

/** A side chat nobody asked anything is not worth keeping. Unknown (not loaded) is kept. */
export function sideChatIsEmpty(thread: { readonly messages: ReadonlyArray<unknown> } | null): boolean {
  return thread !== null && thread.messages.length === 0;
}

/** Leaving a side chat that was never used deletes it, so the list holds only real ones. */
export function deleteSideChatIfEmpty(side: ScopedThreadRef): void {
  if (sideChatIsEmpty(readThread(side))) void deleteSideChat(side).catch(() => undefined);
}
