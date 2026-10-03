import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useId, useSyncExternalStore } from "react";

import {
  type CachedThread,
  readCachedThread,
  subscribeCachedThreads,
} from "~/state/rubatoCacheWarming";
import { formatClock, formatRemaining } from "../chat/RubatoCacheSection";

/** This thread's cache as the sidebar last read it, while it is still warm. */
function useCachedThread(environmentId: EnvironmentId, threadId: string): CachedThread | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeCachedThreads(environmentId, listener),
    [environmentId],
  );
  const cached = useSyncExternalStore(
    subscribe,
    () => readCachedThread(environmentId, threadId),
    () => null,
  );
  return cached && cached.expiresAt > Date.now() ? cached : null;
}

/** A flame in a 5 x 7 box, cut out of the capsule while the warmer holds the cache. */
const FLAME =
  "M2.6 0C3.2 1.7 5 2.6 5 4.6C5 6 3.9 7 2.5 7C1.1 7 0 6 0 4.6C0 3.5 0.7 2.7 1.2 2.1C1.3 3.1 1.8 3.5 2.2 3.5C2.1 2.3 1.9 1.1 2.6 0Z";

/**
 * What is left of the cache's life: from the latest input to when it goes cold. A warmer
 * that is on stretches that life, so the capsule follows the cache, not the warmer's hours.
 * While the warmer holds the cache the capsule is thicker with a flame cut out of its
 * middle; otherwise it is a thin grey line. Both are a block above the time label, so
 * the row reads capsule first and the time under it. The meta slot bottom-aligns the
 * pair while the capsule is there, which puts the capsule on the row's own centre.
 */
export function CacheCapsuleGlyph(props: { cached: CachedThread; now: number }) {
  const { cached, now } = props;
  // useId has characters a url(#…) reference does not take.
  const maskId = `rubato-flame-${useId().replace(/[^\w-]/g, "")}`;
  const span = cached.from != null ? cached.expiresAt - cached.from : 0;
  const left = span > 0 ? Math.max(0, Math.min(1, (cached.expiresAt - now) / span)) : 1;
  const width = `${left * 100}%`;
  if (cached.warmer !== "on") {
    return (
      <span
        aria-hidden="true"
        data-rubato-cache="thin"
        className="pointer-events-none block h-[3px] w-4 overflow-hidden rounded-full bg-muted-foreground/20"
      >
        <span className="block h-full rounded-full bg-muted-foreground/70" style={{ width }} />
      </span>
    );
  }
  return (
    <svg
      aria-hidden="true"
      data-warming="true"
      data-rubato-cache="warmer"
      viewBox="0 0 20 6"
      className="pointer-events-none block h-1.5 w-5 text-foreground/85"
    >
      <defs>
        <mask id={maskId}>
          <rect width="20" height="6" fill="white" />
          <path d={FLAME} transform="translate(7.9 0.3) scale(0.8)" fill="black" />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`} fill="currentColor">
        <rect width="20" height="6" rx="3" opacity="0.3" />
        <rect width={width} height="6" rx="3" />
      </g>
    </svg>
  );
}

/** The hover text: how long the cache stays warm first, then what the warmer does. */
export function cacheTooltipLines(cached: CachedThread, now: number): [string, string] {
  const cache = `Cache warm · ${formatRemaining(cached.expiresAt - now)} left`;
  const warmer =
    cached.warmer === "on" && cached.until != null
      ? `Warmer on until ${formatClock(cached.until)}${cached.hours ? ` · ${cached.hours}h` : ""}`
      : cached.warmer === "ended" && cached.until != null
        ? `Warmer ended ${formatClock(cached.until)}`
        : cached.warmer === "off"
          ? "Warmer off"
          : "Warmer not running";
  return [cache, warmer];
}

/**
 * The sidebar row's capsule under the time label, while the thread's prompt cache is warm.
 * It carries a flame while the warmer holds the cache and is a thin grey line when the
 * cache runs out on its own.
 * It only shows: the row's meta area fades to the archive button on hover, so the
 * details sit in the title's tooltip instead (RubatoCacheTooltip).
 */
export function RubatoCacheCapsule(props: { environmentId: EnvironmentId; threadId: string }) {
  const cached = useCachedThread(props.environmentId, props.threadId);
  if (!cached) return null;
  return <CacheCapsuleGlyph cached={cached} now={Date.now()} />;
}

/** The cache lines under the thread title in its tooltip. */
export function RubatoCacheTooltip(props: { environmentId: EnvironmentId; threadId: string }) {
  const cached = useCachedThread(props.environmentId, props.threadId);
  if (!cached) return null;
  const [cache, warmer] = cacheTooltipLines(cached, Date.now());
  return (
    <span className="mt-1.5 block border-t border-current/15 pt-1.5 text-xs tabular-nums">
      <span className="block font-medium">{cache}</span>
      <span className="block opacity-80">{warmer}</span>
    </span>
  );
}
