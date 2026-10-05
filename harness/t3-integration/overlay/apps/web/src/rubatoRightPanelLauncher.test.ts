/**
 * Rubato's right-panel close (harness/t3-integration/right-panel-edits.mjs).
 *
 * The panel shows its launcher whenever there is no active surface, so an empty
 * open panel *is* the surface list. Closing the last tab lands there instead of
 * hiding the column. These cover what upstream's adapted tests do not: a panel
 * that was hidden stays hidden when its last surface goes, and hiding keeps its
 * tabs.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const state = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

describe("Rubato right panel launcher", () => {
  it("leaves the panel on the launcher when the last tab closes", () => {
    useRightPanelStore.getState().open(ref, "agents");
    useRightPanelStore.getState().closeSurface(ref, "agents");

    expect(state()).toEqual({ isOpen: true, activeSurfaceId: null, surfaces: [] });
  });

  it("stays hidden when its last surface closes while hidden", () => {
    useRightPanelStore.getState().open(ref, "agents");
    useRightPanelStore.getState().close(ref);
    useRightPanelStore.getState().closeSurface(ref, "agents");

    // A hidden panel does not open itself to show its launcher.
    expect(state()).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] });
  });

  it("still hides the panel without discarding its tabs", () => {
    useRightPanelStore.getState().open(ref, "agents");
    useRightPanelStore.getState().toggleVisibility(ref);

    expect(state()).toEqual({
      isOpen: false,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents" }],
    });
    expect(
      selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.id,
    ).toBe("agents");
  });

  it("opens a surface from the launcher it returned to", () => {
    useRightPanelStore.getState().open(ref, "agents");
    useRightPanelStore.getState().closeSurface(ref, "agents");
    useRightPanelStore.getState().openBrowser(ref, "tab-a");

    expect(state()).toMatchObject({ isOpen: true, activeSurfaceId: "browser:tab-a" });
  });
});
