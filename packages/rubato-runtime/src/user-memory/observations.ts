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
/**
 * Observations from dreams that do not keep project runs (the companion's, harness/companion/dream):
 * `<user store runtime>/inbox/<name>.json`, each an Observation array, taken once like a project run.
 */
export const INBOX_DIR = "inbox"
/**
 * What dictation heard and what the person sent instead, one JSON object per line
 * (`{"at", "from", "to"}`), written by the Mac's voice service (harness/t3-integration
 * src/voice/vocabulary.mjs). The user dream reads the lines newer than its last run.
 */
export const CORRECTIONS_FILE = "dictation-corrections.jsonl"
const CORRECTIONS_PER_RUN = 300
const LEGACY_CANDIDATES = join("out", "user-candidates.md")
const RETENTION_MS = 60 * 24 * 60 * 60_000
const LEGACY_RUNS_PER_STORE = 30

export interface Observation {
  /** English statement of the durable fact or preference. */
  readonly claim: string
  /** The task, decision and circumstances the quoted words were about, not a standing preference. */
  readonly situation?: string
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
  /**
   * A name or term the user says, spelled as it should be written: dictation should get it right
   * (the user dream keeps them in vocabulary/dictation-terms.md, which the voice service sends as hints).
   */
  readonly term?: string
}

/** One word or phrase dictation got wrong and the person fixed before sending. */
export interface Correction {
  readonly at: string
  readonly from: string
  readonly to: string
}

export interface InputsLedger {
  /** Project runs whose observations a user dream already took, by run id → when. */
  readonly consumed?: Readonly<Record<string, string>>
  /** Hash of the legacy user.md content already carried over. */
  readonly userMd?: string
  /** The newest dictation correction a user dream already took. */
  readonly correctionsAt?: string
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
    const term = typeof value.term === "string" ? cleanTerm(value.term) : undefined
    if (term !== undefined && (typeof value.claim !== "string" || value.claim.trim() === "")) {
      value.claim = `The user says "${term}"`
    }
    if (typeof value.claim !== "string" || value.claim.trim() === "") continue
    const quote = typeof value.quote === "string" && value.quote.trim() !== "" ? value.quote.trim() : undefined
    const sessionId = typeof value.session === "string" ? value.session : undefined
    const turn = quote === undefined ? undefined : locateQuote(quote, sessions, sessionId)
    // If a project child omits the situation, keep what the user actually said around the quote.
    // Unknown context is surfaced as unknown by the user dream, never inferred from the claim.
    const situation = typeof value.situation === "string" && value.situation.trim() !== "" ? value.situation.trim()
      : term === undefined ? turn?.context : undefined
    found.push({
      claim: value.claim.trim(),
      ...(situation === undefined ? {} : { situation }),
      ...(term === undefined ? {} : { term }),
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

/** A term as a hint can carry it: one line, no angle brackets, not empty, not long. */
export function cleanTerm(value: string): string | undefined {
  const term = value.replace(/\s+/g, " ").trim()
  if (term === "" || term.length > 60 || /[<>\r\n]/.test(term)) return undefined
  return term
}

function locateQuote(quote: string, sessions: readonly CondensedSession[], preferred: string | undefined) {
  const needle = foldText(quote).trim()
  const ordered = [...sessions].sort((a, b) => Number(b.header.id === preferred) - Number(a.header.id === preferred))
  for (const session of ordered) {
    for (const turn of session.userTurns) {
      if (foldText(turn.text).includes(needle)) {
        const exact = turn.text.indexOf(quote)
        const start = Math.max(0, exact - 300)
        const context = turn.text === quote ? undefined : `Same user turn (excerpt): ${turn.text.slice(start, start + 800)}`
        return { session: session.header.id, at: turn.at, context }
      }
    }
  }
  return undefined
}

export interface PendingInputs {
  readonly observations: readonly Observation[]
  /** Runs (and inbox files, as `inbox:<name>`) whose observations these are; marked consumed when the user dream lands or finds nothing. */
  readonly runs: readonly string[]
  /** Dictation corrections since the last user dream, oldest first. */
  readonly corrections: readonly Correction[]
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
  for (const name of safeList(join(store.paths.runtime, INBOX_DIR)).filter((entry) => entry.endsWith(".json")).sort()) {
    const key = `inbox:${name}`
    if (consumed[key] !== undefined) continue
    const list = await readJsonFile<Observation[]>(join(store.paths.runtime, INBOX_DIR, name))
    if (Array.isArray(list)) {
      observations.push(...list.filter((entry) => typeof entry?.claim === "string")
        .filter((entry) => entry.seenAt === undefined || now - Date.parse(entry.seenAt) <= RETENTION_MS))
    }
    runs.push(key)
  }
  const corrections = await readCorrections(store, ledger.correctionsAt, now)
  const legacyText = (await readFile(join(selfRepoPath(memoryRoot), "user.md"), "utf8").catch(() => "")).trim()
  const hash = legacyText === "" ? undefined : createHash("sha256").update(legacyText).digest("hex")
  return {
    observations,
    runs,
    corrections,
    ...(hash !== undefined && hash !== ledger.userMd ? { legacyProfile: { text: legacyText, hash } } : {}),
  }
}

/** The corrections written after `since`, within the retention, at most CORRECTIONS_PER_RUN (the newest). */
async function readCorrections(store: UserStore, since: string | undefined, now: number): Promise<Correction[]> {
  const text = await readFile(join(store.paths.runtime, CORRECTIONS_FILE), "utf8").catch(() => "")
  const floor = Math.max(Date.parse(since ?? "") || 0, now - RETENTION_MS)
  const found: Correction[] = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof value.at !== "string" || typeof value.from !== "string" || typeof value.to !== "string") continue
    if (!(Date.parse(value.at) > floor)) continue
    found.push({ at: value.at, from: value.from, to: value.to })
  }
  return found.slice(-CORRECTIONS_PER_RUN)
}

export function hasPending(pending: PendingInputs): boolean {
  return pending.runs.length > 0 || pending.legacyProfile !== undefined || pending.corrections.length > 0
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
    ...(pending.corrections.length === 0 ? {} : { correctionsAt: pending.corrections.at(-1)!.at }),
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

