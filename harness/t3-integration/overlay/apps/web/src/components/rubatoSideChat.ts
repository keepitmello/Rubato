import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

import { rubatoHttpAccess } from "~/state/rubatoHttp";
import { readPreparedConnection } from "~/state/session";
import { useRightPanelStore, type ThreadRightPanelState } from "../rightPanelStore";

// The right panel's Side chat: a throwaway fork of the thread's conversation beside it. The
// server half is /rubato/side-chat (RubatoSideChat.ts); the panel is RubatoSideChatPanel.tsx.
// A side chat lives exactly as long as its tab: whichever way the tab goes (its ✕, Close
// others, Close all, the thread's panel being dropped), the watcher below deletes it.

const OPEN_ROUTE = "/rubato/side-chat";
const CLOSE_ROUTE = "/rubato/side-chat/close";

export type SideChatSurfaceId = `side-chat:${string}`;
export const sideChatSurfaceId = (threadId: string): SideChatSurfaceId => `side-chat:${threadId}`;

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

async function post(environmentId: EnvironmentId, route: string, threadId: string) {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("This Mac is not connected.");
  const access = await rubatoHttpAccess(prepared);
  if (!access) throw new Error("Side chat is not available on this connection.");
  const response = await fetch(`${access.baseUrl}${route}`, {
    method: "POST",
    credentials: access.credentials,
    headers: { ...access.headers, "content-type": "application/json" },
    body: JSON.stringify({ threadId }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { threadId?: string; error?: { message?: string } }
    | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload;
}

/** Forks `ref`'s conversation into a side chat and answers with the side chat's thread. */
export async function openSideChat(ref: ScopedThreadRef): Promise<ScopedThreadRef> {
  const payload = await post(ref.environmentId, OPEN_ROUTE, ref.threadId);
  if (!payload?.threadId) throw new Error("Rubato made no side chat.");
  return scopeThreadRef(ref.environmentId, ThreadId.make(payload.threadId));
}

export async function closeSideChat(ref: ScopedThreadRef): Promise<void> {
  await post(ref.environmentId, CLOSE_ROUTE, ref.threadId);
}

/** Every side chat tab in the panel state, keyed so a removal can be found: "<env>\n<thread>". */
export function sideChatsIn(byThreadKey: Readonly<Record<string, ThreadRightPanelState>>): Map<string, ScopedThreadRef> {
  const found = new Map<string, ScopedThreadRef>();
  for (const [threadKey, state] of Object.entries(byThreadKey)) {
    const owner = parseScopedThreadKey(threadKey);
    if (!owner) continue;
    for (const surface of state.surfaces) {
      if (surface.kind !== "side-chat") continue;
      const ref = scopeThreadRef(owner.environmentId, ThreadId.make(surface.threadId));
      found.set(`${ref.environmentId}\n${ref.threadId}`, ref);
    }
  }
  return found;
}

/** Side chats present before and gone after. */
export function closedSideChats(
  before: Readonly<Record<string, ThreadRightPanelState>>,
  after: Readonly<Record<string, ThreadRightPanelState>>,
): ScopedThreadRef[] {
  const remaining = sideChatsIn(after);
  return [...sideChatsIn(before)].filter(([key]) => !remaining.has(key)).map(([, ref]) => ref);
}

let watching = false;
/** Deletes each side chat whose tab leaves the panel. Idempotent; ChatView starts it. */
export function watchSideChatTabs(close: (ref: ScopedThreadRef) => Promise<void> = closeSideChat): void {
  if (watching) return;
  watching = true;
  useRightPanelStore.subscribe((state, previous) => {
    if (state.byThreadKey === previous.byThreadKey) return;
    for (const ref of closedSideChats(previous.byThreadKey, state.byThreadKey)) {
      // Nothing to show the user: the tab is already gone, and a side chat the server could
      // not delete is an archived thread they can still remove from Settings.
      void close(ref).catch(() => undefined);
    }
  });
}
