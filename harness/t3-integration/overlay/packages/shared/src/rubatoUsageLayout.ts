/**
 * The Usage page's limits, arranged the way the person left them: which providers come first,
 * which are folded away, and only the long windows (weekly, monthly). Five-hour session windows
 * reset before they can change a plan, so the page leaves them out. The desktop keeps the
 * arrangement in its browser storage (apps/web/src/components/usage/rubatoUsageLayout.ts), the
 * phone in its preferences (apps/mobile/src/features/rubato-shell/usageLayout.ts); a provider seen
 * for the first time joins at the end.
 */
import { displayLimitWindows, type LimitPool } from "./usageLimits";

export interface UsageLayout {
  readonly order: ReadonlyArray<string>;
  readonly collapsed: ReadonlyArray<string>;
}

export const EMPTY_USAGE_LAYOUT: UsageLayout = { order: [], collapsed: [] };

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
  // .sort() on a fresh array, not .toSorted(): Hermes (the phone's engine) lacks the ES2023 method.
  return pools
    .map((pool, index) => ({ pool, index }))
    .sort((left, right) => rank(left.pool.driver) - rank(right.pool.driver) || left.index - right.index)
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
