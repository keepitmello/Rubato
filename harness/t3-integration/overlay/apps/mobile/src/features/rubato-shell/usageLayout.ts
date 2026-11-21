// Rubato: the phone's arrangement of the Usage page's limits — which providers come first and
// which are folded — kept in the phone's preferences. What it means is shared with the desktop
// (@t3tools/shared/rubatoUsageLayout); each device keeps its own.
import { useAtomValue } from "@effect/atom-react";
import {
  arrangePools,
  EMPTY_USAGE_LAYOUT,
  moveDriver,
  toggleCollapsed,
  type UsageLayout,
} from "@t3tools/shared/rubatoUsageLayout";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";

export function useRubatoUsageLayout() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const layout: UsageLayout = AsyncResult.isSuccess(preferences)
    ? (preferences.value.rubatoUsageLayout ?? EMPTY_USAGE_LAYOUT)
    : EMPTY_USAGE_LAYOUT;
  const update = (change: (current: UsageLayout) => UsageLayout) =>
    void savePreferences({
      transform: (current) => ({
        rubatoUsageLayout: change(current.rubatoUsageLayout ?? EMPTY_USAGE_LAYOUT),
      }),
    });
  return {
    arrange: <T extends { readonly driver: string }>(pools: ReadonlyArray<T>) =>
      arrangePools(pools, layout.order),
    isCollapsed: (driver: string) => layout.collapsed.includes(driver),
    toggle: (driver: string) =>
      update((current) => ({ ...current, collapsed: toggleCollapsed(current.collapsed, driver) })),
    move: (visible: ReadonlyArray<string>, driver: string, delta: -1 | 1) =>
      update((current) => ({ ...current, order: moveDriver(visible, current.order, driver, delta) })),
  };
}
