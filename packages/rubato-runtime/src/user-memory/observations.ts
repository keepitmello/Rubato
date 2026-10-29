// What the user dream curates from. A project dream reads its sessions and writes what it noticed about
// the person to `$OUT_DIR/user-observations.jsonl`; the runner checks each quote against the user turns
// it handed over, which gives the words their real time (a forget only blocks words said before it),
// and keeps the result as `runs/<runId>/user-observations.json`. Nothing is approved: the user dream
// takes every observation from runs that finished (merged or noop) and has not taken yet.
//
// Transition: runs from before this kept `out/user-candidates.md` lines waiting for approval in the
// settings page, and the self store may hold a hand-kept user.md. Both are carried in as inputs the
// same way, once; candidate lines the user dismissed there stay out; the files themselves are left as
// they are.

import { createHash } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { buildIdentityPaths, isUserStore, selfRepoPath } from "@rubato/memory-core"

import type { CondensedSession } from "../dream/transcript"
import { foldText } from "./ledger"
import { readJsonFile, writeJsonFile, type UserStore } from "./store"

export const OBSERVATIONS_OUT = "user-observations.jsonl"
export const OBSERVATIONS_FILE = "user-observations.json"
const LEGACY_CANDIDATES = join("out", "user-candidates.md")
const RETENTION_MS = 60 * 24 * 60 * 60_000
const LEGACY_RUNS_PER_STORE = 30

export interface Observation {
  /** English statement of the durable fact or preference. */
  readonly claim: string
  /** The user's own words, verbatim. */
  readonly quote?: string
  readonly session?: string
  /** When the quoted words were said, from the session itself; absent when the quote could not be found. */
  readonly at?: string
  /** The project store whose dream noticed it. */
  readonly project?: string
  readonly runId?: string
  /** When the run that noticed it started: a date to show, not proof of when it was said. */
  readonly seenAt?: string
  readonly kind: "session" | "legacy-candidate"
}

export interface InputsLedger {
  /** Project runs whose observations a user dream already took, by run id → when. */
  readonly consumed?: Readonly<Record<string, string>>
  /** Hash of the legacy user.md content already carried over. */
  readonly userMd?: string
  readonly lastAt?: string
  readonly lastRunId?: string
  readonly lastStatus?: string
  readonly failedAt?: string
}

/** Parses a project dream's observations and dates each quote from the user turns it was given. */
export function normalizeObservations(
  jsonl: string,
  sessions: readonly CondensedSession[],
  source: { readonly project: string; readonly runId: string; readonly seenAt: string },
): Observation[] {
  const found: Observation[] = []
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || !trimmed.startsWith("{")) continue
    let value: Record<string, unknown>
    try {
      value = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof value.claim !== "string" || value.claim.trim() === "") continue
    const quote = typeof value.quote === "string" && value.quote.trim() !== "" ? value.quote.trim() : undefined
    const sessionId = typeof value.session === "string" ? value.session : undefined
    const turn = quote === undefined ? undefined : locateQuote(quote, sessions, sessionId)
    found.push({
      claim: value.claim.trim(),
      ...(quote === undefined ? {} : { quote }),
      ...((turn?.session ?? sessionId) === undefined ? {} : { session: turn?.session ?? sessionId }),
      ...(turn === undefined ? {} : { at: turn.at }),
      project: source.project,
      runId: source.runId,
      seenAt: source.seenAt,
      kind: "session",
    })
  }
  return found
}

function locateQuote(quote: string, sessions: readonly CondensedSession[], preferred: string | undefined) {
  const needle = foldText(quote).trim()
  const ordered = [...sessions].sort((a, b) => Number(b.header.id === preferred) - Number(a.header.id === preferred))
  for (const session of ordered) {
    for (const turn of session.userTurns) {
      if (foldText(turn.text).includes(needle)) return { session: session.header.id, at: turn.at }
    }
  }
  return undefined
}

export interface PendingInputs {
  readonly observations: readonly Observation[]
  /** Runs whose observations these are; marked consumed when the user dream lands or finds nothing. */
  readonly runs: readonly string[]
  /** The legacy user.md to carry over, when it has content not carried yet. */
  readonly legacyProfile?: { readonly text: string; readonly hash: string }
}

/** Everything a user dream has not taken yet, across every project store. */
export async function collectPending(memoryRoot: string, store: UserStore, now: number): Promise<PendingInputs> {
  const ledger = (await readJsonFile<InputsLedger>(store.inputs)) ?? {}
  const consumed = ledger.consumed ?? {}
  const dismissed = new Set(((await readJsonFile<{ lines?: unknown }>(join(memoryRoot, "self", "dismissed-suggestions.json")))?.lines as unknown[] | undefined ?? [])
    .filter((line): line is string => typeof line === "string"))
  const observations: Observation[] = []
  const runs: string[] = []
  const legacyClaims = new Set<string>()
  for (const project of projectStores(memoryRoot)) {
    const runsDir = join(buildIdentityPaths(memoryRoot, project).runtime, "dream", "runs")
    const records: { runId: string; startedAt: string; status?: string; review?: string }[] = []
    for (const runId of safeList(runsDir)) {
      const record = await readJsonFile<{ startedAt?: string; status?: string; review?: string }>(join(runsDir, runId, "run.json"))
      if (record === undefined || typeof record.startedAt !== "string") continue
      records.push({ runId, startedAt: record.startedAt, ...(record.status === undefined ? {} : { status: record.status }), ...(record.review === undefined ? {} : { review: record.review }) })
    }
    records.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    let legacySeen = 0
    for (const run of records) {
      if (consumed[run.runId] !== undefined) continue
      const finished = run.status === "merged" || run.status === "noop" || run.review === "merged"
      if (!finished) continue
      const dir = join(runsDir, run.runId)
      if (existsSync(join(dir, OBSERVATIONS_FILE))) {
        if (now - Date.parse(run.startedAt) > RETENTION_MS) continue
        const list = await readJsonFile<Observation[]>(join(dir, OBSERVATIONS_FILE))
        if (Array.isArray(list)) observations.push(...list.filter((entry) => typeof entry?.claim === "string"))
        runs.push(run.runId)
      } else if (existsSync(join(dir, LEGACY_CANDIDATES)) && legacySeen < LEGACY_RUNS_PER_STORE) {
        // The settings page offered the newest 30 runs per store; that is what was waiting for the user.
        legacySeen += 1
        for (const line of candidateLines(await readFile(join(dir, LEGACY_CANDIDATES), "utf8").catch(() => ""))) {
          if (dismissed.has(line) || legacyClaims.has(line)) continue
          legacyClaims.add(line)
          const quote = /["“「]([^"”」]+)["”」]/.exec(line)?.[1]
          observations.push({ claim: line, ...(quote === undefined ? {} : { quote }), project, runId: run.runId, seenAt: run.startedAt, kind: "legacy-candidate" })
        }
        runs.push(run.runId)
      }
    }
  }
  const legacyText = (await readFile(join(selfRepoPath(memoryRoot), "user.md"), "utf8").catch(() => "")).trim()
  const hash = legacyText === "" ? undefined : createHash("sha256").update(legacyText).digest("hex")
  return {
    observations,
    runs,
    ...(hash !== undefined && hash !== ledger.userMd ? { legacyProfile: { text: legacyText, hash } } : {}),
  }
}

export function hasPending(pending: PendingInputs): boolean {
  return pending.runs.length > 0 || pending.legacyProfile !== undefined
}

/** Marks the inputs taken: they are never offered again. */
export async function consumeInputs(store: UserStore, pending: PendingInputs, outcome: { readonly runId: string; readonly status: string; readonly at: string }, now: number): Promise<void> {
  const ledger = (await readJsonFile<InputsLedger>(store.inputs)) ?? {}
  const floor = now - 2 * RETENTION_MS
  const consumed: Record<string, string> = {}
  for (const [runId, at] of Object.entries(ledger.consumed ?? {})) if (Date.parse(at) >= floor) consumed[runId] = at
  for (const runId of pending.runs) consumed[runId] = outcome.at
  const { failedAt: _cleared, ...rest } = ledger
  await writeJsonFile(store.inputs, {
    ...rest,
    consumed,
    ...(pending.legacyProfile === undefined ? {} : { userMd: pending.legacyProfile.hash }),
    lastAt: outcome.at,
    lastRunId: outcome.runId,
    lastStatus: outcome.status,
  })
}

export async function recordFailure(store: UserStore, outcome: { readonly runId: string; readonly at: string }): Promise<void> {
  const ledger = (await readJsonFile<InputsLedger>(store.inputs)) ?? {}
  await writeJsonFile(store.inputs, { ...ledger, failedAt: outcome.at, lastRunId: outcome.runId, lastStatus: "failed" })
}

export async function readInputsLedger(store: UserStore): Promise<InputsLedger> {
  return (await readJsonFile<InputsLedger>(store.inputs)) ?? {}
}

function projectStores(memoryRoot: string): string[] {
  const agents = join(memoryRoot, "agents")
  return safeList(agents).filter((name) => !isUserStore(name) && existsSync(join(agents, name, "repo", ".git"))).sort()
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function candidateLines(text: string): string[] {
  return text.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line !== "")
}

