import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"

const STOCK_PACKAGE = "@earendil-works/pi-coding-agent"
const STOCK_RPC_ENTRY = `${STOCK_PACKAGE}/rpc-entry`

/**
 * Build the deliberately small profile shared by Rubato's child runners.
 *
 * `--no-extensions` remains the child default. Only provider-bearing extension
 * paths supplied here are forwarded with `--extension`; parent task/MCP/UI
 * assembly is never copied into the detached process. In-process callers can
 * carry the parent's canonical modelRuntime separately through the task factory
 * options, while RPC children reproduce only this explicit provider profile.
 */
export function createStockChildFeatureProfile({ rpcExtensions = [], inProcessFactories = [], agentDir } = {}) {
  if (!Array.isArray(rpcExtensions)) throw new TypeError("stock child rpcExtensions must be an array")
  const seen = new Set()
  const extensions = []
  for (const entry of rpcExtensions) {
    if (typeof entry !== "string" || entry.length === 0 || !isAbsolute(entry)) throw new TypeError("stock child extension paths must be absolute, non-empty strings")
    if (seen.has(entry)) continue
    seen.add(entry)
    extensions.push(entry)
  }
  if (!Array.isArray(inProcessFactories) || inProcessFactories.some((factory) => typeof factory !== "function")) {
    throw new TypeError("stock child in-process factories must be functions")
  }
  return Object.freeze({
    rpcExtensions: Object.freeze(extensions),
    inProcessFactories: Object.freeze([...inProcessFactories]),
    ...(agentDir === undefined ? {} : { agentDir }),
  })
}

/** Resolve the staged Rubato provider-only extension closure for RPC children. */
export function resolveStockChildProviderProfile({ root, agentDir, includeContextNotes = false, includeGuards = false } = {}) {
  if (typeof root !== "string" || root.length === 0) throw new Error("stock child provider profile requires the staged runtime root")
  const entries = [join(root, "rubato-features", "child-runtime", "provider-extension.mjs")]
  if (includeContextNotes) entries.push(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "rubato-features", "context-notes", "extension.mjs"))
  if (includeGuards) entries.push(join(root, "rubato-features", "child-runtime", "guard-extension.mjs"))
  const prerequisites = [join(root, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "rubato-features", "provider-execution", "extension.mjs")]
  if (includeContextNotes) prerequisites.push(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "rubato-features", "context-notes", "src", "extensions", "context-notes.mjs"))
  if (includeGuards) prerequisites.push(join(root, "rubato-features", "tool-guards", "index.mjs"))
  for (const entry of [...entries, ...prerequisites]) {
    if (!existsSync(entry)) throw new Error(`stock child provider profile entry is missing: ${entry}`)
  }
  // provider-extension.mjs imports and binds provider-execution itself; the
  // prerequisite is staged but must not be passed as a standalone factory.
  return createStockChildFeatureProfile({ rpcExtensions: entries, agentDir })
}

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
