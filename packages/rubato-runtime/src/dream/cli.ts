#!/usr/bin/env bun
// rubato dream — the daily memory maintenance run, one store at a time.
//
//   rubato dream              show every store: dream on/off, last run, new sessions
//   rubato dream --due        run each enabled store whose last dream is old enough and has new sessions
//   rubato dream <store>...   run those stores now, even with no new sessions
//   --approve <store>         land the dream waiting for review in that store
//   --reject <store>          drop it (what it read stays read)
//   --json                    machine-readable output (the GUI reads this)
//   --trial [--base REV] [--since ISO] <store>
//                             run without merging: result stays on a branch, the clock does not move

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { RubatoMemorySettingsSchema } from "@rubato/config-core"
import { resolveMemoryIdentity, resolveMemoryRoot } from "@rubato/memory-core"

import { loadSenpiRubatoConfig } from "../components/config-resolution"
import { dreamLadder } from "./ladder"
import {
  approveDream,
  readDreamState,
  readPendingReview,
  rejectDream,
  runDream,
  sessionSinceMs,
  type DreamRunRecord,
  type DreamState,
} from "./runner"
import { createStoreNameResolver, listExistingStores, scanStoreSessions, type SessionFile } from "./stores"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..", "..")

interface StoreStatus {
  readonly store: string
  readonly enabled: boolean
  readonly lastDreamAt?: string
  readonly lastRunId?: string
  readonly pendingRunId?: string
  readonly newSessions: number
  readonly due: boolean
}

async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json")
  const due = argv.includes("--due")
  const trial = argv.includes("--trial")
  const base = optionValue(argv, "--base")
  const sinceIso = optionValue(argv, "--since")
  const named = argv.filter((arg, index) => !arg.startsWith("--") && !["--base", "--since", "--approve", "--reject"].includes(argv[index - 1] ?? ""))
  const env = process.env
  const now = Date.now()

  const userConfig = loadSenpiRubatoConfig({ cwd: homedir(), env }).config
  const memory = userConfig.memory ?? RubatoMemorySettingsSchema.parse({})
  const dream = memory.dream
  const category = dream.category ?? memory.reflection.category
  const memoryRoot = resolveMemoryRoot(env, homedir())
  const pathsOf = (store: string) => resolveMemoryIdentity(store, homedir(), env).paths

  const states = new Map<string, DreamState>()
  for (const store of listExistingStores(memoryRoot)) states.set(store, await readDreamState(pathsOf(store)))

  for (const flag of ["--approve", "--reject"] as const) {
    const store = optionValue(argv, flag)
    if (store === undefined) continue
    if (!states.has(store)) {
      process.stderr.write(`rubato dream: no memory store named ${store}\n`)
      return 2
    }
    const runId = flag === "--approve"
      ? await approveDream(pathsOf(store), store, env)
      : await rejectDream(pathsOf(store), store, env)
    process.stdout.write(json
      ? `${JSON.stringify({ store, runId, review: flag === "--approve" ? "merged" : "rejected" })}\n`
      : `dream: ${store} ${runId} ${flag === "--approve" ? "merged" : "rejected"}\n`)
    return 0
  }
  const trialSinceMs = sinceIso === undefined ? undefined : Date.parse(sinceIso)
  if (trialSinceMs !== undefined && !Number.isFinite(trialSinceMs)) {
    process.stderr.write(`rubato dream: --since is not a date: ${sinceIso}\n`)
    return 2
  }
  const scan = scanStoreSessions({
    sessionsRoot: join(agentDir(env), "sessions"),
    sinceMs: (store, sessionId) => trialSinceMs ?? sessionSinceMs(states.get(store) ?? {}, sessionId, now),
    resolveStore: createStoreNameResolver((cwd) => loadSenpiRubatoConfig({ cwd, env }).config.memory?.agent),
  })
  const sessionsByStore = scan.sessions
  const minGapMs = dream.min_hours_between * 60 * 60_000
  const statuses: StoreStatus[] = []
  for (const [store, state] of states) {
    const pending = await readPendingReview(pathsOf(store))
    // Per store only: memory.dream.enabled still gates the old in-session dream until it is removed.
    const enabled = dream.stores[store]?.enabled === true
    const newSessions = sessionsByStore.get(store)?.length ?? 0
    const lastMs = state.last_dream_at === undefined ? 0 : Date.parse(state.last_dream_at)
    statuses.push({
      store,
      enabled,
      ...(state.last_dream_at === undefined ? {} : { lastDreamAt: state.last_dream_at }),
      ...(state.lastRunId === undefined ? {} : { lastRunId: state.lastRunId }),
      ...(pending === undefined ? {} : { pendingRunId: pending.runId }),
      newSessions,
      due: enabled && pending === undefined && newSessions > 0 && now - lastMs >= minGapMs,
    })
  }

  if (!due && named.length === 0) {
    if (json) process.stdout.write(`${JSON.stringify({ category, stores: statuses }, null, 2)}\n`)
    else printStatuses(statuses, category)
    return 0
  }

  const targets = due ? statuses.filter((status) => status.due).map((status) => status.store) : named
  const unknown = targets.filter((store) => !states.has(store))
  if (unknown.length > 0) {
    process.stderr.write(`rubato dream: no memory store named ${unknown.join(", ")}\n`)
    return 2
  }
  const ladder = dreamLadder(userConfig, category)
  const launch = await resolveLaunch(env)
  const systemPrompt = [
    readFileSync(join(here, "dream-persona.md"), "utf8"),
    readFileSync(join(repoRoot, "harness", "skills", "memory-discipline", "SKILL.md"), "utf8"),
  ].join("\n\n")

  const records: DreamRunRecord[] = []
  for (const store of targets) {
    if (!json) process.stderr.write(`dream: ${store} …\n`)
    const record = await runDream({
      store,
      paths: pathsOf(store),
      sessions: sessionsByStore.get(store) ?? ([] as SessionFile[]),
      ladder,
      launch,
      systemPrompt,
      env: childEnv(env),
      publish: dream.publish,
      projectFolders: [...(scan.folders.get(store) ?? [])],
      force: !due,
      ...(trial ? { trial: { ...(base === undefined ? {} : { baseRevision: base }), ...(trialSinceMs === undefined ? {} : { sinceMs: trialSinceMs }) } } : {}),
    })
    records.push(record)
    if (!json) process.stderr.write(`dream: ${store} ${record.status}${record.reason === undefined ? "" : ` (${record.reason})`} ${record.commits.length} commit(s)${record.branch === undefined ? "" : ` on ${record.branch}`}\n`)
  }
  if (json) process.stdout.write(`${JSON.stringify({ runs: records }, null, 2)}\n`)
  return records.some((record) => record.status === "failed") ? 1 : 0
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function printStatuses(all: readonly StoreStatus[], category: string): void {
  let statuses = all
  process.stdout.write(`dream model category: ${category}\n\n`)
  // Stores with nothing to show would bury the ones in use under test leftovers.
  statuses = statuses.filter((status) => status.enabled || status.lastDreamAt !== undefined || status.pendingRunId !== undefined)
  for (const status of statuses) {
    const last = status.lastDreamAt === undefined ? "never" : status.lastDreamAt
    const flag = status.enabled ? "on " : "off"
    const review = status.pendingRunId === undefined ? "" : `  waiting for review: ${status.pendingRunId}`
    process.stdout.write(`${flag}  ${status.store.padEnd(28)} last ${last}  new sessions ${status.newSessions}${status.due ? "  due" : ""}${review}\n`)
  }
}

function agentDir(env: NodeJS.ProcessEnv): string {
  const pinned = env.RUBATO_PI_CODING_AGENT_DIR
  return pinned !== undefined && pinned.trim() !== "" ? pinned : join(env.HOME ?? homedir(), ".rubato-pi", "agent")
}

// The dream child is a fresh engine process, not a child of whatever session ran this command:
// drop the caller's session identity and pin the profile directory, as `rubato dispatch` does.
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of [
    "PI_CODING_AGENT_SESSION_DIR", "SENPI_CODING_AGENT_SESSION_DIR", "PI_SESSION_FILE", "PI_SESSION_ID",
    "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL", "PI_PACKAGE_DIR", "SENPI_PACKAGE_DIR",
    "PI_MANAGED_INSTALL_ROOT", "PI_CODING_AGENT",
  ]) delete out[key]
  const dir = agentDir(env)
  out.PI_CODING_AGENT_DIR = dir
  out.RUBATO_PI_CODING_AGENT_DIR = dir
  out.DO_NOT_TRACK = "1"
  return out
}

async function resolveLaunch(env: NodeJS.ProcessEnv) {
  const enginePaths = await import(join(repoRoot, "harness", "rubato-pi", "src", "engine-paths.mjs"))
  const childRuntime = await import(join(repoRoot, "harness", "pi-runtime", "features", "child-runtime", "stock-rpc-runtime.mjs"))
  const root: string = enginePaths.resolvePiEngineDir(env)
  return childRuntime.resolvePiMemoryChildLaunch({ root }) as {
    command: string
    prefixArgs: readonly string[]
    env?: Readonly<Record<string, string>>
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`rubato dream: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  },
)
