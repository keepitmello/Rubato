import * as z from "zod"

export const HARNESS_IDS = ["codex", "opencode", "senpi"] as const

export type HarnessId = (typeof HARNESS_IDS)[number]

export const RUBATO_CONFIG_HARNESS_IDS = ["opencode", "senpi", "codex"] as const

export const RubatoHarnessIdSchema = z.enum(RUBATO_CONFIG_HARNESS_IDS)

export type RubatoHarnessId = z.infer<typeof RubatoHarnessIdSchema>
