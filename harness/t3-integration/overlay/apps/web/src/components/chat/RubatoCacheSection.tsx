import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useEffect, useState } from "react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { setSessionCacheWarming } from "~/state/rubatoCacheWarming";
import { Slider } from "@base-ui/react/slider";

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

/**
 * The cache half of the context ring's popover: lifetime, hit rate and how many hours
 * after its latest input this thread keeps warming. Dragging shows the end time as it
 * moves; letting go saves it. It answers for this thread only; the global mode is a
 * setting (/settings in the CLI).
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setAnswered(null), [props.cache]);
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
  const warmingNote = globalOff
    ? "Off in settings"
    : until == null
      ? `${hours}h after your last message`
      : until <= now
        ? `${hours}h · ended ${formatClock(until)}`
        : draft === null && !saving && !cache.warming.active
          ? `${hours}h · resumes with the next reply`
          : `${hours}h · until ${formatClock(until)}`;
  const canChange = Boolean(props.environmentId && cache.sessionId) && !globalOff && !saving;

  const save = (next: number) => {
    setDraft(null);
    if (!props.environmentId || !cache.sessionId || (next === saved && cache.warming.enabled)) return;
    setSaving(true);
    setError(null);
    setSessionCacheWarming(props.environmentId, cache.sessionId, { enabled: true, hours: next })
      .then((updated) => setAnswered(updated))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not change cache warming."),
      )
      .finally(() => setSaving(false));
  };
  const asHours = (value: number | readonly number[]) =>
    Math.round(Array.isArray(value) ? (value[0] ?? saved) : (value as number));

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
        <span className="text-secondary-label">Keep warm</span>
        <span className="font-medium tabular-nums text-secondary-label">{warmingNote}</span>
      </div>
      <Slider.Root
        min={MIN_HOURS}
        max={MAX_HOURS}
        step={1}
        value={hours}
        disabled={!canChange}
        onValueChange={(value) => setDraft(asHours(value))}
        onValueCommitted={(value) => save(asHours(value))}
        aria-label="Hours to keep this thread's prompt cache warm"
        className="py-1 data-disabled:opacity-50"
      >
        <Slider.Control className="flex h-4 w-full touch-none items-center select-none">
          <Slider.Track className="relative h-1.5 w-full rounded-full bg-muted/60">
            <Slider.Indicator className="rounded-full bg-primary" />
            <Slider.Thumb className="size-3.5 rounded-full border border-border bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      {error ? <div className="text-pretty text-[11px] text-destructive">{error}</div> : null}
    </div>
  );
}
