import { existsSync } from "node:fs"
import { join } from "node:path"

const STOCK_PACKAGE = "@earendil-works/pi-coding-agent"
const STOCK_RPC_ENTRY = `${STOCK_PACKAGE}/rpc-entry`

/**
 * Resolve the staged, patched *unbundled* stock Pi RPC entry. The stage receipt
 * owns this path; we never infer it from package exports or a global CLI.
 */
export function resolveStockRpcEntry({ root } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("stock Pi RPC entry requires the staged runtime root")
  }
  const entry = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "rpc-entry.js")
  if (!existsSync(entry)) {
    throw new Error(`stock Pi patchable RPC entry is missing: ${entry}`)
  }
  return entry
}

/**
 * Runtime injection for senpi-task's generic RPC spawner.
 *
 * We deliberately return no executable. That makes buildRpcSpawn use
 * `execPath + patchable dist/rpc-entry.js`, so a child cannot
 * accidentally select a globally installed `senpi`/`pi` binary. The parent
 * process's Node/Bun runtime is still used to execute the selected stock
 * entrypoint.
 */
export function createStockRpcSpawnRuntime({
  rpcEntry,
  execPath = process.execPath,
  platform = process.platform,
  parentEnv = process.env,
  metaUrl = import.meta.url,
} = {}) {
  if (typeof rpcEntry !== "string" || rpcEntry.length === 0) {
    throw new Error("createStockRpcSpawnRuntime requires runtime.patchableRpcEntry")
  }
  if (!existsSync(rpcEntry) || !/[\\/]node_modules[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]rpc-entry\.js$/.test(rpcEntry)) {
    throw new Error(`stock Pi runtime requires the staged unbundled Pi RPC entry: ${rpcEntry}`)
  }
  return {
    isBunBinary: process.versions?.bun !== undefined || /(?:\$bunfs|~BUN|%7EBUN)/.test(metaUrl),
    execPath,
    platform,
    parentEnv,
    sessionDirEnvName: "PI_CODING_AGENT_SESSION_DIR",
    resolveRpcEntry: () => rpcEntry,
    // `buildRpcSpawn` still calls this legacy-named hook; the value is a
    // stock-specific policy and does not resolve SENPI_BIN or PATH.
    resolveSenpiExecutable: () => null,
  }
}

export const STOCK_PI_PACKAGE = STOCK_PACKAGE
export const STOCK_PI_RPC_ENTRY = STOCK_RPC_ENTRY
