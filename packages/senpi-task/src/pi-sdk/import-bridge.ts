import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveStockCodingAgent, stockIndexEntry, stockRpcEntry, stockTuiRoot } from "./resolve-stock.ts"

const REGISTERED = Symbol.for("rubato.stockPiImportBridge")

const SENPI_PACKAGE = "@code-yeongyu/senpi"
const SENPI_RPC = "@code-yeongyu/senpi/rpc-entry"
const PI_TUI = "@earendil-works/pi-tui"

export type StockImportBridge = {
  readonly codingAgentRoot: string
  readonly indexUrl: string
  readonly rpcEntryUrl: string
  readonly tuiIndexUrl: string | null
}

/**
 * Redirect external Senpi package specifiers onto an isolated stock Pi 0.84.2 tree.
 * Register before any product module imports `@code-yeongyu/senpi`.
 */
export function registerStockPiImportBridge(env: NodeJS.ProcessEnv = process.env): StockImportBridge {
  const existing = (globalThis as Record<symbol, StockImportBridge | undefined>)[REGISTERED]
  if (existing !== undefined) return existing
  const root = resolveStockCodingAgent(env)
  const tui = join(stockTuiRoot(root), "dist", "index.js")
  const bridge: StockImportBridge = {
    codingAgentRoot: root,
    indexUrl: pathToFileURL(stockIndexEntry(root)).href,
    rpcEntryUrl: pathToFileURL(stockRpcEntry(root)).href,
    tuiIndexUrl: existsSync(tui) ? pathToFileURL(tui).href : null,
  }
  const nodeModule = createRequire(import.meta.url)("node:module") as {
    registerHooks?: (hooks: { resolve: (...args: never[]) => unknown }) => void
  }
  if (typeof nodeModule.registerHooks !== "function") {
    throw new Error("registerStockPiImportBridge requires node:module.registerHooks (Node 22+)")
  }
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === SENPI_PACKAGE) {
        return { url: bridge.indexUrl, shortCircuit: true }
      }
      if (specifier === SENPI_RPC) {
        return { url: bridge.rpcEntryUrl, shortCircuit: true }
      }
      if (specifier === PI_TUI && bridge.tuiIndexUrl !== null) {
        return { url: bridge.tuiIndexUrl, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
  ;(globalThis as Record<symbol, StockImportBridge>)[REGISTERED] = bridge
  return bridge
}
