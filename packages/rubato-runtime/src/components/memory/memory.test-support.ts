import { RubatoMemorySettingsSchema, type RubatoMemorySettings } from "@rubato/config-core"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import type { ComponentContext } from "../../extension/types"
import type { SenpiRubatoConfigResult } from "../config-resolution"

export type SessionEntryFixture = {
  readonly type: string
  readonly customType?: string
  readonly data?: unknown
}

export class MemoryFakeExtensionAPI extends FakeExtensionAPI {
  readonly entries: Array<{ customType: string; data: unknown }> = []
  readonly entryRenderers: Array<{ customType: string; renderer: unknown }> = []

  appendEntry(customType: string, data?: unknown): void {
    this.entries.push({ customType, data })
  }

  registerEntryRenderer(customType: string, renderer: unknown): void {
    this.entryRenderers.push({ customType, renderer })
  }
}

// Defaults come from the schema that owns them; a hand copy here drifted every time a default moved.
export function memorySettings(overrides: Partial<RubatoMemorySettings> = {}): RubatoMemorySettings {
  return { ...RubatoMemorySettingsSchema.parse({}), ...overrides }
}

export function loadedMemoryConfig(memory: RubatoMemorySettings): SenpiRubatoConfigResult {
  return { config: { memory }, diagnostics: [], layers: [], sources: [] }
}

export function componentContext(flags: Readonly<Record<string, boolean | string | undefined>> = {}): ComponentContext & {
  readonly logs: Array<{ level: string; message: string; details?: unknown }>
} {
  const logs: Array<{ level: string; message: string; details?: unknown }> = []
  return {
    logs,
    config: { getFlag: (name) => flags[name] },
    logger: {
      info: (message, details) => logs.push({ level: "info", message, details }),
      warn: (message, details) => logs.push({ level: "warn", message, details }),
      error: (message, details) => logs.push({ level: "error", message, details }),
    },
  }
}

export function sessionContext(options: {
  readonly entries?: readonly SessionEntryFixture[]
  readonly notifications?: Array<{ message: string; level: string }>
  readonly sessionId?: string
} = {}): {
  readonly sessionManager: {
    getEntries(): readonly SessionEntryFixture[]
    getSessionId(): string
  }
  readonly ui: { notify(message: string, level: string): void }
} {
  const notifications = options.notifications ?? []
  return {
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getSessionId: () => options.sessionId ?? "session-1",
    },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  }
}
