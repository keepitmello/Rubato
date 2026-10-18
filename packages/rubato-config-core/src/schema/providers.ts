import * as z from "zod"

// Providers the user switched off. Their login stays; their models leave the list every picker
// and the Agent/team model lists read. The engine reads it in
// harness/pi-runtime/features/providers/provider-switch.mjs, and `rubato auth disable|enable` writes it.
export const RubatoProvidersSettingsSchema = z.object({
  disabled: z.array(z.string().min(1)).optional(),
  loadBalancing: z.array(z.literal("anthropic")).optional(),
}).strict()

export const RubatoProvidersSettingsLayerSchema = RubatoProvidersSettingsSchema

export type RubatoProvidersSettings = z.infer<typeof RubatoProvidersSettingsSchema>
