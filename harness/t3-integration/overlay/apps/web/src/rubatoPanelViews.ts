import { create } from "zustand";

import { useRightPanelStore, type ThreadRightPanelState } from "./rightPanelStore";

// What the Agents surface has open inside it, per thread: an agent's conversation. The panel
// used to keep it in component state, which a thread switch unmounts, so coming back to the
// thread dropped you out to the list. It lives here for
// the app session instead, and is let go when the surface's tab closes: hiding the panel or
// visiting another thread keeps it, closing the tab returns to the list.

export type PanelViewKind = "agents";

interface PanelViewState {
  readonly opened: Readonly<Record<PanelViewKind, Readonly<Record<string, string>>>>;
  setOpened: (kind: PanelViewKind, threadKey: string, id: string | null) => void;
}

export const usePanelViewStore = create<PanelViewState>()((set) => ({
  opened: { agents: {} },
  setOpened: (kind, threadKey, id) =>
    set((state) => {
      const current = state.opened[kind];
      if ((current[threadKey] ?? null) === id) return state;
      const { [threadKey]: _dropped, ...rest } = current;
      return { opened: { ...state.opened, [kind]: id === null ? rest : { ...rest, [threadKey]: id } } };
    }),
}));

/** The id open inside `kind`'s surface of the thread `threadKey`, or null for its list. */
export function useOpenedInPanel(kind: PanelViewKind, threadKey: string | null): string | null {
  return usePanelViewStore((state) => (threadKey === null ? null : (state.opened[kind][threadKey] ?? null)));
}

export function setOpenedInPanel(kind: PanelViewKind, threadKey: string, id: string | null): void {
  usePanelViewStore.getState().setOpened(kind, threadKey, id);
}

/** Threads whose `kind` surface was in the panel before and is not after. */
export function surfacesClosed(
  kind: PanelViewKind,
  before: Readonly<Record<string, ThreadRightPanelState>>,
  after: Readonly<Record<string, ThreadRightPanelState>>,
): string[] {
  const has = (state: ThreadRightPanelState | undefined) => state?.surfaces.some((surface) => surface.kind === kind) ?? false;
  return Object.keys(before).filter((threadKey) => has(before[threadKey]) && !has(after[threadKey]));
}

let watching = false;
/** Lets go of what a surface had open when its tab closes. Idempotent; ChatView starts it. */
export function watchPanelViews(): void {
  if (watching) return;
  watching = true;
  useRightPanelStore.subscribe((state, previous) => {
    if (state.byThreadKey === previous.byThreadKey) return;
    for (const threadKey of surfacesClosed("agents", previous.byThreadKey, state.byThreadKey)) {
      setOpenedInPanel("agents", threadKey, null);
    }
  });
}
