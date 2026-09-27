import * as z from "zod"

import { RubatoAgentsConfigSchema } from "./agent"
import { RubatoCodegraphSettingsLayerSchema, RubatoCodegraphSettingsSchema } from "./codegraph"
import { RubatoHarnessIdSchema, type RubatoHarnessId } from "./harness"
import { RubatoMemorySettingsLayerSchema, RubatoMemorySettingsSchema } from "./memory"
import { RubatoModelCatalogLayerSchema, RubatoModelCatalogSchema } from "./model-catalog"
import { RubatoTaskSettingsLayerSchema, RubatoTaskSettingsSchema } from "./task"
import { RubatoTeamsConfigLayerSchema, RubatoTeamsConfigSchema } from "./team"
import { RubatoTelemetrySettingsLayerSchema, RubatoTelemetrySettingsSchema } from "./telemetry"

export type { RubatoHarnessId }
export { RubatoHarnessIdSchema }

// Task categories (named model ladders) were a Senpi routing layer nothing reads any more: subagents
// name their model or preset directly, and the dream keeps its own ladder in memory.dream.models.
// Existing configs still carry the key, so it is dropped on load instead of failing strict parsing.
function dropLegacyCategories(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("categories" in value)) return value
  const { categories: _categories, ...rest } = value as Record<string, unknown>
  return rest
}

export const RubatoOpenCodeHarnessConfigSchema = z.record(z.string(), z.unknown())

export const RubatoTypedHarnessConfigSchema = z.preprocess(dropLegacyCategories, z.object({
  agents: RubatoAgentsConfigSchema.optional(),
  codegraph: RubatoCodegraphSettingsLayerSchema.optional(),
  task: RubatoTaskSettingsLayerSchema.optional(),
  teams: RubatoTeamsConfigLayerSchema.optional(),
  models: RubatoModelCatalogLayerSchema.optional(),
  memory: RubatoMemorySettingsLayerSchema.optional(),
  telemetry: RubatoTelemetrySettingsLayerSchema.optional(),
}).strict())

export const RubatoConfigProfileSchema = z.preprocess(dropLegacyCategories, z.object({
  agents: RubatoAgentsConfigSchema.optional(),
  codegraph: RubatoCodegraphSettingsLayerSchema.optional(),
  task: RubatoTaskSettingsLayerSchema.optional(),
  teams: RubatoTeamsConfigLayerSchema.optional(),
  models: RubatoModelCatalogLayerSchema.optional(),
  memory: RubatoMemorySettingsLayerSchema.optional(),
  telemetry: RubatoTelemetrySettingsLayerSchema.optional(),
  "[opencode]": RubatoOpenCodeHarnessConfigSchema.optional(),
  "[senpi]": RubatoTypedHarnessConfigSchema.optional(),
  "[codex]": RubatoTypedHarnessConfigSchema.optional(),
}).strict())

export const RubatoConfigSchema = z.preprocess(dropLegacyCategories, z.object({
  $schema: z.string().optional(),
  agents: RubatoAgentsConfigSchema.optional(),
  codegraph: RubatoCodegraphSettingsSchema.optional(),
  task: RubatoTaskSettingsSchema.optional(),
  teams: RubatoTeamsConfigSchema.optional(),
  models: RubatoModelCatalogSchema.optional(),
  memory: RubatoMemorySettingsSchema.optional(),
  telemetry: RubatoTelemetrySettingsSchema.optional(),
  "[opencode]": RubatoOpenCodeHarnessConfigSchema.optional(),
  "[senpi]": RubatoTypedHarnessConfigSchema.optional(),
  "[codex]": RubatoTypedHarnessConfigSchema.optional(),
  profiles: z.record(z.string(), RubatoConfigProfileSchema).default({}),
  _migrations: z.array(z.string()).optional(),
  legacy_migrations: z.record(z.string(), z.unknown()).optional(),
}).strict())

export const RubatoConfigLayerSchema = z.preprocess(dropLegacyCategories, z.object({
  $schema: z.string().optional(),
  agents: RubatoAgentsConfigSchema.optional(),
  codegraph: RubatoCodegraphSettingsLayerSchema.optional(),
  task: RubatoTaskSettingsLayerSchema.optional(),
  teams: RubatoTeamsConfigLayerSchema.optional(),
  models: RubatoModelCatalogLayerSchema.optional(),
  memory: RubatoMemorySettingsLayerSchema.optional(),
  telemetry: RubatoTelemetrySettingsLayerSchema.optional(),
  "[opencode]": RubatoOpenCodeHarnessConfigSchema.optional(),
  "[senpi]": RubatoTypedHarnessConfigSchema.optional(),
  "[codex]": RubatoTypedHarnessConfigSchema.optional(),
  profiles: z.record(z.string(), RubatoConfigProfileSchema).optional(),
  _migrations: z.array(z.string()).optional(),
  legacy_migrations: z.record(z.string(), z.unknown()).optional(),
}).strict())

type RubatoParsedConfig = z.infer<typeof RubatoConfigSchema>

export type RubatoConfig = Omit<RubatoParsedConfig, "profiles"> & {
  readonly profiles?: RubatoParsedConfig["profiles"]
}
