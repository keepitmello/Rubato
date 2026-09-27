import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useEffect, useState } from "react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { setSessionCacheWarming } from "~/state/rubatoCacheWarming";
import { Switch } from "../ui/switch";

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

/**
 * The cache half of the context ring's popover: lifetime, hit rate and this thread's warmer.
 * The switch answers for this thread only; the global mode is a setting (/settings in the CLI).
 */
export function RubatoCacheSection(props: {
  cache: RubatoCache | null | undefined;
  environmentId?: EnvironmentId | undefined;
}) {
  const now = useRubatoCacheNow(props.cache, true);
  // The switch's answer stands in until the thread reports again. A thread T3 has let go
  // of reports nothing new, so without it the popover would snap back to the old state.
  const [answered, setAnswered] = useState<RubatoCache | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setAnswered(null), [props.cache]);
  const cache = answered ?? props.cache;
  if (!cache) return null;

  const cold = rubatoCacheIsCold(cache, now);
  const globalOff = cache.warming.mode === "off";
  const enabled = pending ?? cache.warming.enabled;
  const status = cold
    ? "Cold"
    : cache.state === "warm" && cache.expiresAt != null
      ? `Warm · ${formatRemaining(cache.expiresAt - now)} left`
      : "Lifetime not published";
  const warmingNote = globalOff
    ? "Off in settings"
    : !enabled
      ? "Off for this thread"
      : cache.warming.active && cache.warming.until != null && pending === null
        ? `Refreshing until ${formatClock(cache.warming.until)}`
        : "Not warming right now";
  const canSwitch = Boolean(props.environmentId && cache.sessionId) && !globalOff;

  const toggle = (checked: boolean) => {
    if (!props.environmentId || !cache.sessionId) return;
    setPending(checked);
    setError(null);
    setSessionCacheWarming(props.environmentId, cache.sessionId, checked)
      .then((next) => setAnswered(next))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not change cache warming."),
      )
      .finally(() => setPending(null));
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
      <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-secondary-label">Keep warm</span>
          <span className="text-pretty text-muted-foreground">{warmingNote}</span>
        </div>
        <Switch
          size="sm"
          checked={enabled && !globalOff}
          disabled={!canSwitch || pending !== null}
          onCheckedChange={toggle}
          aria-label="Keep this thread's prompt cache warm"
        />
      </div>
      {error ? <div className="text-pretty text-[11px] text-destructive">{error}</div> : null}
    </div>
  );
}
