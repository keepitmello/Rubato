import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState, useSyncExternalStore } from "react";

import {
  readWarmingThread,
  setSessionCacheWarming,
  subscribeWarmingThreads,
  type WarmingThread,
} from "~/state/rubatoCacheWarming";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const HOUR = 3_600_000;
const RADIUS = 4.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The arc itself: what is left of the hours this thread chose to stay warm. */
export function WarmArcGlyph(props: { warming: WarmingThread; now: number }) {
  const { warming, now } = props;
  const left = Math.max(0, Math.min(1, (warming.until - now) / (warming.hours * HOUR)));
  return (
    <svg viewBox="0 0 12 12" className="size-3 -rotate-90" aria-hidden="true">
      <circle
        cx="6"
        cy="6"
        r={RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-orange-500/25 dark:stroke-orange-400/25"
      />
      <circle
        cx="6"
        cy="6"
        r={RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - left)}
        className="stroke-orange-500 dark:stroke-orange-400"
      />
    </svg>
  );
}

/**
 * A sidebar row's sign that its prompt cache is still being kept warm. Clicking it
 * stops this window; the thread's next message warms again.
 */
export function RubatoWarmArc(props: { environmentId: EnvironmentId; threadId: string }) {
  const { environmentId, threadId } = props;
  const subscribe = useCallback(
    (listener: () => void) => subscribeWarmingThreads(environmentId, listener),
    [environmentId],
  );
  const warming = useSyncExternalStore(
    subscribe,
    () => readWarmingThread(environmentId, threadId),
    () => null,
  );
  const [stopping, setStopping] = useState(false);
  const now = Date.now();
  if (!warming || warming.until <= now || stopping) return null;

  const stop = () => {
    setStopping(true);
    setSessionCacheWarming(environmentId, warming.sessionId, { stop: true })
      .catch(() => undefined)
      .finally(() => setStopping(false));
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-thread-selection-safe
            aria-label={`Keeping the prompt cache warm until ${clock(warming.until)}. Stop`}
            className="inline-flex cursor-pointer items-center justify-center rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              stop();
            }}
          />
        }
      >
        <WarmArcGlyph warming={warming} now={now} />
      </TooltipTrigger>
      <TooltipPopup side="top">Warm until {clock(warming.until)} · click to stop</TooltipPopup>
    </Tooltip>
  );
}
