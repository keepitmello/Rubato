// A horizontal swipe on a tab's root screen moves to the tab beside it, as tapping the tab bar
// does (shell-edits.mjs wraps WorkspaceRootScreen's content in WorkspaceTabSwipe). The pan only
// wakes toward a tab that exists: on Threads, a leftward drag stays the thread row's (its swipe
// actions open from the right), and only a rightward drag goes back to Companions.
import type { WorkspaceTab } from "../workspace/workspace-tabs-state";

/** The tab bar's order (WorkspaceNativeTabs.ios.tsx): a leftward swipe goes to the next one. */
export const SWIPE_TABS: readonly WorkspaceTab[] = ["companions", "threads"];

export const TAB_SWIPE = {
  /**
   * Points of horizontal travel before the pan takes the touch. Below the thread row's own
   * 10 (ReanimatedSwipeable's default drag offset), so a rightward drag over a row reaches the
   * tabs before the row claims it.
   */
  activate: 8,
  /** Travel the other way, or vertically, that leaves the touch to the list. */
  failAgainst: 10,
  failVertical: 12,
  /** A release this far over, or this fast toward the next tab, moves there. */
  commitDistance: 56,
  commitVelocity: 500,
  /** The content follows the finger at this ratio, up to `followMax` points. */
  followRatio: 0.4,
  followMax: 56,
} as const;

export interface TabSwipeNeighbors {
  readonly previous: WorkspaceTab | null;
  readonly next: WorkspaceTab | null;
}

export function tabSwipeNeighbors(tab: WorkspaceTab): TabSwipeNeighbors {
  const index = SWIPE_TABS.indexOf(tab);
  if (index < 0) return { previous: null, next: null };
  return { previous: SWIPE_TABS[index - 1] ?? null, next: SWIPE_TABS[index + 1] ?? null };
}

/**
 * Where a released swipe goes: 1 to the next tab (the finger moved left), -1 to the previous,
 * 0 to stay. A fling back the other way cancels even a long drag.
 */
export function tabSwipeStep(
  translationX: number,
  velocityX: number,
  canPrevious: boolean,
  canNext: boolean,
): -1 | 0 | 1 {
  "worklet";
  const step = translationX < 0 ? 1 : translationX > 0 ? -1 : 0;
  if (step === 0 || (step === 1 && !canNext) || (step === -1 && !canPrevious)) return 0;
  const toward = step === 1 ? -velocityX : velocityX;
  if (toward >= TAB_SWIPE.commitVelocity) return step;
  return Math.abs(translationX) >= TAB_SWIPE.commitDistance && toward > -TAB_SWIPE.commitVelocity ? step : 0;
}

/** How far the content leans with the finger: only toward a tab that exists, damped and capped. */
export function tabSwipeFollow(translationX: number, canPrevious: boolean, canNext: boolean): number {
  "worklet";
  const allowed = translationX < 0 ? canNext : translationX > 0 ? canPrevious : false;
  if (!allowed) return 0;
  const lean = Math.min(Math.abs(translationX) * TAB_SWIPE.followRatio, TAB_SWIPE.followMax);
  return translationX < 0 ? -lean : lean;
}
