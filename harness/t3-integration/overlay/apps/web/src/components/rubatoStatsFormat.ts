// Words and numbers for the Stats page. Pure, so the page stays about drawing.
import type { StatsPeriod, StatsReady } from "../state/rubatoStats";

export interface KnownModel {
  readonly slug: string;
  readonly name: string;
}

const SCALES: ReadonlyArray<readonly [number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** 25,612,809,476 → "25.6B"; small counts stay exact. */
export function compactNumber(value: number): string {
  for (const [scale, suffix] of SCALES) {
    if (Math.abs(value) >= scale) {
      const scaled = value / scale;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return Math.round(value).toLocaleString("en-US");
}

export function wholeNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAYS_MONDAY_FIRST = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function localDate(day: string): Date {
  return new Date(`${day.slice(0, 10)}T12:00:00`);
}

/** "2026-10-15" → "Oct 15". Also takes an ISO timestamp, read in local time. */
export function shortDate(value: string): string {
  const date = value.length > 10 ? new Date(value) : localDate(value);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function weekday(day: string): string {
  return WEEKDAYS[localDate(day).getDay()]!;
}

export function clock(value: string): string {
  const date = new Date(value);
  const hour = date.getHours();
  return `${hour % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export function hourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

const PROVIDER_PREFIX = /^(anthropic|openai-codex|xai|b-ai|opengateway|cursor|google-vertex|google-antigravity|nanogpt|kiro|opencode)\//;

/**
 * A log or Agent model id ("claude-opus-5-5", "anthropic/claude-opus-5-5-sub",
 * "kiro/gpt-5.6-sol") → the name the model picker shows, else a tidied id.
 */
export function modelName(id: string, known: ReadonlyArray<KnownModel>): string {
  if (id.startsWith("preset:")) return id.slice("preset:".length);
  const bare = id.replace(/-sub$/, "");
  const tail = bare.replace(PROVIDER_PREFIX, "");
  const via = bare === tail ? null : bare.slice(0, bare.indexOf("/"));
  const match =
    known.find((model) => model.slug === bare) ??
    known.find((model) => model.slug === tail || model.slug.endsWith(`/${tail}`));
  const name = match?.name ?? readableId(tail.split("/").at(-1)!);
  return via === "kiro" ? `${name} · Kiro` : name;
}

/** A model id no catalogue names, made readable: "gpt-6-astra" → "GPT-6 Astra". */
export function readableId(id: string): string {
  const words = id.split("-").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (word.toLowerCase() === "gpt" && words[i + 1]) {
      out.push(`GPT-${words[i + 1]}`);
      i += 1;
    } else out.push(/^v?\d/.test(word) ? word : word[0]!.toUpperCase() + word.slice(1));
  }
  return out.join(" ");
}

export type ModelFamily = "claude" | "openai" | "deepseek" | "gemini" | "grok" | "glm" | "other";

export function modelFamily(id: string): ModelFamily {
  const value = id.toLowerCase();
  if (/opus|sonnet|haiku|fable|claude/.test(value)) return "claude";
  if (/deepseek/.test(value)) return "deepseek";
  if (/gpt|codex|\bo\d/.test(value)) return "openai";
  if (/gemini/.test(value)) return "gemini";
  if (/grok/.test(value)) return "grok";
  if (/glm|zhipu|z-ai/.test(value)) return "glm";
  return "other";
}

export const FAMILY_COLORS: Readonly<Record<ModelFamily, string>> = {
  claude: "#ff8a5b",
  openai: "#3fcfb8",
  deepseek: "#6aa7ff",
  gemini: "#a78bfa",
  grok: "#9aa4b2",
  glm: "#f472b6",
  other: "#94a3b8",
};

/** Models merged by the name a person reads, largest first. */
export function mergeModels(rows: StatsPeriod["models"], known: ReadonlyArray<KnownModel>) {
  const merged = new Map<string, { name: string; id: string; tokens: number; cacheRead: number; input: number; calls: number }>();
  for (const row of rows) {
    const name = modelName(row.model, known);
    const held = merged.get(name) ?? { name, id: row.model, tokens: 0, cacheRead: 0, input: 0, calls: 0 };
    held.tokens += row.input + row.cacheRead + row.cacheWrite + row.output;
    held.cacheRead += row.cacheRead;
    held.input += row.input + row.cacheRead + row.cacheWrite;
    held.calls += row.calls;
    merged.set(name, held);
  }
  return [...merged.values()].toSorted((a, b) => b.tokens - a.tokens);
}

export function totalTokens(period: StatsPeriod): number {
  const { input, cacheRead, cacheWrite, output } = period.tokens;
  return input + cacheRead + cacheWrite + output;
}

export function cacheShare(period: StatsPeriod): number {
  const total = totalTokens(period);
  return total ? period.tokens.cacheRead / total : 0;
}

/** A novel of about 150k tokens: the unit for "the model wrote N books". */
export const TOKENS_PER_BOOK = 150_000;

export interface Highlight {
  readonly key: string;
  readonly color: string;
  readonly value: number;
  readonly unit: string;
  readonly label: string;
  readonly headline: string;
  readonly detail: string;
}

/** The ticker's cards for one period, in the order they play. */
export function highlights(period: StatsPeriod, known: ReadonlyArray<KnownModel>): Highlight[] {
  const out: Highlight[] = [];
  const think = period.think;
  if (think) {
    out.push({
      key: "think",
      color: "#a78bfa",
      value: think.chars,
      unit: "characters",
      label: "Longest think",
      headline: think.card?.headline ?? `${modelName(think.model, known)} thought it through`,
      detail: `${modelName(think.model, known)} · ${shortDate(think.at)}. ${think.card?.body ?? `In “${think.title ?? think.project}”.`}`,
    });
  }
  if (period.run) {
    out.push({
      key: "run",
      color: "#ffb86b",
      value: period.run.calls,
      unit: "calls in a row",
      label: "Longest solo run",
      headline: `Kept going for ${duration(period.run.seconds)} on its own`,
      detail: `${shortDate(period.run.at)} · ${period.run.title ?? period.run.project}. Not one message from you in between.`,
    });
  }
  if (period.busiest) {
    const activeDays = period.daily.filter(([, count]) => count > 0).length || 1;
    const average = period.turns / activeDays;
    out.push({
      key: "busiest",
      color: "#6aa7ff",
      value: period.busiest.turns,
      unit: "messages",
      label: "Busiest day",
      headline: `${weekday(period.busiest.day)}, ${shortDate(period.busiest.day)}`,
      detail: `${(period.busiest.turns / average).toFixed(1)}× an ordinary day.`,
    });
  }
  if (period.longestSession) {
    out.push({
      key: "session",
      color: "#3fcfb8",
      value: period.longestSession.turns,
      unit: "turns",
      label: "Longest conversation",
      headline: `“${period.longestSession.title ?? period.longestSession.project}”`,
      detail: `Started ${shortDate(period.longestSession.at)} and ran for ${duration(period.longestSession.seconds)}.`,
    });
  }
  const models = mergeModels(period.models, known);
  const total = models.reduce((sum, model) => sum + model.tokens, 0);
  if (models[0] && total > 0) {
    const [first, second] = models;
    out.push({
      key: "favorite",
      color: FAMILY_COLORS[modelFamily(first.id)],
      value: Math.round((first.tokens / total) * 100),
      unit: "% of tokens",
      label: "Favorite model",
      headline: first.name,
      detail: second
        ? `${wholeNumber(first.calls)} calls. ${Math.max(2, Math.round(first.tokens / Math.max(1, second.tokens)))}× the runner-up, ${second.name}.`
        : `${wholeNumber(first.calls)} calls.`,
    });
  }
  const books = Math.round(period.tokens.output / TOKENS_PER_BOOK);
  if (books > 0) {
    out.push({
      key: "books",
      color: "#9aa6ff",
      value: books,
      unit: books === 1 ? "novel" : "novels",
      label: "Words written",
      headline: `${wholeNumber(books)} ${books === 1 ? "novel" : "novels"} of output`,
      detail: `${compactNumber(period.tokens.output)} output tokens, at about ${compactNumber(TOKENS_PER_BOOK)} tokens a novel.`,
    });
  }
  if (period.turns > 0) {
    out.push({
      key: "night",
      color: "#c4b5fd",
      value: Math.round(period.nightShare * 100),
      unit: "% after midnight",
      label: "Night owl",
      headline: period.nightShare >= 0.2 ? "A night owl, clearly" : "Mostly a daytime worker",
      detail: "Share of your messages sent between midnight and 6 AM.",
    });
  }
  return out;
}

/** Weeks of the attendance grid, Monday first; null pads days before the first week starts. */
export function attendanceWeeks(stats: Pick<StatsReady, "attendance" | "firstDay" | "today">) {
  const first = localDate(stats.firstDay ?? stats.today);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const end = localDate(stats.today);
  const days: Array<{ day: string; count: number }> = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const day = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    days.push({ day, count: stats.attendance[day] ?? 0 });
  }
  return days;
}

/** Calendar days from the first active day through today. */
export function daysSinceFirst(stats: Pick<StatsReady, "firstDay" | "today">): number {
  if (!stats.firstDay) return 0;
  return Math.round((localDate(stats.today).getTime() - localDate(stats.firstDay).getTime()) / 86_400_000) + 1;
}
