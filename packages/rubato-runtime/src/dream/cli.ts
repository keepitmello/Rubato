#!/usr/bin/env bun
// rubato dream — the daily memory maintenance run, one store at a time.
//
//   rubato dream              show every store: dream on/off, last run, new sessions
//   rubato dream --due        run each enabled store whose last dream is old enough and has new sessions
//   rubato dream <store>...   run those stores now, even with no new sessions
//   --revert <store> <runId>  take a landed dream back out with one revert commit
//   --migrate <store>         run the one-time English migration for that store now (it otherwise runs
//                             on the store's next dream, once)
//   --json                    machine-readable output (the GUI reads this)
//   --trial [--base REV] [--since ISO] <store>
//                             run without merging: result stays on a branch, the clock does not move

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { migrateUserConfigDreamModels, RubatoMemorySettingsSchema } from "@rubato/config-core"
import { buildIdentityPaths, readStoreRecord, resolveMemoryRoot } from "@rubato/memory-core"

import { loadSenpiRubatoConfig } from "../components/config-resolution"
import { dreamLadder } from "./ladder"
import {
  readDreamState,
  revertDream,
  runDream,
  sessionSinceMs,
  type DreamRunRecord,
  type DreamRung,
  type DreamState,
} from "./runner"
import { agentDir, childEnv } from "./child-env"
import { liveMemoryVerdict } from "./live-guard"
import { languageMigrationDue, runLanguageMigration } from "./migrate-language"
import { countStoreFiles, createStoreNameResolver, listExistingStores, scanStoreSessions, type SessionFile } from "./stores"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..", "..")

interface StoreStatus {
  readonly store: string
  readonly enabled: boolean
  readonly lastDreamAt?: string
  readonly lastRunId?: string
  readonly newSessions: number
  readonly due: boolean
  /** Project roots the store is used from (store.json). */
  readonly roots: readonly string[]
  /** The home-directory store. */
  readonly home: boolean
  /** Markdown files in the store. */
  readonly files: number
  /** The one-time English migration has not run yet (or failed and may retry). */
  readonly migrationDue: boolean
}

async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json")
  const due = argv.includes("--due")
  const trial = argv.includes("--trial")
  const base = optionValue(argv, "--base")
  const sinceIso = optionValue(argv, "--since")
  const migrateStore = optionValue(argv, "--migrate")
  const named = argv.filter((arg, index) => !arg.startsWith("--") && !["--base", "--since", "--migrate"].includes(argv[index - 1] ?? ""))
  const env = process.env
  const now = Date.now()
  const revertStore = optionValue(argv, "--revert")
  const writes = due || named.length > 0 || revertStore !== undefined || migrateStore !== undefined

  // Only the installed Rubato on the default profile touches the default memory root (live-guard.ts).
  // Any other copy may still read the status; it writes nothing, the user config included.
  const verdict = liveMemoryVerdict({ env, home: homedir(), cliPath: fileURLToPath(import.meta.url) })
  if (!verdict.allowed && writes) {
    process.stderr.write(`rubato dream: ${verdict.reason}; nothing ran\n`)
    return due ? 0 : 2
  }

  // Moves the old category ladder into memory.dream.models and drops the category keys, once,
  // with a backup. Sessions start `dream --due`, so every install passes here. A failure only
  // means the old keys stay; loading already ignores them.
  if (verdict.allowed) {
    try {
      migrateUserConfigDreamModels({ env })
    } catch {}
  }

  const userConfig = loadSenpiRubatoConfig({ cwd: homedir(), env }).config
  const memory = userConfig.memory ?? RubatoMemorySettingsSchema.parse({})
  const dream = memory.dream
  const models = dreamLadder(dream.models)
  const memoryRoot = resolveMemoryRoot(env, homedir())
  const pathsOf = (store: string) => buildIdentityPaths(memoryRoot, store)

  const states = new Map<string, DreamState>()
  for (const store of listExistingStores(memoryRoot)) states.set(store, await readDreamState(pathsOf(store)))

  if (revertStore !== undefined) {
    const runId = argv[argv.indexOf("--revert") + 2]
    if (runId === undefined || runId.startsWith("--")) {
      process.stderr.write("rubato dream: --revert needs a store and a run id\n")
      return 2
    }
    if (!states.has(revertStore)) {
      process.stderr.write(`rubato dream: no memory store named ${revertStore}\n`)
      return 2
    }
    await revertDream(pathsOf(revertStore), revertStore, runId, env)
    process.stdout.write(json
      ? `${JSON.stringify({ store: revertStore, runId, review: "reverted" })}\n`
      : `dream: ${revertStore} ${runId} reverted\n`)
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
    resolveStore: createStoreNameResolver((cwd) => loadSenpiRubatoConfig({ cwd, env }).config.memory?.agent, env),
  })
  const sessionsByStore = scan.sessions
  const minGapMs = dream.min_hours_between * 60 * 60_000
  const statuses: StoreStatus[] = []
  const migrationDue = new Map<string, boolean>()
  for (const store of states.keys()) migrationDue.set(store, await languageMigrationDue(pathsOf(store), now, minGapMs))
  for (const [store, state] of states) {
    const record = readStoreRecord(pathsOf(store).root)
    const enabled = dream.stores[store]?.enabled !== false
    const newSessions = sessionsByStore.get(store)?.length ?? 0
    const lastMs = state.last_dream_at === undefined ? 0 : Date.parse(state.last_dream_at)
    statuses.push({
      store,
      enabled,
      ...(state.last_dream_at === undefined ? {} : { lastDreamAt: state.last_dream_at }),
      ...(state.lastRunId === undefined ? {} : { lastRunId: state.lastRunId }),
      newSessions,
      due: enabled && newSessions > 0 && now - lastMs >= minGapMs,
      roots: record?.roots ?? [],
      home: record?.home === true,
      files: countStoreFiles(pathsOf(store).repo),
      migrationDue: migrationDue.get(store) === true,
    })
  }

  if (!due && named.length === 0 && migrateStore === undefined) {
    if (json) process.stdout.write(`${JSON.stringify({ models, stores: statuses }, null, 2)}\n`)
    else printStatuses(statuses, models)
    return 0
  }

  const targets = migrateStore !== undefined ? [] : due ? statuses.filter((status) => status.due).map((status) => status.store) : named
  // The English migration runs once per store, before that store's next dream: every enabled store on
  // `--due` (new sessions or not, so a quiet store migrates too), each named store, or `--migrate`.
  const migrations = migrateStore !== undefined
    ? [migrateStore]
    : trial
      ? []
      : due
        ? statuses.filter((status) => status.enabled && status.migrationDue).map((status) => status.store)
        : named.filter((store) => migrationDue.get(store) === true)
  const unknown = [...targets, ...migrations].filter((store) => !states.has(store))
  if (unknown.length > 0) {
    process.stderr.write(`rubato dream: no memory store named ${unknown.join(", ")}\n`)
    return 2
  }
  // Nothing due is the common answer to the session-start/end ask: finish before touching the engine.
  if (targets.length === 0 && migrations.length === 0) {
    if (json) process.stdout.write(`${JSON.stringify({ runs: [] }, null, 2)}\n`)
    return 0
  }
  const launch = await resolveLaunch(env)
  const systemPrompt = [
    readFileSync(join(here, "dream-persona.md"), "utf8"),
    readFileSync(join(repoRoot, "harness", "skills", "memory-discipline", "SKILL.md"), "utf8"),
  ].join("\n\n")

  const records: DreamRunRecord[] = []
  for (const store of migrations) {
    if (!json) process.stderr.write(`dream: ${store} English migration …\n`)
    const record = await runLanguageMigration({
      store,
      paths: pathsOf(store),
      ladder: models,
      launch,
      systemPrompt: readFileSync(join(here, "language-migration.md"), "utf8"),
      env: childEnv(env),
      force: migrateStore !== undefined,
    })
    records.push(record)
    if (!json) process.stderr.write(`dream: ${store} English migration ${record.status}${record.reason === undefined ? "" : ` (${record.reason})`} ${record.commits.length} commit(s)${record.runId === "" ? "" : ` run ${record.runId}`}\n`)
  }
  for (const store of targets) {
    if (!json) process.stderr.write(`dream: ${store} …\n`)
    const record = await runDream({
      store,
      paths: pathsOf(store),
      sessions: sessionsByStore.get(store) ?? ([] as SessionFile[]),
      ladder: models,
      launch,
      systemPrompt,
      env: childEnv(env),
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

function printStatuses(all: readonly StoreStatus[], models: readonly DreamRung[]): void {
  let statuses = all
  const ladder = models.map((rung) => rung.thinking === undefined ? rung.model : `${rung.model} (${rung.thinking})`)
  process.stdout.write(`dream models: ${ladder.length === 0 ? "none" : ladder.join(" → ")}\n\n`)
  // Stores with nothing to show would bury the ones in use under test leftovers.
  statuses = statuses.filter((status) => status.enabled || status.lastDreamAt !== undefined)
  for (const status of statuses) {
    const last = status.lastDreamAt === undefined ? "never" : status.lastDreamAt
    const flag = status.enabled ? "on " : "off"
    process.stdout.write(`${flag}  ${status.store.padEnd(28)} last ${last}  new sessions ${status.newSessions}${status.due ? "  due" : ""}\n`)
  }
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
