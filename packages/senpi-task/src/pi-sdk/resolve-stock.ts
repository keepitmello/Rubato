import { existsSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join } from "node:path"

export const STOCK_CODING_AGENT_NAME = "@earendil-works/pi-coding-agent"
export const STOCK_VERSION = "0.84.2"

export class StockPiSdkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StockPiSdkError"
  }
}

function readIdentity(root: string): { name: string; version: string } {
  const pkgPath = join(root, "package.json")
  if (!existsSync(pkgPath)) {
    throw new StockPiSdkError(`stock coding-agent missing package.json: ${root}`)
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string }
  return { name: String(pkg.name ?? ""), version: String(pkg.version ?? "") }
}

function assertStockIdentity(root: string): void {
  const { name, version } = readIdentity(root)
  if (name !== STOCK_CODING_AGENT_NAME || version !== STOCK_VERSION) {
    throw new StockPiSdkError(
      `stock identity mismatch at ${root}: ${name}@${version} != ${STOCK_CODING_AGENT_NAME}@${STOCK_VERSION}`,
    )
  }
  if (/senpi/i.test(name) || name.startsWith("@code-yeongyu/")) {
    throw new StockPiSdkError(`refusing Senpi package as stock SDK: ${name} at ${root}`)
  }
}

function asCodingAgentRoot(path: string): string | null {
  if (!existsSync(join(path, "package.json"))) return null
  const { name } = readIdentity(path)
  if (/senpi/i.test(name) || name.startsWith("@code-yeongyu/")) {
    throw new StockPiSdkError(`refusing Senpi package as stock SDK: ${name} at ${path}`)
  }
  if (name === STOCK_CODING_AGENT_NAME) return path
  const nested = join(path, "node_modules", "@earendil-works", "pi-coding-agent")
  if (existsSync(join(nested, "package.json"))) return nested
  return null
}

/**
 * Resolve the isolated stock Pi 0.84.2 coding-agent root.
 * Never returns `@code-yeongyu/senpi` or the live worktree Senpi install.
 */
function assertCompleteStockTree(root: string): void {
  assertStockIdentity(root)
  const rpc = join(root, "dist", "rpc-entry.js")
  const cli = join(root, "dist", "cli.js")
  const index = join(root, "dist", "index.js")
  if (!existsSync(rpc) || !existsSync(cli) || !existsSync(index)) {
    throw new StockPiSdkError(`stock SDK at ${root} is missing dist/cli.js, dist/rpc-entry.js, or dist/index.js`)
  }
}

export function resolveStockCodingAgent(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.RUBATO_PI_SDK ?? env.RUBATO_PI_CODING_AGENT)?.trim()
  if (fromEnv && fromEnv.length > 0) {
    if (!isAbsolute(fromEnv)) {
      throw new StockPiSdkError(`stock SDK path must be absolute: ${fromEnv}`)
    }
    if (!existsSync(fromEnv)) {
      throw new StockPiSdkError(`stock Pi 0.84.2 coding-agent not found at ${fromEnv}`)
    }
    const root = asCodingAgentRoot(realpathSync(fromEnv))
    if (root === null) {
      throw new StockPiSdkError(`stock identity mismatch at ${fromEnv}: not ${STOCK_CODING_AGENT_NAME}@${STOCK_VERSION}`)
    }
    assertCompleteStockTree(root)
    return root
  }
  const installed = resolveInstalledStockPackage()
  if (installed !== null) {
    assertCompleteStockTree(installed)
    return installed
  }
  throw new StockPiSdkError(
    "stock Pi 0.84.2 coding-agent not found (set RUBATO_PI_SDK to an unpacked @earendil-works/pi-coding-agent@0.84.2 tree)",
  )
}

function resolveInstalledStockPackage(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const pkgJson = require.resolve(`${STOCK_CODING_AGENT_NAME}/package.json`)
    const root = asCodingAgentRoot(realpathSync(dirname(pkgJson)))
    return root
  } catch (error) {
    if (error instanceof StockPiSdkError) throw error
    return null
  }
}

export function stockRpcEntry(root?: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(root ?? resolveStockCodingAgent(env), "dist", "rpc-entry.js")
}

export function stockCliEntry(root?: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(root ?? resolveStockCodingAgent(env), "dist", "cli.js")
}

export function stockIndexEntry(root?: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(root ?? resolveStockCodingAgent(env), "dist", "index.js")
}

export function stockTuiRoot(root?: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(root ?? resolveStockCodingAgent(env), "node_modules", "@earendil-works", "pi-tui")
}
