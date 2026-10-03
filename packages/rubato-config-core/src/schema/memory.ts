import * as z from "zod"

import { REASONING_LEVELS, type ReasoningLevel } from "./reasoning-vocabulary"

// ---------------------------------------------------------------------------
// Legacy keys
// ---------------------------------------------------------------------------

// Keys earlier memory runtimes read (the 25-turn reflection, the per-turn save nudge, the
// system/ projection and its token warning, soul notices, per-agent overrides, the in-session
// dream's triggers and its category name). Existing configs still carry them, so they are dropped
// on load instead of failing strict parsing; anything else unknown still fails.
const LEGACY_MEMORY_KEYS = [
  "projection",
  "reflection",
  "nudge",
  "soul",
  "write_notice",
  "sync",
  "compile_warn_tokens",
  "project",
  "agents",
] as const

// "publish" chose between landing a dream and holding it for approval; dreams always land now.
const LEGACY_DREAM_KEYS = [
  "category",
  "publish",
  "enabled",
  "idle_minutes",
  "shutdown_launch",
  "auto_select_max",
  "auto_select_max_chars",
] as const

function dropKeys(value: unknown, keys: readonly string[]): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  if (!keys.some((key) => key in value)) return value
  const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  for (const key of keys) delete rest[key]
  return rest
}

const dropLegacyMemoryKeys = (value: unknown): unknown => dropKeys(value, LEGACY_MEMORY_KEYS)
const dropLegacyDreamKeys = (value: unknown): unknown => dropKeys(value, LEGACY_DREAM_KEYS)

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const RubatoMemorySearchSchema = z.object({
  enabled: z.boolean().default(true),
}).strict()

export const RubatoMemorySearchLayerSchema = z.object({
  enabled: z.boolean().optional(),
}).strict()

// ---------------------------------------------------------------------------
// Dream
// ---------------------------------------------------------------------------

// One rung of the dream's model ladder: "<provider>/<id>", optionally with its reasoning level.
export const RubatoMemoryDreamModelSchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    reasoning: z.enum(REASONING_LEVELS).optional(),
  }).strict(),
])

/** The ladder the dream runs on when `dream.models` is unset: DeepSeek first, then Grok, then Haiku. */
export const DEFAULT_DREAM_MODELS: readonly { readonly model: string; readonly reasoning: ReasoningLevel }[] = Object.freeze([
  { model: "b-ai/deepseek-v4.1-flash", reasoning: "medium" },
  { model: "xai/grok-4.7", reasoning: "medium" },
  { model: "anthropic/claude-haiku-4-5", reasoning: "off" },
])

const defaultDreamModels = (): RubatoMemoryDreamModel[] => DEFAULT_DREAM_MODELS.map((rung) => ({ ...rung }))

export const RubatoMemoryDreamStoreSchema = z.object({
  enabled: z.boolean().default(false),
}).strict()

export const RubatoMemoryDreamSchema = z.preprocess(
  dropLegacyDreamKeys,
  z.object({
    // Models the dream child runs on, in fallback order.
    models: z.array(RubatoMemoryDreamModelSchema).default(defaultDreamModels),
    // Stores the daily dream maintains, keyed by memory store name (memory.agent). Off unless listed.
    stores: z.record(z.string(), RubatoMemoryDreamStoreSchema).default({}),
    min_hours_between: z.number().int().min(1).default(20),
  }).strict(),
)

export const RubatoMemoryDreamLayerSchema = z.preprocess(
  dropLegacyDreamKeys,
  z.object({
    models: z.array(RubatoMemoryDreamModelSchema).optional(),
    stores: z.record(z.string(), RubatoMemoryDreamStoreSchema.partial()).optional(),
    min_hours_between: z.number().int().min(1).optional(),
  }).strict(),
)

// ---------------------------------------------------------------------------
// Root settings schema
// ---------------------------------------------------------------------------

export const RubatoMemorySettingsSchema = z.preprocess(
  dropLegacyMemoryKeys,
  z.object({
    enabled: z.boolean().default(true),
    // The store this folder writes to. "auto" (the default) means none: unnamed folders keep no memory.
    agent: z.string().min(1).default("auto"),
    // "direct" registers the memory tools as always-on ToolDefinitions; "search" opts in to the
    // extension-declared MCP server surfaced through the tool_search catalog.
    tool_exposure: z.enum(["direct", "search"]).default("direct"),
    dream: RubatoMemoryDreamSchema.default({
      models: defaultDreamModels(),
      stores: {},
      min_hours_between: 20,
    }),
    search: RubatoMemorySearchSchema.default({ enabled: true }),
  }).strict(),
)

export const RubatoMemorySettingsLayerSchema = z.preprocess(
  dropLegacyMemoryKeys,
  z.object({
    enabled: z.boolean().optional(),
    agent: z.string().min(1).optional(),
    tool_exposure: z.enum(["direct", "search"]).optional(),
    dream: RubatoMemoryDreamLayerSchema.optional(),
    search: RubatoMemorySearchLayerSchema.optional(),
  }).strict(),
)

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type RubatoMemoryDreamModel = z.infer<typeof RubatoMemoryDreamModelSchema>
export type RubatoMemorySearch = z.infer<typeof RubatoMemorySearchSchema>
export type RubatoMemoryDream = z.infer<typeof RubatoMemoryDreamSchema>
export type RubatoMemorySettings = z.infer<typeof RubatoMemorySettingsSchema>
export type RubatoMemorySettingsLayer = z.infer<typeof RubatoMemorySettingsLayerSchema>
