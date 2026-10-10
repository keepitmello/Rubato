import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { usePanelViewStore, setOpenedInPanel, surfacesClosed, watchPanelViews } from "./rubatoPanelViews";
import { useRightPanelStore, type RightPanelSurface, type ThreadRightPanelState } from "./rightPanelStore";

const env = EnvironmentId.make("env-1");
const thread = scopeThreadRef(env, ThreadId.make("thread-a"));
const other = scopeThreadRef(env, ThreadId.make("thread-b"));
const key = scopedThreadKey(thread);
const opened = () => usePanelViewStore.getState().opened;

afterEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
  usePanelViewStore.setState({ opened: { agents: {}, "side-chat": {} } });
});

describe("what a panel surface has open", () => {
  const left: Array<[ScopedThreadRef, string]> = [];
  watchPanelViews({ onSideChatLeft: (owner, side) => left.push([owner, side]) });

  it("survives a thread switch and a hidden panel, and goes when its tab closes", () => {
    const store = useRightPanelStore.getState();
    store.open(thread, "agents");
    store.open(thread, "side-chat");
    setOpenedInPanel("agents", key, "agent-1");
    setOpenedInPanel("side-chat", key, "side-chat:1");
    // Another thread's panel and hiding this one leave it alone.
    useRightPanelStore.getState().open(other, "agents");
    useRightPanelStore.getState().close(thread);
    expect(opened().agents[key]).toBe("agent-1");
    expect(opened()["side-chat"][key]).toBe("side-chat:1");

    useRightPanelStore.getState().closeSurface(thread, "agents");
    expect(opened().agents[key]).toBeUndefined();
    expect(opened()["side-chat"][key]).toBe("side-chat:1");
    expect(left).toEqual([]);

    useRightPanelStore.getState().closeSurface(thread, "side-chat");
    expect(opened()["side-chat"][key]).toBeUndefined();
    expect(left).toEqual([[thread, "side-chat:1"]]);
  });

  it("finds the threads whose surface of a kind left the panel", () => {
    const panel = (kinds: ReadonlyArray<"agents" | "side-chat">): ThreadRightPanelState => ({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: kinds.map((kind) => ({ id: kind, kind }) as RightPanelSurface),
    });
    const before = { a: panel(["agents", "side-chat"]), b: panel(["side-chat"]) };
    const after = { a: panel(["side-chat"]) };
    expect(surfacesClosed("agents", before, after)).toEqual(["a"]);
    expect(surfacesClosed("side-chat", before, after)).toEqual(["b"]);
  });
});
