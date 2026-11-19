// The Companions tab's title says how the Mac connection is, not how far the thread list has
// synced: the companion list and rooms open from what the phone kept (companionsStore.ts, the
// thread cache), so "Syncing threads..." over them read as the tab still loading at every launch.
// Offline, an error and a connection still being made still show; they are the companions' too.
import type { WorkspaceState } from "../../state/workspaceModel";

export function withoutThreadSync(state: WorkspaceState): WorkspaceState {
  return state.hasPendingShellSnapshot ? { ...state, hasPendingShellSnapshot: false } : state;
}
