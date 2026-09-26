import * as z from "zod"

// ---------------------------------------------------------------------------
// Legacy keys
// ---------------------------------------------------------------------------

// Keys earlier memory runtimes read (the 25-turn reflection, the per-turn save nudge, the
// system/ projection and its token warning, soul notices, per-agent overrides, the in-session
// dream's triggers). Existing configs still carry them, so they are dropped on load instead of
// failing strict parsing; anything else unknown still fails.
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

const LEGACY_DREAM_KEYS = [
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

/** The user's model ladder the dream runs on when `dream.category` is unset (DeepSeek first). */
export const DEFAULT_DREAM_CATEGORY = "grok"

export const RubatoMemoryDreamStoreSchema = z.object({
  enabled: z.boolean().default(false),
}).strict()

export const RubatoMemoryDreamSchema = z.preprocess(
  dropLegacyDreamKeys,
  z.object({
    // Category ladder the dream child runs on.
    category: z.string().min(1).default(DEFAULT_DREAM_CATEGORY),
    // "review": a dream's edits wait on a branch until the user approves them. "auto": they merge.
    publish: z.enum(["review", "auto"]).default("review"),
    // Stores the daily dream maintains, keyed by memory store name (memory.agent). Off unless listed.
    stores: z.record(z.string(), RubatoMemoryDreamStoreSchema).default({}),
    min_hours_between: z.number().int().min(1).default(20),
  }).strict(),
)

export const RubatoMemoryDreamLayerSchema = z.preprocess(
  dropLegacyDreamKeys,
  z.object({
    category: z.string().min(1).optional(),
    publish: z.enum(["review", "auto"]).optional(),
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
      category: DEFAULT_DREAM_CATEGORY,
      publish: "review",
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

export type RubatoMemorySearch = z.infer<typeof RubatoMemorySearchSchema>
export type RubatoMemoryDream = z.infer<typeof RubatoMemoryDreamSchema>
export type RubatoMemorySettings = z.infer<typeof RubatoMemorySettingsSchema>
export type RubatoMemorySettingsLayer = z.infer<typeof RubatoMemorySettingsLayerSchema>
