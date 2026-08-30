import * as z from "zod"

import { REASONING_LEVELS } from "./reasoning-vocabulary"

const REASONING_LEVELS_OR_AUTO = [...REASONING_LEVELS, "auto"] as const

export const RubatoReasoningSchema = z.union([
  z.enum(REASONING_LEVELS_OR_AUTO),
  z.string(),
])

export const RubatoModelRefObjectSchema = z.object({
  model: z.string(),
  reasoning: RubatoReasoningSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  provider_options: z.record(z.string(), z.unknown()).optional(),
}).strict()

export const RubatoModelRefSchema = z.union([z.string(), RubatoModelRefObjectSchema])

export type RubatoReasoning = z.infer<typeof RubatoReasoningSchema>
export type RubatoModelRefObject = z.infer<typeof RubatoModelRefObjectSchema>
export type RubatoModelRef = z.infer<typeof RubatoModelRefSchema>
