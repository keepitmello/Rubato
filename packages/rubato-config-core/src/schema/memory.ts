import * as z from "zod"

// ---------------------------------------------------------------------------
// Reflection
// ---------------------------------------------------------------------------

export const RubatoMemoryReflectionTriggerSchema = z.object({
  step_count: z.number().int().nonnegative().default(25),
  on_compaction: z.boolean().default(true),
}).strict()

export const RubatoMemoryReflectionSchema = z.object({
  enabled: z.boolean().default(true),
  trigger: RubatoMemoryReflectionTriggerSchema.default({ step_count: 25, on_compaction: true }),
  merge: z.enum(["auto", "integration"]).default("auto"),
  category: z.string().min(1).default("quick"),
  timeout_minutes: z.number().int().positive().default(15),
  sandbox: z.enum(["auto", "required", "off"]).default("auto"),
}).strict()

// ---------------------------------------------------------------------------
// Sync + Search (unchanged)
// ---------------------------------------------------------------------------

export const RubatoMemorySyncSchema = z.object({
  remote: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
}).strict()

export const RubatoMemorySearchSchema = z.object({
  enabled: z.boolean().default(true),
}).strict()

// ---------------------------------------------------------------------------
// Nudge
// ---------------------------------------------------------------------------

export const RubatoMemoryNudgeSchema = z.object({
  enabled: z.boolean().default(true),
  every_user_turns: z.number().int().min(1).default(10),
}).strict()

// ---------------------------------------------------------------------------
// Facts (category is deliberately NOT a knob: pinned "quick")
// ---------------------------------------------------------------------------

export const RubatoMemoryFactsSchema = z.object({
  enabled: z.boolean().default(true),
  debounce_settles: z.number().int().min(1).default(4),
}).strict()

// ---------------------------------------------------------------------------
// Dream
// ---------------------------------------------------------------------------

export const RubatoMemoryDreamSchema = z.object({
  enabled: z.boolean().default(true),
  idle_minutes: z.number().int().min(0).default(30),
  min_hours_between: z.number().int().min(1).default(24),
  shutdown_launch: z.boolean().default(true),
  auto_select_max: z.number().int().min(1).max(10).default(5),
  auto_select_max_chars: z.number().int().min(10000).default(150000),
}).strict()

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const RubatoMemoryPeopleSchema = z.object({
  enabled: z.boolean().default(true),
  max_entries: z.number().int().min(1).max(100).default(40),
  max_entry_chars: z.number().int().min(50).max(500).default(200),
}).strict()

// ---------------------------------------------------------------------------
// Soul
// ---------------------------------------------------------------------------

export const RubatoMemorySoulSchema = z.object({
  edit_notice: z.boolean().default(true),
}).strict()

// ---------------------------------------------------------------------------
// Write notice (memory / memory_apply_patch tool-result row)
// ---------------------------------------------------------------------------

export const RubatoMemoryWriteNoticeSchema = z.object({
  enabled: z.boolean().default(true),
}).strict()

// ---------------------------------------------------------------------------
// Layer (deep-partial) variants
// ---------------------------------------------------------------------------

export const RubatoMemoryReflectionTriggerLayerSchema = z.object({
  step_count: z.number().int().nonnegative().optional(),
  on_compaction: z.boolean().optional(),
}).strict()

export const RubatoMemoryReflectionLayerSchema = z.object({
  enabled: z.boolean().optional(),
  trigger: RubatoMemoryReflectionTriggerLayerSchema.optional(),
  merge: z.enum(["auto", "integration"]).optional(),
  category: z.string().min(1).optional(),
  timeout_minutes: z.number().int().positive().optional(),
  sandbox: z.enum(["auto", "required", "off"]).optional(),
}).strict()

export const RubatoMemorySyncLayerSchema = z.object({
  remote: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
}).strict()

export const RubatoMemorySearchLayerSchema = z.object({
  enabled: z.boolean().optional(),
}).strict()

export const RubatoMemoryNudgeLayerSchema = z.object({
  enabled: z.boolean().optional(),
  every_user_turns: z.number().int().min(1).optional(),
}).strict()

export const RubatoMemoryFactsLayerSchema = z.object({
  enabled: z.boolean().optional(),
  debounce_settles: z.number().int().min(1).optional(),
}).strict()

export const RubatoMemoryDreamLayerSchema = z.object({
  enabled: z.boolean().optional(),
  idle_minutes: z.number().int().min(0).optional(),
  min_hours_between: z.number().int().min(1).optional(),
  shutdown_launch: z.boolean().optional(),
  auto_select_max: z.number().int().min(1).max(10).optional(),
  auto_select_max_chars: z.number().int().min(10000).optional(),
}).strict()

export const RubatoMemoryPeopleLayerSchema = z.object({
  enabled: z.boolean().optional(),
  max_entries: z.number().int().min(1).max(100).optional(),
  max_entry_chars: z.number().int().min(50).max(500).optional(),
}).strict()

export const RubatoMemorySoulLayerSchema = z.object({
  edit_notice: z.boolean().optional(),
}).strict()

export const RubatoMemoryWriteNoticeLayerSchema = z.object({
  enabled: z.boolean().optional(),
}).strict()

// ---------------------------------------------------------------------------
// Per-agent overrides (layer-shaped)
// ---------------------------------------------------------------------------

/**
 * A projected memory path: `system/<name>.md`, no traversal, no absolute path.
 *
 * The compiler drops anything that does not match, which made a typo
 * indistinguishable from an intentionally empty whitelist — `["soul.md"]` parsed
 * cleanly and then silently projected nothing. Rejecting at config load turns that
 * into a message instead of a mystery.
 */
const ProjectedMemoryPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), { message: "must be repository-relative, not absolute" })
  .refine((value) => !value.split("/").includes(".."), { message: "must not traverse with .." })
  .refine((value) => value.startsWith("system/"), { message: "must live under system/" })
  .refine((value) => value.endsWith(".md"), { message: "must be a .md file" })

function dropLegacyProjection(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  if (!("projection" in value)) return value
  const { projection: _dropped, ...rest } = value as Record<string, unknown>
  return rest
}

export const RubatoMemoryAgentOverridesSchema = z.preprocess(
  dropLegacyProjection,
  z.object({
  enabled: z.boolean().optional(),
  agent: z.string().min(1).optional(),
  reflection: RubatoMemoryReflectionLayerSchema.optional(),
  nudge: RubatoMemoryNudgeLayerSchema.optional(),
  facts: RubatoMemoryFactsLayerSchema.optional(),
  dream: RubatoMemoryDreamLayerSchema.optional(),
  people: RubatoMemoryPeopleLayerSchema.optional(),
  soul: RubatoMemorySoulLayerSchema.optional(),
  write_notice: RubatoMemoryWriteNoticeLayerSchema.optional(),
  sync: RubatoMemorySyncLayerSchema.optional(),
  search: RubatoMemorySearchLayerSchema.optional(),
  compile_warn_tokens: z.number().int().positive().optional(),
  project: z.array(ProjectedMemoryPathSchema).optional(),
}).strict(),
)

// ---------------------------------------------------------------------------
// Root settings schema
// ---------------------------------------------------------------------------

export const RubatoMemorySettingsSchema = z.preprocess(
  dropLegacyProjection,
  z.object({
  enabled: z.boolean().default(true),
  agent: z.string().min(1).default("auto"),
  // "direct" registers the memory tools as always-on ToolDefinitions; "search" opts in to the
  // extension-declared MCP server surfaced through senpi's tool_search catalog.
  tool_exposure: z.enum(["direct", "search"]).default("direct"),
  reflection: RubatoMemoryReflectionSchema.default({
    enabled: true,
    trigger: { step_count: 25, on_compaction: true },
    merge: "auto",
    category: "quick",
    timeout_minutes: 15,
    sandbox: "auto",
  }),
  nudge: RubatoMemoryNudgeSchema.default({ enabled: true, every_user_turns: 10 }),
  facts: RubatoMemoryFactsSchema.default({ enabled: true, debounce_settles: 4 }),
  dream: RubatoMemoryDreamSchema.default({
    enabled: true,
    idle_minutes: 30,
    min_hours_between: 24,
    shutdown_launch: true,
    auto_select_max: 5,
    auto_select_max_chars: 150000,
  }),
  people: RubatoMemoryPeopleSchema.default({ enabled: true, max_entries: 40, max_entry_chars: 200 }),
  soul: RubatoMemorySoulSchema.default({ edit_notice: true }),
  write_notice: RubatoMemoryWriteNoticeSchema.default({ enabled: true }),
  sync: RubatoMemorySyncSchema.default({ enabled: true }),
  search: RubatoMemorySearchSchema.default({ enabled: true }),
  compile_warn_tokens: z.number().int().positive().default(30000),
  // Whitelist of system/*.md paths inlined into the system prompt every turn. Empty (the default)
  // projects nothing: the repository, the memory tools, and every slash command stay intact, and
  // memory is reached on demand. Listing a path (for example system/soul.md) is a config change,
  // not a code change. Non-system paths are never projected.
  project: z.array(ProjectedMemoryPathSchema).default([]),
  agents: z.record(z.string(), RubatoMemoryAgentOverridesSchema).default({}),
}).strict(),
)

export const RubatoMemorySettingsLayerSchema = z.preprocess(
  dropLegacyProjection,
  z.object({
  enabled: z.boolean().optional(),
  agent: z.string().min(1).optional(),
  tool_exposure: z.enum(["direct", "search"]).optional(),
  reflection: RubatoMemoryReflectionLayerSchema.optional(),
  nudge: RubatoMemoryNudgeLayerSchema.optional(),
  facts: RubatoMemoryFactsLayerSchema.optional(),
  dream: RubatoMemoryDreamLayerSchema.optional(),
  people: RubatoMemoryPeopleLayerSchema.optional(),
  soul: RubatoMemorySoulLayerSchema.optional(),
  write_notice: RubatoMemoryWriteNoticeLayerSchema.optional(),
  sync: RubatoMemorySyncLayerSchema.optional(),
  search: RubatoMemorySearchLayerSchema.optional(),
  compile_warn_tokens: z.number().int().positive().optional(),
  project: z.array(ProjectedMemoryPathSchema).optional(),
  agents: z.record(z.string(), RubatoMemoryAgentOverridesSchema).optional(),
}).strict(),
)

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type RubatoMemoryReflectionTrigger = z.infer<typeof RubatoMemoryReflectionTriggerSchema>
export type RubatoMemoryReflection = z.infer<typeof RubatoMemoryReflectionSchema>
export type RubatoMemorySync = z.infer<typeof RubatoMemorySyncSchema>
export type RubatoMemorySearch = z.infer<typeof RubatoMemorySearchSchema>
export type RubatoMemoryNudge = z.infer<typeof RubatoMemoryNudgeSchema>
export type RubatoMemoryFacts = z.infer<typeof RubatoMemoryFactsSchema>
export type RubatoMemoryDream = z.infer<typeof RubatoMemoryDreamSchema>
export type RubatoMemoryPeople = z.infer<typeof RubatoMemoryPeopleSchema>
export type RubatoMemorySoul = z.infer<typeof RubatoMemorySoulSchema>
export type RubatoMemoryWriteNotice = z.infer<typeof RubatoMemoryWriteNoticeSchema>
export type RubatoMemoryAgentOverrides = z.infer<typeof RubatoMemoryAgentOverridesSchema>
export type RubatoMemorySettings = z.infer<typeof RubatoMemorySettingsSchema>
export type RubatoMemorySettingsLayer = z.infer<typeof RubatoMemorySettingsLayerSchema>
