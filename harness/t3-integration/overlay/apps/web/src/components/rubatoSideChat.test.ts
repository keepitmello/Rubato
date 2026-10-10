import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useRightPanelStore } from "../rightPanelStore";
import { closedSideChats, sideChatSourceReady, sideChatsIn, watchSideChatTabs } from "./rubatoSideChat";

const env = EnvironmentId.make("env-1");
const parent = scopeThreadRef(env, ThreadId.make("parent"));
const other = scopeThreadRef(env, ThreadId.make("other"));
const side = (id: string) => ({ id: `side-chat:${id}` as const, kind: "side-chat" as const, threadId: id });
const panel = (...surfaces: ReturnType<typeof side>[]) => ({
  isOpen: true,
  activeSurfaceId: surfaces[0]?.id ?? null,
  surfaces,
});

afterEach(() => useRightPanelStore.setState({ byThreadKey: {} }));

describe("Side chat", () => {
  it("is offered for a Rubato thread that has run, and not before", () => {
    expect(sideChatSourceReady({ latestTurn: { turnId: "t" }, messages: [] }, true)).toBe(true);
    // A thread imported from the engine has messages but no T3 turn yet.
    expect(sideChatSourceReady({ latestTurn: null, messages: [{ id: "m" }] }, true)).toBe(true);
    expect(sideChatSourceReady({ latestTurn: null, messages: [] }, true)).toBe(false);
    expect(sideChatSourceReady({ latestTurn: { turnId: "t" }, messages: [] }, false)).toBe(false);
    expect(sideChatSourceReady(null, true)).toBe(false);
  });

  it("finds the side chats that left the panel, by any close path", () => {
    const before = {
      [scopedThreadKey(parent)]: panel(side("a"), side("b")),
      [scopedThreadKey(other)]: panel(side("c")),
    };
    const after = { [scopedThreadKey(parent)]: panel(side("b")) };
    expect([...sideChatsIn(before).values()].map((ref) => ref.threadId).sort()).toEqual(["a", "b", "c"]);
    expect(closedSideChats(before, after).map((ref) => ref.threadId).sort()).toEqual(["a", "c"]);
    expect(closedSideChats(after, before)).toEqual([]);
  });

  it("deletes a side chat when its tab closes, and keeps the others", async () => {
    const closed: ScopedThreadRef[] = [];
    watchSideChatTabs(async (ref) => {
      closed.push(ref);
    });
    const store = useRightPanelStore.getState();
    store.openSideChat(parent, "a");
    store.openSideChat(parent, "b");
    expect(closed).toEqual([]);
    useRightPanelStore.getState().closeSurface(parent, "side-chat:a");
    expect(closed.map((ref) => ref.threadId)).toEqual(["a"]);
    useRightPanelStore.getState().closeAllSurfaces(parent);
    expect(closed.map((ref) => ref.threadId)).toEqual(["a", "b"]);
    expect(closed.every((ref) => ref.environmentId === env)).toBe(true);
  });
});
