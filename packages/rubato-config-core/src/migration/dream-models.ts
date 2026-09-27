import { join } from "node:path"

import { isPlainObject } from "../internal/plain-object"
import { parseJsoncSafe } from "../internal/jsonc-parse"
import { mergeRubatoConfigRecords, resolveUserRubatoConfigDirectory } from "../loader"
import { normalizeLegacyModelFields } from "../schema/fallback-models"
import { isReasoningLevel } from "../schema/reasoning-vocabulary"
import type { RubatoMemoryDreamModel } from "../schema/memory"
import { runMigrations } from "./batch"
import { hasMigrationMarker } from "./predicate"
import { DEFAULT_MIGRATION_FILE_SYSTEM, type MigrationPlan, type MigrationRunResult, type RunMigrationsOptions } from "./types"

export const DREAM_MODELS_MIGRATION_ID = "2026-09-dream-models"

// The category the dream ran on when memory.dream.category was unset.
const LEGACY_DREAM_CATEGORY = "grok"
const TYPED_HARNESS_KEYS = ["[senpi]", "[codex]"] as const

type Document = Readonly<Record<string, unknown>>

function record(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}

function at(document: Document, ...path: readonly string[]): unknown {
  let current: unknown = document
  for (const key of path) current = record(current)?.[key]
  return current
}

/** Every layer that could carry categories or a dream category: the root, harness blocks, profiles and their harness blocks. */
function layerPaths(document: Document): readonly (readonly string[])[] {
  const roots: string[][] = [[]]
  for (const [name] of Object.entries(record(document["profiles"]) ?? {})) roots.push(["profiles", name])
  return roots.flatMap((root) => [root, ...TYPED_HARNESS_KEYS.map((harness) => [...root, harness])])
}

function legacyPaths(document: Document): readonly (readonly string[])[] {
  const found: (readonly string[])[] = []
  for (const layer of layerPaths(document)) {
    for (const path of [["categories"], ["memory", "dream", "category"], ["task", "warnings"]]) {
      if (at(document, ...layer, ...path) !== undefined) found.push([...layer, ...path])
    }
  }
  return found
}

function rung(model: unknown, reasoning: unknown): RubatoMemoryDreamModel | undefined {
  if (typeof model !== "string" || !model.includes("/")) return undefined
  return typeof reasoning === "string" && isReasoningLevel(reasoning) ? { model, reasoning } : { model }
}

/**
 * The ladder the dream read from its category, in the Senpi view it loaded (root layer with `[senpi]` over it):
 * `model` first with the category's reasoning, then each `models` entry, repeats dropped.
 */
export function legacyDreamLadder(document: Document): readonly RubatoMemoryDreamModel[] {
  const dreamCategory = at(document, "[senpi]", "memory", "dream", "category") ?? at(document, "memory", "dream", "category")
  const name = typeof dreamCategory === "string" && dreamCategory !== "" ? dreamCategory : LEGACY_DREAM_CATEGORY
  const merged = mergeRubatoConfigRecords(
    record(at(document, "categories", name)) ?? {},
    record(at(document, "[senpi]", "categories", name)) ?? {},
  )
  const entry = normalizeLegacyModelFields(merged)
  const ladder: RubatoMemoryDreamModel[] = []
  const push = (candidate: RubatoMemoryDreamModel | undefined) => {
    if (candidate === undefined) return
    const model = typeof candidate === "string" ? candidate : candidate.model
    if (ladder.some((existing) => (typeof existing === "string" ? existing : existing.model) === model)) return
    ladder.push(candidate)
  }
  push(rung(entry["model"], entry["reasoning"]))
  for (const item of Array.isArray(entry["models"]) ? entry["models"] : []) {
    if (typeof item === "string") push(rung(item, entry["reasoning"]))
    else if (isPlainObject(item)) {
      const normalized = normalizeLegacyModelFields(item)
      push(rung(normalized["model"], normalized["reasoning"] ?? entry["reasoning"]))
    }
  }
  return ladder
}

function withoutPath(document: Record<string, unknown>, path: readonly string[]): void {
  const parent = path.slice(0, -1).reduce<Record<string, unknown> | undefined>((current, key) => record(current?.[key]), document)
  const last = path.at(-1)
  if (parent === undefined || last === undefined) return
  delete parent[last]
  // A block the removal emptied (task: { warnings } → task: {}) goes with it; a profile stays, even empty.
  const parentPath = path.slice(0, -1)
  const isProfile = parentPath.length === 2 && parentPath[0] === "profiles"
  if (parentPath.length > 0 && !isProfile && Object.keys(parent).length === 0) withoutPath(document, parentPath)
}

function clone(value: Document): Record<string, unknown> {
  const copy: unknown = JSON.parse(JSON.stringify(value))
  return record(copy) ?? {}
}

/**
 * Moves the dream's ladder out of its category into memory.dream.models (unless models is already set),
 * then drops every categories block, memory.dream.category and task.warnings in every layer.
 */
export function migrateDreamModelsDocument(document: Document): { readonly diagnostics: readonly string[]; readonly document: Record<string, unknown> } {
  const next = clone(document)
  const diagnostics: string[] = []
  const hasModels = at(document, "memory", "dream", "models") !== undefined
    || at(document, "[senpi]", "memory", "dream", "models") !== undefined
  if (!hasModels) {
    const ladder = legacyDreamLadder(document)
    if (ladder.length > 0) {
      const memory = record(next["memory"]) ?? {}
      const dream = record(memory["dream"]) ?? {}
      next["memory"] = { ...memory, dream: { ...dream, models: ladder } }
    } else {
      diagnostics.push("memory.dream.models: the dream's category had no models; the default ladder applies")
    }
  }
  for (const path of legacyPaths(next)) withoutPath(next, path)
  return { diagnostics, document: next }
}

/** Whether a config still carries anything this migration moves or removes. */
export function needsDreamModelsMigration(document: Document): boolean {
  return !hasMigrationMarker(document, DREAM_MODELS_MIGRATION_ID) && legacyPaths(document).length > 0
}

export function dreamModelsMigrationPlan(targetPath: string): MigrationPlan {
  return {
    id: DREAM_MODELS_MIGRATION_ID,
    mode: "replace-target",
    sources: [],
    targetPath,
    transform: (sources) => migrateDreamModelsDocument(record(sources[0]?.value) ?? {}),
  }
}

export type MigrateUserConfigDreamModelsOptions = Omit<RunMigrationsOptions, "discover">

/**
 * Runs the dream-models migration on the user config (~/.rubato/rubato.jsonc, else rubato.json).
 * A config with nothing to move is left untouched, marker included.
 */
export function migrateUserConfigDreamModels(options: MigrateUserConfigDreamModelsOptions = {}): MigrationRunResult | undefined {
  const home = process.env["HOME"]
  const env = options.env ?? (home === undefined ? {} : { HOME: home })
  const fileSystem = options.fileSystem ?? DEFAULT_MIGRATION_FILE_SYSTEM
  const directory = resolveUserRubatoConfigDirectory(env)
  const targetPath = [join(directory, "rubato.jsonc"), join(directory, "rubato.json")].find((path) => fileSystem.existsSync(path))
  if (targetPath === undefined) return undefined
  const parsed = parseJsoncSafe<unknown>(fileSystem.readFileSync(targetPath, "utf-8"))
  const document = record(parsed.data)
  if (parsed.errors.length > 0 || document === undefined || !needsDreamModelsMigration(document)) return undefined
  const result = runMigrations({ ...options, env, fileSystem, discover: () => [dreamModelsMigrationPlan(targetPath)] })
  return result.results[0] ?? { diagnostics: [], journalResumed: result.journalResumed, status: result.status === "locked" ? "locked" : "skipped" }
}
