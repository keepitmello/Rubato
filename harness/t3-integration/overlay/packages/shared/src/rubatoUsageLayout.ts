/**
 * The Usage page's limits, arranged the way the person left them: which providers come first,
 * which are folded away, and which quota windows to show in what order. The desktop keeps the
 * arrangement in its browser storage (apps/web/src/components/usage/rubatoUsageLayout.ts), the
 * phone in its preferences (apps/mobile/src/features/rubato-shell/usageLayout.ts); a provider seen
 * for the first time joins at the end, and a window seen for the first time keeps its default.
 */
import { displayLimitWindows, type LimitPool, type LimitPoolWindow } from "./usageLimits.ts";

export interface UsageLayout {
  readonly order: ReadonlyArray<string>;
  readonly collapsed: ReadonlyArray<string>;
  /** driver → window id → shown. A window the person never switched keeps its default. */
  readonly windows?: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  /** driver → window ids in the order the person left them. */
  readonly windowOrder?: Readonly<Record<string, ReadonlyArray<string>>>;
}

export const EMPTY_USAGE_LAYOUT: UsageLayout = { order: [], collapsed: [] };

/** A stored arrangement, or undefined when it is not one; unreadable entries are dropped. */
export function parseUsageLayout(raw: unknown): UsageLayout | undefined {
  const value = raw as Record<string, unknown> | null | undefined;
  if (!value || !Array.isArray(value.order) || !Array.isArray(value.collapsed)) return undefined;
  const strings = (values: ReadonlyArray<unknown>) =>
    values.filter((entry): entry is string => typeof entry === "string");
  const records = <T>(input: unknown, read: (entry: unknown) => T | undefined) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const out: Record<string, T> = {};
    for (const [key, entry] of Object.entries(input)) {
      const parsed = read(entry);
      if (parsed !== undefined) out[key] = parsed;
    }
    return out;
  };
  const windows = records(value.windows, (entry) =>
    records(entry, (shown) => (typeof shown === "boolean" ? shown : undefined)),
  );
  const windowOrder = records(value.windowOrder, (entry) =>
    Array.isArray(entry) ? strings(entry) : undefined,
  );
  return {
    order: strings(value.order),
    collapsed: strings(value.collapsed),
    ...(windows ? { windows } : {}),
    ...(windowOrder ? { windowOrder } : {}),
  };
}

/** Shown until switched off: the long windows and Gemini's shared five-hour quota. */
function shownByDefault(driver: string, window: Pick<LimitPoolWindow, "id" | "kind">) {
  return window.kind !== "session" || (driver === "antigravity" && window.id === "gemini-5h");
}

export interface LimitWindowChoice {
  readonly window: LimitPoolWindow;
  readonly shown: boolean;
}

/** Every window the provider reports, in the person's order, each with whether it is shown. */
export function limitWindowChoices(
  pool: LimitPool,
  layout: UsageLayout = EMPTY_USAGE_LAYOUT,
): LimitWindowChoice[] {
  const chosen = layout.windows?.[pool.driver] ?? {};
  return arrangeBy(displayLimitWindows(pool), (window) => window.id, layout.windowOrder?.[pool.driver] ?? []).map(
    (window) => ({ window, shown: chosen[window.id] ?? shownByDefault(pool.driver, window) }),
  );
}

/** The windows on screen for this provider, in the person's order. */
export function visibleLimitWindows(pool: LimitPool, layout: UsageLayout = EMPTY_USAGE_LAYOUT) {
  return limitWindowChoices(pool, layout)
    .filter((choice) => choice.shown)
    .map((choice) => choice.window);
}

/** Whether the person ever chose this provider's windows; such a provider stays on the page with all of them off. */
export function hasWindowChoices(layout: UsageLayout, driver: string) {
  return Object.keys(layout.windows?.[driver] ?? {}).length > 0;
}

export function setWindowShown(
  layout: UsageLayout,
  driver: string,
  windowId: string,
  shown: boolean,
): UsageLayout {
  return {
    ...layout,
    windows: { ...layout.windows, [driver]: { ...layout.windows?.[driver], [windowId]: shown } },
  };
}

/** The layout after moving a shown window one place among the windows on screen. */
export function moveWindow(
  layout: UsageLayout,
  driver: string,
  visible: ReadonlyArray<string>,
  windowId: string,
  delta: -1 | 1,
): UsageLayout {
  return {
    ...layout,
    windowOrder: {
      ...layout.windowOrder,
      [driver]: moveEntry(visible, layout.windowOrder?.[driver] ?? [], windowId, delta),
    },
  };
}

function arrangeBy<T>(items: ReadonlyArray<T>, keyOf: (item: T) => string, order: ReadonlyArray<string>): T[] {
  const rank = (key: string) => {
    const index = order.indexOf(key);
    return index < 0 ? order.length : index;
  };
  // .sort() on a fresh array, not .toSorted(): Hermes (the phone's engine) lacks the ES2023 method.
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => rank(keyOf(left.item)) - rank(keyOf(right.item)) || left.index - right.index)
    .map(({ item }) => item);
}

function moveEntry(
  visible: ReadonlyArray<string>,
  order: ReadonlyArray<string>,
  entry: string,
  delta: -1 | 1,
): string[] {
  const next = [...visible];
  const from = next.indexOf(entry);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= next.length) return [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return [...next, ...order.filter((other) => !next.includes(other))];
}

/** Pools in the saved order; ones the order does not name keep their place after it. */
export function arrangePools<T extends { readonly driver: string }>(
  pools: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
): T[] {
  return arrangeBy(pools, (pool) => pool.driver, order);
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
  return moveEntry(visible, order, driver, delta);
}

export function toggleCollapsed(collapsed: ReadonlyArray<string>, driver: string): string[] {
  return collapsed.includes(driver)
    ? collapsed.filter((entry) => entry !== driver)
    : [...collapsed, driver];
}
