// Rubato: whether a usage window will last until it resets, as CodexBar tells it.
//
// T3 marks on each bar where an even spend would stand by now. This module says how far the
// account is off that mark and, at the speed so far, when it runs out: "12% in deficit · Runs
// out in 21h 32m", or "8% in reserve · Lasts until reset". The desktop's and the phone's Usage
// pages colour the mark from the same answer: red in deficit, green in reserve.
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

const MINUTE = 60_000;
const WEEK_MINUTES = 7 * 24 * 60;

/** Inside this many points of even spend the account is on pace. */
const ON_PACE_POINTS = 2;
/** Before this much of the window has passed, the speed so far says little. */
const MIN_EXPECTED_PERCENT = 3;

export type PaceStage = "deficit" | "reserve" | "on";

export interface PaceForecast {
  readonly stage: PaceStage;
  /** Points between what is used and what an even spend would have used by now. */
  readonly deltaPercent: number;
  /** Milliseconds until the window empties at the speed so far; null when it lasts. */
  readonly runsOutInMs: number | null;
  readonly lastsUntilReset: boolean;
}

function windowMinutes(window: ServerProviderUsageWindow): number | null {
  if (window.windowDurationMins !== undefined) return window.windowDurationMins;
  return window.kind === "weekly" ? WEEK_MINUTES : null;
}

export function paceForecast(window: ServerProviderUsageWindow, now: number): PaceForecast | null {
  if (window.resetsAt === undefined) return null;
  const resetsAt = Date.parse(window.resetsAt);
  const minutes = windowMinutes(window);
  if (!Number.isFinite(resetsAt) || minutes === null || minutes <= 0) return null;
  const length = minutes * MINUTE;
  const untilReset = resetsAt - now;
  if (untilReset <= 0 || untilReset > length) return null;
  const elapsed = length - untilReset;
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const expected = (elapsed / length) * 100;
  if (used >= 100 || expected < MIN_EXPECTED_PERCENT) return null;
  const delta = used - expected;
  const stage: PaceStage =
    Math.abs(delta) <= ON_PACE_POINTS ? "on" : delta > 0 ? "deficit" : "reserve";
  const runsOut = used > 0 ? ((100 - used) / used) * elapsed : Number.POSITIVE_INFINITY;
  const lastsUntilReset = runsOut >= untilReset;
  return {
    stage,
    deltaPercent: Math.round(Math.abs(delta)),
    runsOutInMs: lastsUntilReset ? null : runsOut,
    lastsUntilReset,
  };
}

const TEXT = {
  en: {
    deficit: (points: number) => `${points}% in deficit`,
    reserve: (points: number) => `${points}% in reserve`,
    on: "On pace",
    lasts: "Lasts until reset",
    runsOut: (duration: string) => `Runs out in ${duration}`,
  },
  ko: {
    deficit: (points: number) => `${points}% 부족`,
    reserve: (points: number) => `${points}% 여유`,
    on: "정상 속도",
    lasts: "재설정까지 유지",
    runsOut: (duration: string) => `${duration} 후 소진`,
  },
} as const;

/**
 * The line under a bar. Korean is written here rather than swapped from the dictionary, since the
 * phone has no dictionary pass for text outside T3's catalog.
 */
export function paceForecastText(
  forecast: PaceForecast,
  locale: string,
  formatDuration: (ms: number) => string,
): string {
  const text = locale.toLowerCase().startsWith("ko") ? TEXT.ko : TEXT.en;
  const pace =
    forecast.stage === "on" || forecast.deltaPercent === 0
      ? text.on
      : text[forecast.stage](forecast.deltaPercent);
  const end =
    forecast.runsOutInMs === null ? text.lasts : text.runsOut(formatDuration(forecast.runsOutInMs));
  return `${pace} · ${end}`;
}
