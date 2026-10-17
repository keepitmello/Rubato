import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "./environments";
import { postRubato } from "./rubatoHttp";
import { usePreparedConnection } from "./session";

/** The route Rubato adds to the T3 server on this Mac for the Stats page. */
const STATS_ROUTE = "/rubato/stats";

export type StatsPeriodName = "week" | "month" | "all";

export interface StatsModelRow {
  readonly model: string;
  readonly calls: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export interface StatsRecordMeta {
  readonly title: string | null;
  readonly project: string;
  readonly at: string;
}

export type StatsEpisodeKind = "mind" | "cost" | "swarm" | "night" | "outage" | "solo" | "first";

/**
 * A moment from the person's history. `headline` and `story` are plain English built from
 * the numbers until a model has retold it (`storyState: "written"`); "writing" means that
 * is under way on the server, "plain" that no model could write it.
 */
export interface StatsEpisode {
  readonly id: string;
  readonly kind: StatsEpisodeKind;
  readonly at: string;
  readonly value: number;
  readonly title: string | null;
  readonly project: string;
  readonly facts: Readonly<Record<string, string | number>>;
  readonly headline: string;
  readonly story: string;
  readonly storyState: "written" | "writing" | "plain";
}

export interface StatsPeriod {
  readonly days: number | null;
  readonly sessions: number;
  readonly turns: number;
  readonly calls: number;
  readonly tokens: { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number; readonly output: number };
  /** [day, messages], every calendar day of the period. */
  readonly daily: ReadonlyArray<readonly [string, number]>;
  /** Messages by weekday (Monday first) and hour. */
  readonly heat: ReadonlyArray<ReadonlyArray<number>>;
  readonly hourly: ReadonlyArray<number>;
  readonly nightShare: number;
  readonly busiest: { readonly day: string; readonly turns: number } | null;
  readonly bestStreak: number;
  /** Messages by the thinking level they went out with. */
  readonly levels: Readonly<Record<string, number>>;
  readonly models: ReadonlyArray<StatsModelRow>;
  readonly speed: ReadonlyArray<{ readonly model: string; readonly score: number; readonly samples: number }>;
  readonly projects: ReadonlyArray<{
    readonly path: string | null;
    readonly name: string;
    readonly sessions: number;
    readonly turns: number;
    readonly tokens: number;
    readonly topModel: string | null;
  }>;
  readonly delegation: {
    readonly agents: number;
    readonly teams: number;
    readonly models: ReadonlyArray<{ readonly model: string; readonly count: number }>;
  };
  /**
   * Time the agents worked. `seconds` is wall-clock time with at least one session working;
   * `agentSeconds` adds every session's time, so parallel work counts once per session.
   * `daily` rows are [day, seconds, agentSeconds] for every day of the period.
   */
  readonly work: {
    readonly seconds: number;
    readonly agentSeconds: number;
    readonly activeDays: number;
    readonly averageSeconds: number;
    readonly longestDay: { readonly day: string; readonly seconds: number } | null;
    readonly daily: ReadonlyArray<readonly [string, number, number]>;
  };
  readonly run: (StatsRecordMeta & { readonly calls: number; readonly seconds: number }) | null;
  readonly longestSession: (StatsRecordMeta & { readonly turns: number; readonly seconds: number }) | null;
  /** The strongest moment of each kind in the period, newest first. */
  readonly episodes: ReadonlyArray<StatsEpisode>;
}

export interface StatsReady {
  readonly status: "ready";
  /** True while a rescan runs behind this answer. */
  readonly refreshing: boolean;
  readonly generatedAt: string;
  readonly today: string;
  readonly firstDay: string | null;
  readonly activeDays: number;
  readonly currentStreak: number;
  readonly bestStreak: number;
  /** Messages per day, all time: the attendance grid. */
  readonly attendance: Readonly<Record<string, number>>;
  readonly periods: Readonly<Record<StatsPeriodName, StatsPeriod>>;
}

export interface StatsScanning {
  readonly status: "scanning";
  readonly progress: { readonly done: number; readonly total: number };
}

export type StatsAnswer = StatsReady | StatsScanning;

export const rubatoStats = {
  summary: (env: EnvironmentId | null) => postRubato<StatsAnswer>(env, STATS_ROUTE, "summary", {}, "stats"),
  /** Reads the logs ahead of the first visit; writes no stories. */
  warm: (env: EnvironmentId | null) => postRubato<{ status: string }>(env, STATS_ROUTE, "warm", {}, "stats"),
};

let warmed = false;

/**
 * Once per app load, a while after the connection is ready, has the server read the logs,
 * so the Stats page opens on numbers instead of a progress bar. The rail mounts it.
 */
export function useStatsWarmup(delayMs = 15_000) {
  const environmentId = usePrimaryEnvironmentId();
  const ready = Option.isSome(usePreparedConnection(environmentId));
  useEffect(() => {
    if (!ready || warmed) return;
    const timer = setTimeout(() => {
      warmed = true;
      rubatoStats.warm(environmentId).catch(() => {
        warmed = false;
      });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [ready, environmentId, delayMs]);
}
