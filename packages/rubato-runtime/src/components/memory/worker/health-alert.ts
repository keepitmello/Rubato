import type { EntryRenderer } from "@code-yeongyu/senpi"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { safeNotify, type ReflectionCompletionApi, type ReflectionLiveSession } from "./completion"
import {
  detailExcerpt,
  joinFields,
  noticeComponent,
  normalizeRendererText,
  optionalRendererText,
} from "./entry-renderers"
import { readReflectionHealth } from "./health"
import { reflectionRemediation } from "./remediation"

export const REFLECTION_HEALTH_ENTRY_TYPE = "senpi-memory.health"

/** Records the streak episode already announced, beside the completions it was derived from. */
const ANNOUNCED_STREAK_FILE = "health-alert.json"

/**
 * A failure streak is one unresolved episode, not one event per session. The in-process guard
 * is keyed by session, so every restart re-announced a three-day-old failure in a fresh session
 * and the user could not act on it a second time. The marker makes the episode — fingerprint
 * plus the run that started it — the unit of "already told": the notice returns when reflection
 * breaks again after recovering, and stays quiet while the same episode is merely still old.
 */
async function announcedStreak(reflectionDir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(reflectionDir, ANNOUNCED_STREAK_FILE), "utf8"))
    if (parsed === null || typeof parsed !== "object") return undefined
    const { fingerprint, sinceISO } = parsed as { fingerprint?: unknown; sinceISO?: unknown }
    if (typeof fingerprint !== "string" || typeof sinceISO !== "string") return undefined
    return streakKey(fingerprint, sinceISO)
  } catch {
    return undefined
  }
}

function streakKey(fingerprint: string, sinceISO: string): string {
  return `${fingerprint}\u0000${sinceISO}`
}

async function rememberAnnouncedStreak(reflectionDir: string, key: string): Promise<void> {
  const [fingerprint, sinceISO] = key.split("\u0000")
  try {
    await writeFile(
      join(reflectionDir, ANNOUNCED_STREAK_FILE),
      `${JSON.stringify({ fingerprint, sinceISO })}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
  } catch {
    // The notice matters more than the marker: a write failure must not swallow the alert.
  }
}

export interface ReflectionHealthEntry {
  readonly schemaVersion: 1
  readonly identity: string
  readonly streak: number
  readonly fingerprint: string
  readonly lastReason: string
  readonly lastDetail?: string
  readonly sinceISO: string
  readonly recommendation: string
}

// A failure streak is an attention-grabbing state: error tone, with the actionable
// recommendation promoted to the always-visible "why" line rather than hidden in detail.
// Lives here beside the entry shape it renders, so `./health` stays purely derivational.
export const renderReflectionHealthEntry: EntryRenderer<ReflectionHealthEntry> = (entry, options, theme) => {
  const health = entry.data
  if (!health) return undefined
  return noticeComponent(
    {
      glyph: "✗",
      title: `Memory reflection failing · ${health.streak} run${health.streak === 1 ? "" : "s"} in a row`,
      tone: "error",
      why: recommendationWhy(health.recommendation),
      detail: joinFields([
        `reason ${normalizeRendererText(health.lastReason)}`,
        optionalRendererText(health.lastDetail) === undefined ? undefined : detailExcerpt(health.lastDetail ?? ""),
        `since ${normalizeRendererText(health.sinceISO)}`,
        `identity ${normalizeRendererText(health.identity)}`,
      ]),
    },
    options,
    theme,
  )
}

export function registerReflectionHealthRenderer(api: ReflectionCompletionApi): void {
  api.registerEntryRenderer(REFLECTION_HEALTH_ENTRY_TYPE, renderReflectionHealthEntry)
}

/** House why-line: one full English sentence, even when remediation copy is a fragment. */
function recommendationWhy(recommendation: string): string {
  const text = normalizeRendererText(recommendation).trim()
  if (text.length === 0) return "Reflection has failed repeatedly and needs attention."
  const sentence = `${text[0]!.toUpperCase()}${text.slice(1)}`
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

/**
 * Write side of reflection health: reads derived health, then appends a transcript entry and
 * notifies the session. Kept out of `./health` so that module stays purely derivational.
 */
export async function emitReflectionHealthAlert(
  completionsDir: string,
  identity: string,
  live: ReflectionLiveSession | undefined,
  once: (key: string) => boolean,
): Promise<boolean> {
  if (!live?.ui) return false
  const health = await readReflectionHealth(completionsDir)
  if (health.streak < 3 || health.fingerprint.length === 0) return false
  if (health.recentFailureFingerprints.filter((item) => item === health.fingerprint).length < 2) return false
  const reflectionDir = dirname(completionsDir)
  const key = streakKey(health.fingerprint, health.streakSinceISO ?? health.lastFailure?.finishedAt ?? "")
  if ((await announcedStreak(reflectionDir)) === key) return false
  if (!once(`${live.sessionId}:${health.fingerprint}`)) return false
  const failure = health.lastFailure
  const recommendation = reflectionRemediation(failure?.reason, failure?.detail)
  const entry: ReflectionHealthEntry = {
    schemaVersion: 1,
    identity,
    streak: health.streak,
    fingerprint: health.fingerprint,
    lastReason: failure?.reason ?? "failed",
    ...(failure?.detail === undefined ? {} : { lastDetail: failure.detail }),
    sinceISO: health.streakSinceISO ?? failure?.finishedAt ?? new Date(0).toISOString(),
    recommendation,
  }
  live.api.appendEntry(REFLECTION_HEALTH_ENTRY_TYPE, entry)
  safeNotify(live, `Memory reflection has failed ${health.streak} times (${health.fingerprint}). ${recommendation}`, "warning")
  await rememberAnnouncedStreak(reflectionDir, key)
  return true
}
