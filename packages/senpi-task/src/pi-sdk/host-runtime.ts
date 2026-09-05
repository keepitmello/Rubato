import { getStockSdkSync, tryGetStockSdkSync } from "./stock-runtime.ts"

/** Product tools import these instead of `@code-yeongyu/senpi`. Call after `loadStockSdk()`. */
export function defineTool<T>(tool: T): T {
  return getStockSdkSync().defineTool(tool as Record<string, unknown>) as T
}

export function loadSkillsFromDir(options: unknown): unknown {
  const fn = tryGetStockSdkSync()?.loadSkillsFromDir
  if (typeof fn === "function") return fn(options)
  return { skills: [], diagnostics: [] }
}

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024

export function formatSize(bytes: number): string {
  const fn = getStockSdkSync().formatSize
  if (typeof fn === "function") return fn(bytes)
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function truncateHead(content: string, options?: Record<string, unknown>): unknown {
  const fn = getStockSdkSync().truncateHead
  if (typeof fn !== "function") {
    throw new Error("stock SDK missing truncateHead")
  }
  return fn(content, options)
}
