import { availableParallelism } from "node:os"

import * as z from "zod"

// 0 is the numeric spelling of "unlimited" for every cap below: the senpi-task engine maps a 0
// concurrency limit to Infinity and treats a 0 residency cap exactly like the "unlimited" literal.
const ResidencyMaxChildrenInputSchema = z.union([z.number().int().nonnegative(), z.literal("unlimited")])

export const RubatoTaskWaitSchema = z.object({
  min_ms: z.number().int().positive().default(5000),
  default_ms: z.number().int().positive().default(60000),
  max_ms: z.number().int().positive().default(600000),
}).strict()

export const RubatoTaskTeamSettingsSchema = z.object({
  max_members: z.number().int().min(1).max(8).default(8),
  max_parallel_members: z.number().int().min(1).max(8).default(4),
  max_wall_clock_minutes: z.number().int().positive().default(120),
}).strict()

export const RubatoTaskWarningsSchema = z.object({
  unavailable_categories: z.boolean().default(true),
}).strict()

// Bounds for the dag orchestration subsystem. The whole block is optional, but once present every
// key falls back to the engine default in senpi-task's DAG_SETTINGS_DEFAULTS.
export const RubatoTaskDagSettingsSchema = z.object({
  max_nodes_per_run: z.number().int().positive().default(64),
  max_runs_per_session: z.number().int().positive().default(16),
  subscriber_ring: z.number().int().positive().default(1000),
  heartbeat_ms: z.number().int().positive().default(15000),
  history_default_limit: z.number().int().positive().default(256),
  history_max_limit: z.number().int().positive().default(1000),
  retention_days: z.number().int().positive().default(7),
  max_prompt_bytes: z.number().int().positive().default(262144),
}).strict()

export const RubatoTaskSettingsSchema = z.object({
  default_execution_mode: z.enum(["in-process", "process"]).default("in-process"),
  default_concurrency: z.number().int().nonnegative().default(5),
  global_concurrency: z.number().int().nonnegative().default(8),
  provider_concurrency: z.record(z.string(), z.number().int().nonnegative()).optional(),
  model_concurrency: z.record(z.string(), z.number().int().nonnegative()).optional(),
  max_depth: z.number().int().nonnegative().default(1),
  residency_max_children: ResidencyMaxChildrenInputSchema.default(8),
  ttl_ms: z.number().int().positive().default(86400000),
  state_dir: z.string().optional(),
  reattach_on_reconcile: z.boolean().optional(),
  resume_children: z.boolean().default(true),
  warnings: RubatoTaskWarningsSchema.default({ unavailable_categories: true }),
  wait: RubatoTaskWaitSchema.default({ min_ms: 5000, default_ms: 60000, max_ms: 600000 }),
  team: RubatoTaskTeamSettingsSchema.default({
    max_members: 8,
    max_parallel_members: 4,
    max_wall_clock_minutes: 120,
  }),
  dag: RubatoTaskDagSettingsSchema.optional(),
}).strict()

export const RubatoTaskDagSettingsLayerSchema = z.object({
  max_nodes_per_run: z.number().int().positive().optional(),
  max_runs_per_session: z.number().int().positive().optional(),
  subscriber_ring: z.number().int().positive().optional(),
  heartbeat_ms: z.number().int().positive().optional(),
  history_default_limit: z.number().int().positive().optional(),
  history_max_limit: z.number().int().positive().optional(),
  retention_days: z.number().int().positive().optional(),
  max_prompt_bytes: z.number().int().positive().optional(),
}).strict()

export const RubatoTaskWaitLayerSchema = z.object({
  min_ms: z.number().int().positive().optional(),
  default_ms: z.number().int().positive().optional(),
  max_ms: z.number().int().positive().optional(),
}).strict()

export const RubatoTaskTeamSettingsLayerSchema = z.object({
  max_members: z.number().int().min(1).max(8).optional(),
  max_parallel_members: z.number().int().min(1).max(8).optional(),
  max_wall_clock_minutes: z.number().int().positive().optional(),
}).strict()

export const RubatoTaskWarningsLayerSchema = z.object({
  unavailable_categories: z.boolean().optional(),
}).strict()

export const RubatoTaskSettingsLayerSchema = z.object({
  default_execution_mode: z.enum(["in-process", "process"]).optional(),
  default_concurrency: z.number().int().nonnegative().optional(),
  global_concurrency: z.number().int().nonnegative().optional(),
  provider_concurrency: z.record(z.string(), z.number().int().nonnegative()).optional(),
  model_concurrency: z.record(z.string(), z.number().int().nonnegative()).optional(),
  max_depth: z.number().int().nonnegative().optional(),
  residency_max_children: ResidencyMaxChildrenInputSchema.optional(),
  ttl_ms: z.number().int().positive().optional(),
  state_dir: z.string().optional(),
  reattach_on_reconcile: z.boolean().optional(),
  resume_children: z.boolean().optional(),
  warnings: RubatoTaskWarningsLayerSchema.optional(),
  wait: RubatoTaskWaitLayerSchema.optional(),
  team: RubatoTaskTeamSettingsLayerSchema.optional(),
  dag: RubatoTaskDagSettingsLayerSchema.optional(),
}).strict()

export type RubatoTaskDagSettings = z.infer<typeof RubatoTaskDagSettingsSchema>
export type RubatoTaskSettings = z.infer<typeof RubatoTaskSettingsSchema>
export type RubatoTaskSettingsLayer = z.infer<typeof RubatoTaskSettingsLayerSchema>

export function resolveRubatoTaskSettings(
  input: unknown,
  resolveParallelism: () => number = availableParallelism,
): RubatoTaskSettings {
  const record = z.record(z.string(), z.unknown()).parse(input)
  return RubatoTaskSettingsSchema.parse({
    ...record,
    residency_max_children: record["residency_max_children"] ?? Math.max(8, resolveParallelism() * 3),
    global_concurrency: record["global_concurrency"] ?? Math.max(8, resolveParallelism() * 2),
  })
}
