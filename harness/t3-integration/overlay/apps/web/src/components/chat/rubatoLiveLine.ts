import { useEffect, useRef, useState } from "react";

/**
 * Rubato: Codex keeps each live line up for at least a second, so a run of quick
 * calls reads as one line ticking over ("Reading a.ts" → "Searching for foo" →
 * "Running npm test") rather than a flicker, and a moment between two calls never
 * flashes "Thinking".
 */
export const RUBATO_LIVE_LINE_DWELL_MS = 1_000;

/**
 * Shows `value` under `key`, but a new key waits until the one on screen has been
 * up for `dwellMs`; a key that changes again while it waits replaces the waiting one.
 * A null key is shown at once (a settled row has nothing to pace).
 */
export function useRubatoLiveLine<T>(
  key: string | null,
  value: T,
  dwellMs: number = RUBATO_LIVE_LINE_DWELL_MS,
): T {
  const [shown, setShown] = useState<{ key: string | null; value: T }>(() => ({ key, value }));
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    const now = Date.now();
    shownAt.current ??= now;
    if (key === shown.key) return;
    const show = () => {
      shownAt.current = Date.now();
      setShown({ key, value });
    };
    const wait = key === null ? 0 : dwellMs - (now - shownAt.current);
    if (wait <= 0) {
      show();
      return;
    }
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [key, value, dwellMs, shown.key]);
  return key === shown.key ? value : shown.value;
}
