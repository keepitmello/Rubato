import * as z from "zod"

import {
  RubatoFallbackModelObjectSchema,
  RubatoFallbackModelsSchema,
  RubatoReasoningEffortSchema,
  RubatoThinkingConfigSchema,
  normalizeLegacyModelFields,
} from "./fallback-models"
import { RubatoReasoningSchema } from "./model-ref"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const RubatoCategoryConfigObjectSchema = z.object({
  description: z.string().optional(),
  model: z.string().optional(),
  models: z.array(z.union([z.string(), RubatoFallbackModelObjectSchema])).optional(),
  reasoning: RubatoReasoningSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  provider_options: z.record(z.string(), z.unknown()).optional(),
  /** @deprecated Use models. */
  fallback_models: RubatoFallbackModelsSchema.optional(),
  /** @deprecated Use reasoning. */
  variant: z.string().optional(),
  /** @deprecated Use max_tokens. */
  maxTokens: z.number().optional(),
  /** @deprecated Use provider_options.thinking or reasoning: "off". */
  thinking: RubatoThinkingConfigSchema.optional(),
  /** @deprecated Use reasoning. */
  reasoningEffort: RubatoReasoningEffortSchema.optional(),
  /** @deprecated Use provider_options.textVerbosity. */
  textVerbosity: z.enum(["low", "medium", "high"]).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  prompt_append: z.string().optional(),
  max_prompt_tokens: z.number().int().positive().optional(),
  is_unstable_agent: z.boolean().optional(),
  disable: z.boolean().optional(),
  warn_unavailable: z.boolean().optional(),
}).strict()

export const RubatoCategoryConfigSchema = z.preprocess(
  (value) => isRecord(value) ? normalizeLegacyModelFields(value) : value,
  RubatoCategoryConfigObjectSchema,
)

export const RubatoCategoriesConfigSchema = z.record(z.string(), RubatoCategoryConfigSchema)

export type RubatoCategoryConfig = z.infer<typeof RubatoCategoryConfigSchema>
export type RubatoCategoriesConfig = z.infer<typeof RubatoCategoriesConfigSchema>
