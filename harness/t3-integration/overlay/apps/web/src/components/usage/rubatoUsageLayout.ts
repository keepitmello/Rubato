/**
 * The Usage page's limits, arranged the way the user left them: which providers come first,
 * which are folded away, and only the long windows (weekly, monthly). Five-hour session
 * windows reset before they can change a plan, so the page leaves them out.
 * Kept in this browser's storage; a provider seen for the first time joins at the end.
 */
import type { LimitPool } from "@t3tools/shared/usageLimits";
import { displayLimitWindows } from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";

export const RUBATO_USAGE_LAYOUT_KEY = "rubato.usageLimits.layout";

const UsageLayout = Schema.Struct({
  order: Schema.Array(Schema.String),
  collapsed: Schema.Array(Schema.String),
});
export type UsageLayout = typeof UsageLayout.Type;

const EMPTY_LAYOUT: UsageLayout = { order: [], collapsed: [] };

/** The windows a provider shows: everything but the five-hour session windows. */
export function longLimitWindows(pool: LimitPool) {
  return displayLimitWindows(pool).filter((window) => window.kind !== "session");
}

/** Pools in the saved order; ones the order does not name keep their place after it. */
export function arrangePools<T extends { readonly driver: string }>(
  pools: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
): T[] {
  const rank = (driver: string) => {
    const index = order.indexOf(driver);
    return index < 0 ? order.length : index;
  };
  return pools
    .map((pool, index) => ({ pool, index }))
    .toSorted((left, right) => rank(left.pool.driver) - rank(right.pool.driver) || left.index - right.index)
    .map(({ pool }) => pool);
}

/**
 * The order after moving `driver` one place within what is on screen. Providers not on
 * screen now (signed out, nothing to report) keep their saved place behind them.
 */
export function moveDriver(
  visible: ReadonlyArray<string>,
  order: ReadonlyArray<string>,
  driver: string,
  delta: -1 | 1,
): string[] {
  const next = [...visible];
  const from = next.indexOf(driver);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= next.length) return [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return [...next, ...order.filter((entry) => !next.includes(entry))];
}

export function toggleCollapsed(collapsed: ReadonlyArray<string>, driver: string): string[] {
  return collapsed.includes(driver)
    ? collapsed.filter((entry) => entry !== driver)
    : [...collapsed, driver];
}

export function useRubatoUsageLayout() {
  const [layout, setLayout] = useLocalStorage(RUBATO_USAGE_LAYOUT_KEY, EMPTY_LAYOUT, UsageLayout);
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
