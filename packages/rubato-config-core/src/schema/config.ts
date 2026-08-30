import * as z from "zod"

import { RubatoAgentsConfigSchema } from "./agent"
import { RubatoCategoriesConfigSchema } from "./category"
import { RubatoCodegraphSettingsLayerSchema, RubatoCodegraphSettingsSchema } from "./codegraph"
import { RubatoHarnessIdSchema, type RubatoHarnessId } from "./harness"
import { RubatoMemorySettingsLayerSchema, RubatoMemorySettingsSchema } from "./memory"
import { RubatoModelCatalogLayerSchema, RubatoModelCatalogSchema } from "./model-catalog"
import { RubatoTaskSettingsLayerSchema, RubatoTaskSettingsSchema } from "./task"
import { RubatoTeamsConfigLayerSchema, RubatoTeamsConfigSchema } from "./team"
import { RubatoTelemetrySettingsLayerSchema, RubatoTelemetrySettingsSchema } from "./telemetry"

export type { RubatoHarnessId }
export { RubatoHarnessIdSchema }

export const RubatoOpenCodeHarnessConfigSchema = z.record(z.string(), z.unknown())

export const RubatoTypedHarnessConfigSchema = z.object({
  categories: RubatoCategoriesConfigSchema.optional(),
  agents: RubatoAgentsConfigSchema.optional(),
  codegraph: RubatoCodegraphSettingsLayerSchema.optional(),
  task: RubatoTaskSettingsLayerSchema.optional(),
  teams: RubatoTeamsConfigLayerSchema.optional(),
  models: RubatoModelCatalogLayerSchema.optional(),
  memory: RubatoMemorySettingsLayerSchema.optional(),
  telemetry: RubatoTelemetrySettingsLayerSchema.optional(),
}).strict()

export const RubatoConfigProfileSchema = z.object({
  categories: RubatoCategoriesConfigSchema.optional(),
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
}).strict()

export const RubatoConfigSchema = z.object({
  $schema: z.string().optional(),
  categories: RubatoCategoriesConfigSchema.optional(),
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
}).strict()

export const RubatoConfigLayerSchema = z.object({
  $schema: z.string().optional(),
  categories: RubatoCategoriesConfigSchema.optional(),
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
}).strict()

type RubatoParsedConfig = z.infer<typeof RubatoConfigSchema>

export type RubatoConfig = Omit<RubatoParsedConfig, "profiles"> & {
  readonly profiles?: RubatoParsedConfig["profiles"]
}
