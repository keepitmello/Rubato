import {
  RubatoMemorySettingsSchema,
  type RubatoMemoryReflection,
  type RubatoMemorySettings,
} from "@rubato/config-core"

export function resolveMemorySettings(
  settings: RubatoMemorySettings | undefined,
): RubatoMemorySettings {
  return settings ?? RubatoMemorySettingsSchema.parse({})
}

export function resolveAgentReflectionSettings(
  settings: RubatoMemorySettings | undefined,
  agentId: string,
): RubatoMemoryReflection {
  const resolved = resolveMemorySettings(settings)
  const base = resolved.reflection
  const override = resolved.agents[agentId]?.reflection
  return {
    ...base,
    ...override,
    trigger: {
      ...base.trigger,
      ...override?.trigger,
    },
  }
}
