import * as z from "zod"

import {
  RubatoFallbackModelObjectSchema,
  RubatoReasoningEffortSchema,
  normalizeLegacyModelFields,
} from "./fallback-models"
import { RubatoReasoningSchema } from "./model-ref"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const RubatoAgentModelEntrySchema = z.union([z.string(), RubatoFallbackModelObjectSchema])

const RubatoAgentDefInputSchema = z.object({
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  models: z.array(RubatoAgentModelEntrySchema).optional(),
  reasoning: RubatoReasoningSchema.optional(),
  /** @deprecated Use reasoning. */
  variant: z.string().optional(),
  /** @deprecated Use reasoning. */
  reasoningEffort: RubatoReasoningEffortSchema.optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  execution_mode: z.enum(["in-process", "process"]).optional(),
  background: z.boolean().optional(),
  max_depth: z.number().int().nonnegative().optional(),
  allowed_subagents: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  max_turns: z.number().int().nonnegative().optional(),
  temperature: z.number().min(0).max(2).optional(),
  disable: z.boolean().optional(),
}).strict()

export const RubatoAgentDefSchema = z.preprocess(
  (value) => isRecord(value) ? normalizeLegacyModelFields(value) : value,
  RubatoAgentDefInputSchema,
)

export const RubatoAgentsConfigSchema = z.record(z.string(), RubatoAgentDefSchema)

export type RubatoAgentModelEntry = z.infer<typeof RubatoAgentModelEntrySchema>
export type RubatoAgentDef = z.infer<typeof RubatoAgentDefSchema>
export type RubatoAgentsConfig = z.infer<typeof RubatoAgentsConfigSchema>
