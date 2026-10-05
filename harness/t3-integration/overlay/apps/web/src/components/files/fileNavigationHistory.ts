import { useEffect } from "react";
import { create } from "zustand";

/**
 * Back and forward through the paths the file surface showed, like a browser.
 * The file panel unmounts when another tab (terminal, browser) becomes active,
 * so the history lives here, keyed by thread and workspace, for the session.
 */
export interface FileNavigationHistory {
  readonly entries: readonly string[];
  readonly index: number;
}

export const FILE_NAVIGATION_HISTORY_LIMIT = 100;

export const EMPTY_FILE_NAVIGATION_HISTORY: FileNavigationHistory = { entries: [], index: -1 };

/** Records that `path` is showing. Showing the current entry again changes nothing. */
export function visitFileNavigation(
  history: FileNavigationHistory,
  path: string,
): FileNavigationHistory {
  if (history.entries[history.index] === path) return history;
  const entries = [...history.entries.slice(0, history.index + 1), path].slice(
    -FILE_NAVIGATION_HISTORY_LIMIT,
  );
  return { entries, index: entries.length - 1 };
}

/** Moves one step back (-1) or forward (1); stays put at either end. */
export function stepFileNavigation(
  history: FileNavigationHistory,
  delta: -1 | 1,
): FileNavigationHistory {
  const index = history.index + delta;
  if (index < 0 || index >= history.entries.length) return history;
  return { entries: history.entries, index };
}

interface FileNavigationStore {
  byKey: Record<string, FileNavigationHistory>;
  visit: (key: string, path: string) => void;
  /** Moves the cursor and returns the path to open, or null at either end. */
  step: (key: string, delta: -1 | 1) => string | null;
}

export const useFileNavigationStore = create<FileNavigationStore>()((set, get) => ({
  byKey: {},
  visit: (key, path) => {
    const current = get().byKey[key] ?? EMPTY_FILE_NAVIGATION_HISTORY;
    const next = visitFileNavigation(current, path);
    if (next !== current) set((state) => ({ byKey: { ...state.byKey, [key]: next } }));
  },
  step: (key, delta) => {
    const current = get().byKey[key] ?? EMPTY_FILE_NAVIGATION_HISTORY;
    const next = stepFileNavigation(current, delta);
    if (next === current) return null;
    set((state) => ({ byKey: { ...state.byKey, [key]: next } }));
    return next.entries[next.index] ?? null;
  },
}));

/**
 * Back and forward for one file panel. Records `path` whenever it changes;
 * `step` returns the path to open, and opening it is the caller's job. The
 * opened path then equals the cursor entry, so it is not recorded twice.
 */
export function useFileNavigation(key: string, path: string | null) {
  const history = useFileNavigationStore(
    (state) => state.byKey[key] ?? EMPTY_FILE_NAVIGATION_HISTORY,
  );
  const visit = useFileNavigationStore((state) => state.visit);
  const step = useFileNavigationStore((state) => state.step);
  useEffect(() => {
    if (path !== null) visit(key, path);
  }, [key, path, visit]);
  return {
    canGoBack: history.index > 0,
    canGoForward: history.index < history.entries.length - 1,
    step: (delta: -1 | 1) => step(key, delta),
  };
}
