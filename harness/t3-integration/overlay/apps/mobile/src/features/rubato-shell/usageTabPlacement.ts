// Rubato: Usage is the third tab (mobile/shell-edits.mjs, navigation-tab-order.ts). A phone that
// saved its own tab choices before keeps them over the defaults, which hid Usage and put it last,
// so the first load after the change shows it and moves it to the third place once.
// mobile-preferences.ts runs this when it reads the saved preferences and keeps the flag.

const USAGE = "usage";
/** Pull requests and issues share one place in the tab bar. */
const placeOf = (tab: string) => (tab === "issues" ? "pullRequests" : tab);
const DEFAULT_HIDDEN: readonly string[] = ["pullRequests", "issues"];

export interface SavedTabs {
  readonly navigationTabOrder?: readonly string[];
  readonly hiddenNavigationTabs?: readonly string[];
}

export function placeUsageTab(saved: SavedTabs): SavedTabs {
  const hidden = saved.hiddenNavigationTabs?.filter((tab) => tab !== USAGE);
  const placed: { navigationTabOrder?: readonly string[]; hiddenNavigationTabs?: readonly string[] } =
    hidden === undefined ? {} : { hiddenNavigationTabs: hidden };
  if (saved.navigationTabOrder === undefined) return placed;
  const order = saved.navigationTabOrder.filter((tab) => tab !== USAGE);
  const shown = new Set<string>();
  let at = order.length;
  for (const [index, tab] of order.entries()) {
    if ((hidden ?? DEFAULT_HIDDEN).includes(tab)) continue;
    shown.add(placeOf(tab));
    if (shown.size === 2) {
      at = index + 1;
      break;
    }
  }
  return { ...placed, navigationTabOrder: [...order.slice(0, at), USAGE, ...order.slice(at)] };
}
