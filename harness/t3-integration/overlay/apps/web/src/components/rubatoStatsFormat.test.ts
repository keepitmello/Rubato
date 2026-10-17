import { describe, expect, it } from "@effect/vitest";

import type { StatsPeriod } from "../state/rubatoStats";
import {
  attendanceWeeks,
  compactNumber,
  daysSinceFirst,
  duration,
  highlights,
  hours,
  hourLabel,
  mergeModels,
  modelFamily,
  modelName,
  shortDate,
} from "./rubatoStatsFormat";

const KNOWN = [
  { slug: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
  { slug: "opengateway/deepseek/deepseek-v4.1-flash-ultrafast", name: "DeepSeek V4.1 Flash Ultrafast" },
  { slug: "kiro/gpt-5.6-sol", name: "GPT-5.6 Sol" },
];

function period(overrides: Partial<StatsPeriod> = {}): StatsPeriod {
  return {
    days: 7,
    sessions: 3,
    turns: 20,
    calls: 100,
    tokens: { input: 10, cacheRead: 900, cacheWrite: 40, output: 300_000 },
    daily: [["2026-10-16", 15], ["2026-10-17", 5]],
    heat: Array.from({ length: 7 }, () => Array(24).fill(0)),
    hourly: Array(24).fill(0),
    nightShare: 0.25,
    busiest: { day: "2026-10-16", turns: 15 },
    bestStreak: 2,
    levels: { high: 18, max: 2 },
    models: [
      { model: "claude-opus-5-5", calls: 80, input: 10, cacheRead: 800, cacheWrite: 40, output: 200_000 },
      { model: "anthropic/claude-opus-5-5-sub", calls: 5, input: 0, cacheRead: 100, cacheWrite: 0, output: 0 },
      { model: "deepseek/deepseek-v4.1-flash-ultrafast", calls: 15, input: 0, cacheRead: 0, cacheWrite: 0, output: 100_000 },
    ],
    speed: [],
    projects: [],
    delegation: { agents: 0, teams: 0, models: [] },
    work: {
      seconds: 9 * 3600,
      agentSeconds: 14 * 3600,
      activeDays: 2,
      averageSeconds: 4.5 * 3600,
      longestDay: { day: "2026-10-16", seconds: 7 * 3600 },
      daily: [["2026-10-16", 7 * 3600, 12 * 3600], ["2026-10-17", 2 * 3600, 2 * 3600]],
    },
    run: { calls: 40, seconds: 3600, at: "2026-10-16T09:00:00.000Z", title: "Fix the ledger", project: "app" },
    longestSession: null,
    think: {
      chars: 33_325,
      model: "claude-opus-5-5",
      at: "2026-10-16T12:34:00.000Z",
      title: "Rebate Settlement Fix",
      project: "app",
      card: { headline: "Where did −1,931,467 come from?", body: "It chased the gap.", chips: ["Hmm ×285"] },
      cardState: "ready",
    },
    ...overrides,
  };
}

describe("rubatoStatsFormat", () => {
  it("shortens big numbers and keeps small ones exact", () => {
    expect(compactNumber(25_612_809_476)).toBe("25.6B");
    expect(compactNumber(204_000_000_000)).toBe("204B");
    expect(compactNumber(1_000)).toBe("1K");
    expect(compactNumber(987)).toBe("987");
  });

  it("reads durations, hours and dates the way the page shows them", () => {
    expect(duration(10_307)).toBe("2h 52m");
    expect(duration(203_198)).toBe("2 days");
    expect(duration(20)).toBe("1m");
    expect(hourLabel(0)).toBe("12 AM");
    expect(hourLabel(23)).toBe("11 PM");
    expect(shortDate("2026-10-15")).toBe("Oct 15");
    expect(hours(24_840)).toBe("6.9h");
    expect(hours(1_371_240)).toBe("381h");
  });

  it("names a logged model id with the picker's name, through prefixes and -sub", () => {
    expect(modelName("claude-opus-5-5", KNOWN)).toBe("Claude Opus 5.5");
    expect(modelName("anthropic/claude-opus-5-5-sub", KNOWN)).toBe("Claude Opus 5.5");
    expect(modelName("deepseek/deepseek-v4.1-flash-ultrafast", KNOWN)).toBe("DeepSeek V4.1 Flash Ultrafast");
    expect(modelName("kiro/gpt-5.6-sol", KNOWN)).toBe("GPT-5.6 Sol · Kiro");
    expect(modelName("grok-9", KNOWN)).toBe("Grok 9");
    expect(modelName("gpt-6-astra", KNOWN)).toBe("GPT-6 Astra");
    expect(modelName("deepseek-v4.1-flash", KNOWN)).toBe("Deepseek v4.1 Flash");
    expect(modelName("preset:reviewer", KNOWN)).toBe("reviewer");
    expect(modelFamily("gemini-4-argon")).toBe("gemini");
  });

  it("merges ids that read as one model", () => {
    const merged = mergeModels(period().models, KNOWN);
    expect(merged.map((row) => row.name)).toEqual(["Claude Opus 5.5", "DeepSeek V4.1 Flash Ultrafast"]);
    expect(merged[0]!.calls).toBe(85);
  });

  it("plays the card's summary first, and only the highlights the period has", () => {
    const items = highlights(period(), KNOWN);
    expect(items.map((item) => item.key)).toEqual(["think", "run", "busiest", "workday", "favorite", "books", "night"]);
    const workday = items.find((item) => item.key === "workday")!;
    expect(workday.value).toBe(7);
    expect(workday.detail).toContain("12.0h of agent time");
    expect(items[0]!.headline).toBe("Where did −1,931,467 come from?");
    expect(items.find((item) => item.key === "books")!.value).toBe(2);
    const bare = highlights(
      period({
        think: null,
        run: null,
        busiest: null,
        turns: 0,
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        models: [],
        work: { seconds: 0, agentSeconds: 0, activeDays: 0, averageSeconds: 0, longestDay: null, daily: [] },
      }),
      KNOWN,
    );
    expect(bare).toEqual([]);
  });

  it("lays the attendance grid from the Monday before the first day through today", () => {
    const stats = { firstDay: "2026-10-15", today: "2026-10-18", attendance: { "2026-10-15": 3, "2026-10-17": 1 } };
    const days = attendanceWeeks(stats);
    expect(days[0]).toEqual({ day: "2026-10-12", count: 0 });
    expect(days.at(-1)).toEqual({ day: "2026-10-18", count: 0 });
    expect(days.find((entry) => entry.day === "2026-10-15")!.count).toBe(3);
    expect(daysSinceFirst(stats)).toBe(4);
  });
});
