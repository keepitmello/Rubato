import { pathToFileURL } from "node:url"

import { resolveStockCodingAgent, stockIndexEntry, StockPiSdkError } from "./resolve-stock.ts"

export type StockSdk = {
  readonly createAgentSession: (options?: Record<string, unknown>) => Promise<{ session: unknown }>
  readonly SessionManager: {
    create: (cwd: string, sessionDir: string, options?: Record<string, unknown>) => unknown
    open: (path: string, sessionDir: string, cwdOverride?: string) => unknown
  }
  readonly SettingsManager: {
    inMemory: (settings?: Record<string, unknown>, options?: Record<string, unknown>) => unknown
  }
  readonly createExtensionRuntime: () => unknown
  readonly defineTool: (tool: Record<string, unknown>) => unknown
  readonly loadSkillsFromDir?: (options: unknown) => unknown
  readonly formatSize?: (bytes: number) => string
  readonly truncateHead?: (content: string, options?: Record<string, unknown>) => unknown
  readonly loadExtensionFromFactory?: (...args: unknown[]) => Promise<unknown>
  readonly createEventBus?: () => unknown
  readonly createBashTool?: (cwd: string, options?: Record<string, unknown>) => unknown
  readonly createCodingTools?: (cwd: string, options?: Record<string, unknown>) => unknown[]
  readonly VERSION?: string
}

let loaded: StockSdk | undefined
let loading: Promise<StockSdk> | undefined

function asStockSdk(mod: Record<string, unknown>, root: string): StockSdk {
  const createAgentSession = mod.createAgentSession
  const SessionManager = mod.SessionManager as StockSdk["SessionManager"] | undefined
  const SettingsManager = mod.SettingsManager as StockSdk["SettingsManager"] | undefined
  const createExtensionRuntime = mod.createExtensionRuntime
  const defineTool = mod.defineTool
  if (typeof createAgentSession !== "function") {
    throw new StockPiSdkError(`stock SDK missing createAgentSession at ${root}`)
  }
  if (SessionManager === undefined || typeof SessionManager.create !== "function" || typeof SessionManager.open !== "function") {
    throw new StockPiSdkError(`stock SDK missing SessionManager.create/open at ${root}`)
  }
  if (SettingsManager === undefined || typeof SettingsManager.inMemory !== "function") {
    throw new StockPiSdkError(`stock SDK missing SettingsManager.inMemory at ${root}`)
  }
  if (typeof createExtensionRuntime !== "function") {
    throw new StockPiSdkError(`stock SDK missing createExtensionRuntime at ${root}`)
  }
  if (typeof defineTool !== "function") {
    throw new StockPiSdkError(`stock SDK missing defineTool at ${root}`)
  }
  return {
    createAgentSession: createAgentSession as StockSdk["createAgentSession"],
    SessionManager,
    SettingsManager,
    createExtensionRuntime: createExtensionRuntime as StockSdk["createExtensionRuntime"],
    defineTool: defineTool as StockSdk["defineTool"],
    loadSkillsFromDir: typeof mod.loadSkillsFromDir === "function"
      ? (mod.loadSkillsFromDir as StockSdk["loadSkillsFromDir"])
      : undefined,
    formatSize: typeof mod.formatSize === "function" ? (mod.formatSize as StockSdk["formatSize"]) : undefined,
    truncateHead: typeof mod.truncateHead === "function" ? (mod.truncateHead as StockSdk["truncateHead"]) : undefined,
    loadExtensionFromFactory: typeof mod.loadExtensionFromFactory === "function"
      ? (mod.loadExtensionFromFactory as StockSdk["loadExtensionFromFactory"])
      : undefined,
    createEventBus: typeof mod.createEventBus === "function" ? (mod.createEventBus as StockSdk["createEventBus"]) : undefined,
    createBashTool: typeof mod.createBashTool === "function"
      ? (mod.createBashTool as StockSdk["createBashTool"])
      : undefined,
    createCodingTools: typeof mod.createCodingTools === "function"
      ? (mod.createCodingTools as StockSdk["createCodingTools"])
      : undefined,
    VERSION: typeof mod.VERSION === "string" ? mod.VERSION : undefined,
  }
}

export async function loadStockSdk(env: NodeJS.ProcessEnv = process.env): Promise<StockSdk> {
  if (loaded !== undefined) return loaded
  if (loading !== undefined) return loading
  loading = (async () => {
    const root = resolveStockCodingAgent(env)
    const href = pathToFileURL(stockIndexEntry(root)).href
    const mod = await import(href) as Record<string, unknown>
    loaded = asStockSdk(mod, root)
    return loaded
  })()
  try {
    return await loading
  } finally {
    loading = undefined
  }
}

export function getStockSdkSync(): StockSdk {
  if (loaded === undefined) {
    throw new StockPiSdkError("stock SDK is not loaded; call loadStockSdk() first")
  }
  return loaded
}

export function tryGetStockSdkSync(): StockSdk | undefined {
  return loaded
}

/** Test seam. */
export function resetStockSdkForTests(): void {
  loaded = undefined
  loading = undefined
}
