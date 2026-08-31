import type { RubatoConfig } from "@rubato/config-core"

import type { TaskManager } from "../../../manager"
import { createTaskRecord } from "../../../state"
import type { TaskRecord } from "../../../state"
import type { TaskToolContext, TaskToolDeps } from "../types"

export const LIVE_MODEL = "xai/grok-4.6"
export const MOMUS_AGENTS = { momus: { name: "momus" } }
export const EXPLORE_AGENTS = { explore: { name: "explore" } }

export const RUBATO_CONFIG: RubatoConfig = { categories: {}, agents: {} }

export const CTX: TaskToolContext = {
  cwd: "/work/project",
  sessionManager: { getSessionId: () => "parent-session-1" },
}

function notImplemented(name: string): never {
  throw new Error(`fake TaskManager.${name} not configured for this test`)
}

export function createFakeManager(overrides: Partial<TaskManager>): TaskManager {
  return {
    start: () => notImplemented("start"),
    startOwned: () => notImplemented("startOwned"),
    findOwnedTask: () => undefined,
    continueTask: () => notImplemented("continueTask"),
    sendToTask: () => notImplemented("sendToTask"),
    interruptTask: () => notImplemented("interruptTask"),
    cancelTask: () => notImplemented("cancelTask"),
    get: () => undefined,
    list: () => [],
    waitFor: () => notImplemented("waitFor"),
    runStatsSnapshot: () => undefined,
    forget: () => {},
    getResidentHandle: () => undefined,
    subscribeChild: () => () => {},
    residentTaskIds: () => [],
    promoteToBackground: () => true,
    wasBackground: () => false,
    ...overrides,
  }
}

export function makeRecord(overrides: Partial<TaskRecord>): TaskRecord {
  const base = createTaskRecord({
    parent_session_id: "parent-session-1",
    root_session_id: "parent-session-1",
    depth: 1,
    execution_mode: "in-process",
    model: "anthropic/claude",
    notify_on_terminal: false,
  })
  return { ...base, ...overrides }
}

export function makeDeps(manager: TaskManager, extra: Partial<TaskToolDeps> = {}): TaskToolDeps {
  return {
    manager,
    rubatoConfig: RUBATO_CONFIG,
    agents: {},
    models: { has: (model) => model.includes("/") },
    ...extra,
  }
}
