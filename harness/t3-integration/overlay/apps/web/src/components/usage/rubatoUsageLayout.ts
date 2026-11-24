/**
 * The desktop's arrangement of the Usage page's limits, kept in this browser's storage. What the
 * arrangement means is shared with the phone (@t3tools/shared/rubatoUsageLayout).
 */
import {
  arrangePools,
  EMPTY_USAGE_LAYOUT,
  hasWindowChoices,
  limitWindowChoices,
  moveDriver,
  moveWindow,
  setWindowShown,
  toggleCollapsed,
  visibleLimitWindows,
} from "@t3tools/shared/rubatoUsageLayout";
import type { LimitPool } from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";

export { arrangePools, moveDriver, toggleCollapsed } from "@t3tools/shared/rubatoUsageLayout";

export const RUBATO_USAGE_LAYOUT_KEY = "rubato.usageLimits.layout";

const UsageLayout = Schema.Struct({
  order: Schema.Array(Schema.String),
  collapsed: Schema.Array(Schema.String),
  windows: Schema.optionalKey(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Boolean))),
  windowOrder: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
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
  const windowsOf = useCallback((pool: LimitPool) => visibleLimitWindows(pool, layout), [layout]);
  const windowChoicesOf = useCallback((pool: LimitPool) => limitWindowChoices(pool, layout), [layout]);
  /** A provider stays on the page while it shows a window, or after the person switched its windows. */
  const keepsPool = useCallback(
    (pool: LimitPool) => visibleLimitWindows(pool, layout).length > 0 || hasWindowChoices(layout, pool.driver),
    [layout],
  );
  const showWindow = useCallback(
    (driver: string, windowId: string, shown: boolean) =>
      setLayout((current) => setWindowShown(current, driver, windowId, shown)),
    [setLayout],
  );
  const moveWindowBy = useCallback(
    (driver: string, visible: ReadonlyArray<string>, windowId: string, delta: -1 | 1) =>
      setLayout((current) => moveWindow(current, driver, visible, windowId, delta)),
    [setLayout],
  );
  return {
    arrange,
    move,
    toggle,
    isCollapsed,
    windowsOf,
    windowChoicesOf,
    keepsPool,
    showWindow,
    moveWindow: moveWindowBy,
  };
}
