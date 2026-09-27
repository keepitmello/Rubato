import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { setSessionCacheWarming } from "~/state/rubatoCacheWarming";
import { MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "../ui/button";

type RubatoCache = NonNullable<ContextWindowSnapshot["cache"]>;

/**
 * The clock the cache facts are read against. It moves when the cache would go cold
 * (the ring turns red on time, with no new event) and, while `ticking`, often enough
 * for a minute countdown.
 */
export function useRubatoCacheNow(cache: RubatoCache | null | undefined, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = cache?.expiresAt;
  useEffect(() => {
    if (expiresAt == null) return;
    const remaining = expiresAt - Date.now();
    // Past expiry nothing moves any more; one catch-up read settles a stale clock.
    if (remaining <= 0) {
      if (now < expiresAt) setNow(Date.now());
      return;
    }
    const delay = Math.min(ticking ? 30_000 : remaining + 50, 2_147_000_000);
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [expiresAt, ticking, now]);
  return now;
}

/** Cold is the one state the ring paints: the next request pays for the whole prompt again. */
export function rubatoCacheIsCold(cache: RubatoCache | null | undefined, now: number): boolean {
  if (!cache) return false;
  if (cache.state === "cold") return true;
  return cache.state === "warm" && cache.expiresAt != null && cache.expiresAt <= now;
}

function formatRemaining(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
      <span className="text-secondary-label">{props.label}</span>
      <span className="font-medium tabular-nums text-secondary-label">{props.children}</span>
    </div>
  );
}

const HOUR = 3_600_000;
const MIN_HOURS = 1;
const MAX_HOURS = 12;
const DEFAULT_HOURS = 2;
/** Clicks land in a burst; the last value is saved once they stop. */
const SAVE_AFTER_MS = 600;

/**
 * The cache half of the context ring's popover: lifetime, hit rate and how many hours
 * after its latest input this thread keeps warming. − / + change the hours and the end
 * time at once; the value is saved once the clicks stop. It answers for this thread only;
 * the global mode is a setting (/settings in the CLI).
 */
export function RubatoCacheSection(props: {
  cache: RubatoCache | null | undefined;
  environmentId?: EnvironmentId | undefined;
}) {
  const now = useRubatoCacheNow(props.cache, true);
  // The answer stands in until the thread reports again. A thread T3 has let go of
  // reports nothing new, so without it the popover would snap back to the old hours.
  const [answered, setAnswered] = useState<RubatoCache | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setAnswered(null), [props.cache]);
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);
  const cache = answered ?? props.cache;
  if (!cache) return null;

  const cold = rubatoCacheIsCold(cache, now);
  const globalOff = cache.warming.mode === "off";
  const saved = Math.min(MAX_HOURS, Math.max(MIN_HOURS, cache.warming.hours ?? DEFAULT_HOURS));
  const hours = draft ?? saved;
  const from = cache.warming.from;
  const until = from != null ? from + hours * HOUR : null;
  const status = cold
    ? "Cold"
    : cache.state === "warm" && cache.expiresAt != null
      ? `Warm · ${formatRemaining(cache.expiresAt - now)} left`
      : "Lifetime not published";
  const endNote = globalOff
    ? "Off in settings"
    : until == null
      ? null
      : until <= now
        ? `ended ${formatClock(until)}`
        : `until ${formatClock(until)}`;
  const canChange = Boolean(props.environmentId && cache.sessionId) && !globalOff;

  const change = (delta: number) => {
    const next = Math.min(MAX_HOURS, Math.max(MIN_HOURS, hours + delta));
    if (next === hours || !props.environmentId || !cache.sessionId) return;
    const environmentId = props.environmentId;
    const sessionId = cache.sessionId;
    setDraft(next);
    setError(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      setSessionCacheWarming(environmentId, sessionId, { enabled: true, hours: next })
        .then((updated) => {
          setAnswered(updated);
          setDraft(null);
        })
        .catch((cause: unknown) => {
          setDraft(null);
          setError(cause instanceof Error ? cause.message : "Could not change cache warming.");
        });
    }, SAVE_AFTER_MS);
  };

  return (
    <div className="mt-1 flex flex-col gap-1.5 border-t border-border/60 pt-2">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Prompt Cache</div>
        <div
          className={cn("text-[11px] tabular-nums", cold ? "font-medium" : "text-secondary-label")}
          style={cold ? { color: "var(--color-error)" } : undefined}
        >
          {status}
        </div>
      </div>
      {cache.hitPercent != null ? <Row label="Hit rate">{cache.hitPercent}%</Row> : null}
      <div className="flex items-center justify-between gap-2 text-[11px] leading-4">
        <span className="text-secondary-label">Keep warm</span>
        <div className="flex items-center gap-1.5">
          {endNote ? <span className="tabular-nums text-muted-foreground">{endNote}</span> : null}
          <div
            className="flex items-center rounded-md bg-muted/50"
            role="group"
            aria-label="Hours to keep this thread's prompt cache warm"
          >
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="One hour less"
              disabled={!canChange || hours <= MIN_HOURS}
              onClick={() => change(-1)}
            >
              <MinusIcon aria-hidden="true" />
            </Button>
            <span className="w-6 text-center font-medium tabular-nums text-secondary-label" aria-live="polite">
              {hours}h
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="One hour more"
              disabled={!canChange || hours >= MAX_HOURS}
              onClick={() => change(1)}
            >
              <PlusIcon aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
      {error ? <div className="text-pretty text-[11px] text-destructive">{error}</div> : null}
    </div>
  );
}
