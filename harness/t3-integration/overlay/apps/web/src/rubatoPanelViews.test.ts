import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
  usePanelViewStore.setState({ opened: { agents: {} } });
});

describe("what the Agents surface has open", () => {
  watchPanelViews();

  it("survives a thread switch and a hidden panel, and goes when its tab closes", () => {
    const store = useRightPanelStore.getState();
    store.open(thread, "agents");
    setOpenedInPanel("agents", key, "agent-1");
    // Another thread's panel and hiding this one leave it alone.
    useRightPanelStore.getState().open(other, "agents");
    useRightPanelStore.getState().close(thread);
    expect(opened().agents[key]).toBe("agent-1");

    useRightPanelStore.getState().closeSurface(thread, "agents");
    expect(opened().agents[key]).toBeUndefined();
  });

  it("finds the threads whose Agents surface left the panel", () => {
    const panel = (kinds: ReadonlyArray<"agents" | "browser">): ThreadRightPanelState => ({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: kinds.map((kind) => ({ id: kind, kind }) as RightPanelSurface),
    });
    const before = { a: panel(["agents"]), b: panel(["agents"]) };
    const after = { a: panel([]), b: panel(["agents"]) };
    expect(surfacesClosed("agents", before, after)).toEqual(["a"]);
  });
});
