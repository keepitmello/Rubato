import { describe, expect, it } from "vite-plus/test";

import { workspaceConnectionStatusPresentation } from "../home/workspace-connection-status";
import type { WorkspaceState } from "../../state/workspaceModel";
import { withoutThreadSync } from "./companionTabStatus";

const connected: WorkspaceState = {
  isLoadingConnections: false,
  hasConnections: true,
  hasReadyEnvironment: true,
  hasConnectingEnvironment: false,
  connectingEnvironments: [],
  connectionState: "connected",
  connectionError: null,
  networkStatus: "online",
  hasLoadedShellSnapshot: true,
  hasPendingShellSnapshot: false,
  shellSnapshotError: null,
};

describe("withoutThreadSync", () => {
  it("drops the thread sync that the threads tab shows", () => {
    const syncing = { ...connected, hasPendingShellSnapshot: true };
    expect(workspaceConnectionStatusPresentation(syncing)?.label).toBe("Syncing threads...");
    expect(workspaceConnectionStatusPresentation(withoutThreadSync(syncing))).toBeNull();
  });

  it("drops the first load too", () => {
    const loading = { ...connected, hasLoadedShellSnapshot: false, hasPendingShellSnapshot: true };
    expect(workspaceConnectionStatusPresentation(withoutThreadSync(loading))).toBeNull();
  });

  it("keeps what is wrong with the connection", () => {
    const offline = { ...connected, networkStatus: "offline" as const, hasPendingShellSnapshot: true };
    expect(workspaceConnectionStatusPresentation(withoutThreadSync(offline))?.label).toBe("You are offline");
    const failed = { ...connected, connectionError: "Mac unreachable", hasPendingShellSnapshot: true };
    expect(workspaceConnectionStatusPresentation(withoutThreadSync(failed))?.label).toBe("Mac unreachable");
  });

  it("returns a state with nothing to drop as it is", () => {
    expect(withoutThreadSync(connected)).toBe(connected);
  });
});
