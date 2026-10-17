import * as z from "zod"

import { RubatoMemoryDreamModelSchema } from "./memory"

// Session titles and the Stats page's longest-think card share one short model ladder: a small
// model writes a few words, and the next rung answers when the first cannot. Unset means the
// built-in ladder, TITLE_MODELS in harness/pi-runtime/features/session-title/session-title.mjs.
export const RubatoTitlesSettingsSchema = z.object({
  models: z.array(RubatoMemoryDreamModelSchema).optional(),
}).strict()

export const RubatoTitlesSettingsLayerSchema = RubatoTitlesSettingsSchema

export type RubatoTitlesSettings = z.infer<typeof RubatoTitlesSettingsSchema>
