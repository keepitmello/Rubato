import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { setSessionCacheWarming } from "~/state/rubatoCacheWarming";
import { MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "../ui/button";
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

export function formatRemaining(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
      <span className="text-popover-foreground/65">{props.label}</span>
      <span className="font-medium tabular-nums text-popover-foreground">{props.children}</span>
    </div>
  );
}

const HOUR = 3_600_000;
const MAX_HOURS = 12;
/** Clicks land in a burst; the last value is saved once they stop. */
const SAVE_AFTER_MS = 600;

/**
 * What the stepper shows: the time left until the warmer stops, in whole hours (minutes
 * under one hour). `base` is the whole-hour value − / + step from.
 */
export function warmingLeft(until: number | null | undefined, now: number): { label: string; base: number } {
  const left = until != null ? until - now : 0;
  if (left <= 0) return { label: "0h", base: 0 };
  if (left < HOUR) return { label: `${Math.max(1, Math.floor(left / 60_000))}m`, base: 1 };
  const base = Math.round(left / HOUR);
  return { label: `${base}h`, base };
}

/**
 * The cache half of the context ring's popover, on top of the context half: lifetime,
 * hit rate and this thread's warmer. The switch turns the warmer on or off for this
 * thread, and off stays off through later messages until it is switched back on. While
 * it is on, the stepper shows the time left and − / + set it in hours from now, with the
 * end time beside them; the value is saved once the clicks stop. The end is the engine's
 * (`warming.until`): a later message still gets two hours. It answers for this thread
 * only; the global mode is a setting (/settings in the CLI).
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
  const [switching, setSwitching] = useState<boolean | null>(null);
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
  const left = warmingLeft(cache.warming.until, now);
  const hours = draft ?? left.base;
  const until = draft != null ? now + draft * HOUR : (cache.warming.until ?? null);
  const status = cold
    ? "Cold"
    : cache.state === "warm" && cache.expiresAt != null
      ? `Warm · ${formatRemaining(cache.expiresAt - now)} left`
      : "Lifetime not published";
  const canChange = Boolean(props.environmentId && cache.sessionId) && !globalOff;
  // The switch moves at once; the thread's answer settles it.
  const on = !globalOff && (switching ?? cache.warming.enabled);
  const endNote = globalOff
    ? "Off in settings"
    : until == null
      ? null
      : until <= now
        ? `ended ${formatClock(until)}`
        : `until ${formatClock(until)}`;

  const switchWarming = (enabled: boolean) => {
    if (!props.environmentId || !cache.sessionId) return;
    setError(null);
    setSwitching(enabled);
    setSessionCacheWarming(props.environmentId, cache.sessionId, { enabled })
      .then((updated) => setAnswered(updated))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not change cache warming."),
      )
      .finally(() => setSwitching(null));
  };

  const change = (delta: number) => {
    const next = Math.min(MAX_HOURS, Math.max(1, hours + delta));
    if (next === hours || !props.environmentId || !cache.sessionId) return;
    const environmentId = props.environmentId;
    const sessionId = cache.sessionId;
    setDraft(next);
    setError(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      setSessionCacheWarming(environmentId, sessionId, { hours: next })
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
    <div className="mb-1 flex flex-col gap-1.5 border-b border-border/60 pb-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-popover-foreground text-xs">Prompt Cache</div>
        <div
          className={cn("text-[11px] tabular-nums", cold ? "font-medium" : "text-popover-foreground")}
          style={cold ? { color: "var(--color-error)" } : undefined}
        >
          {status}
        </div>
      </div>
      {cache.hitPercent != null ? <Row label="Hit rate">{cache.hitPercent}%</Row> : null}
      <div className="flex items-center justify-between gap-2 text-[11px] leading-4">
        <span className="text-popover-foreground/65">Keep warm</span>
        <div className="flex items-center gap-2">
          {globalOff ? <span className="text-popover-foreground/65">{endNote}</span> : null}
          <Switch
            size="sm"
            checked={on}
            disabled={!canChange}
            onCheckedChange={(checked) => switchWarming(checked)}
            aria-label="Keep this thread's prompt cache warm"
          />
        </div>
      </div>
      {on ? (
        <div className="flex items-center justify-between gap-2 pl-2.5 text-[11px] leading-4">
          <span className="text-popover-foreground/65">for</span>
          <div className="flex items-center gap-2">
            <div
              className="flex items-center rounded-md bg-muted/50"
              role="group"
              aria-label="Hours to keep this thread's prompt cache warm"
            >
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="One hour less"
                disabled={!canChange || hours <= 1}
                onClick={() => change(-1)}
              >
                <MinusIcon aria-hidden="true" />
              </Button>
              <span className="w-7 text-center font-medium tabular-nums text-popover-foreground" aria-live="polite">
                {draft != null ? `${draft}h` : left.label}
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
            {endNote ? <span className="w-[4.5rem] text-right tabular-nums text-popover-foreground/65">{endNote}</span> : null}
          </div>
        </div>
      ) : null}
      {on && cold ? (
        <div className="pl-2.5 text-pretty text-[11px] text-popover-foreground/65">
          Warms again after your next message.
        </div>
      ) : null}
      {error ? <div className="text-pretty text-[11px] text-destructive">{error}</div> : null}
    </div>
  );
}
