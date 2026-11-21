/**
 * The desktop's arrangement of the Usage page's limits, kept in this browser's storage. What the
 * arrangement means is shared with the phone (@t3tools/shared/rubatoUsageLayout).
 */
import {
  arrangePools,
  EMPTY_USAGE_LAYOUT,
  moveDriver,
  toggleCollapsed,
} from "@t3tools/shared/rubatoUsageLayout";
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";

export { arrangePools, longLimitWindows, moveDriver, toggleCollapsed } from "@t3tools/shared/rubatoUsageLayout";

export const RUBATO_USAGE_LAYOUT_KEY = "rubato.usageLimits.layout";

const UsageLayout = Schema.Struct({
  order: Schema.Array(Schema.String),
  collapsed: Schema.Array(Schema.String),
});

export function useRubatoUsageLayout() {
  const [layout, setLayout] = useLocalStorage(RUBATO_USAGE_LAYOUT_KEY, EMPTY_USAGE_LAYOUT, UsageLayout);
  const arrange = useCallback(
    <T extends { readonly driver: string }>(pools: ReadonlyArray<T>) => arrangePools(pools, layout.order),
    [layout.order],
  );
  const move = useCallback(
    (visible: ReadonlyArray<string>, driver: string, delta: -1 | 1) =>
      setLayout((current) => ({ ...current, order: moveDriver(visible, current.order, driver, delta) })),
    [setLayout],
  );
  const toggle = useCallback(
    (driver: string) =>
      setLayout((current) => ({ ...current, collapsed: toggleCollapsed(current.collapsed, driver) })),
    [setLayout],
  );
  const isCollapsed = useCallback((driver: string) => layout.collapsed.includes(driver), [layout.collapsed]);
  return { arrange, move, toggle, isCollapsed };
}
