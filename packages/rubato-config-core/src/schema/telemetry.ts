import * as z from "zod"

import type { RubatoHarnessId } from "./harness"

const RubatoTelemetrySettingsShape = {
  enabled: z.boolean(),
}

export const RubatoTelemetrySettingsLayerSchema = z.object(RubatoTelemetrySettingsShape).partial().strict()

export const RubatoTelemetrySettingsSchema = RubatoTelemetrySettingsLayerSchema.extend({
  enabled: z.boolean().default(true),
}).strict()

export type RubatoTelemetrySettings = z.infer<typeof RubatoTelemetrySettingsSchema>
export type RubatoTelemetrySettingsLayer = z.infer<typeof RubatoTelemetrySettingsLayerSchema>

export interface RubatoTelemetryConfigView {
  readonly telemetry?: RubatoTelemetrySettings
}

type TelemetrySettingKey = keyof RubatoTelemetrySettings
type TelemetrySettingPath = `telemetry.${TelemetrySettingKey}`

export const TELEMETRY_HARNESS_SUPPORT: Record<TelemetrySettingPath, readonly RubatoHarnessId[]> = {
  "telemetry.enabled": ["senpi"],
} as const

export function isRubatoTelemetryEnabled(config: RubatoTelemetryConfigView): boolean {
  return config.telemetry?.enabled ?? true
}
