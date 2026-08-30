import * as z from "zod"

import { RubatoReasoningEffortSchema, normalizeLegacyModelFields } from "./fallback-models"
import { RubatoReasoningSchema } from "./model-ref"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const RubatoModelCatalogEntryInputSchema = z.object({
  model: z.string(),
  reasoning: RubatoReasoningSchema.optional(),
  /** @deprecated Use reasoning. */
  variant: z.string().optional(),
  /** @deprecated Use reasoning. */
  reasoningEffort: RubatoReasoningEffortSchema.optional(),
}).strict()

export const RubatoModelCatalogEntrySchema = z.preprocess(
  (value) => isRecord(value) ? normalizeLegacyModelFields(value) : value,
  RubatoModelCatalogEntryInputSchema,
)

export const RubatoModelCatalogSchema = z.record(z.string(), RubatoModelCatalogEntrySchema)

const RubatoModelCatalogEntryLayerInputSchema = RubatoModelCatalogEntryInputSchema.partial()
export const RubatoModelCatalogEntryLayerSchema = z.preprocess(
  (value) => isRecord(value) ? normalizeLegacyModelFields(value) : value,
  RubatoModelCatalogEntryLayerInputSchema,
)
export const RubatoModelCatalogLayerSchema = z.record(z.string(), RubatoModelCatalogEntryLayerSchema)

export type RubatoModelCatalogEntry = z.infer<typeof RubatoModelCatalogEntrySchema>
export type RubatoModelCatalog = z.infer<typeof RubatoModelCatalogSchema>
export type RubatoModelCatalogEntryLayer = z.infer<typeof RubatoModelCatalogEntryLayerSchema>
export type RubatoModelCatalogLayer = z.infer<typeof RubatoModelCatalogLayerSchema>
