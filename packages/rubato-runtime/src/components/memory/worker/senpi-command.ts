import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { isAbsolute, join } from "node:path"

import {
  detectBunBinary,
  resolveSenpiLauncher as resolveTaskSenpiLauncher,
  type SenpiLauncher,
} from "@rubato/task"

const SENPI_PACKAGE_DIR = join("@code-yeongyu", "senpi")
const CLI_RELATIVE = join("dist", "cli.js")

/**
 * Package-location keys the host sets for its OWN engine.
 *
 * A memory child runs senpi, not the host engine, and senpi resolves its own shipped assets
 * through the same names (`config.js` reads `PACKAGE_DIR` across the brand prefixes). Inheriting
 * them aims the child's asset lookup at the host's package: with `PI_PACKAGE_DIR` on stock-pi's
 * `pi-coding-agent`, `getBuiltinThemes()` read `grok-night.json` from a copy that never shipped
 * it and threw, and `initTheme`'s fallback re-read the same missing file, so the child died in
 * theme init before any reflection work.
 */
const ENGINE_LOCATION_KEYS = Object.freeze(["PI_PACKAGE_DIR", "SENPI_PACKAGE_DIR"])

/** Parent environment with the host engine's package location removed for a senpi child. */
export function memoryChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env }
  for (const key of ENGINE_LOCATION_KEYS) delete child[key]
  return child
}

/**
 * Resolve the senpi CLI to spawn reflection, dream, and facts children with.
 *
 * The previous resolution ended at a bare `"senpi"` when no executable was found, which is not a
 * runnable command: a senpi launched from an environment whose PATH lacks the senpi bin directory
 * produced children that died with `execvp() of 'senpi' failed: No such file or directory`, so
 * every background memory run failed while the parent session looked healthy.
 *
 * A PATH scan cannot be the last resort because the child inherits the same PATH that already
 * failed. The launcher retains any interpreter prefix needed by npm/Windows shims and falls back to
 * the CLI or entry script of the running Senpi installation.
 */
export function resolveSenpiLaunch(
  env: NodeJS.ProcessEnv,
  runtime: SenpiLaunchRuntime = defaultRuntime(),
): SenpiLauncher {
  const launcher = resolveTaskSenpiLauncher({
    isBunBinary: runtime.isBunBinary,
    execPath: runtime.execPath,
    platform: runtime.platform,
    parentEnv: env,
    resolveRpcEntry: () => "",
  })
  if (launcher !== null) return launcher
  const installedCli = runtime.resolveInstalledCli()
  if (installedCli !== null) return { command: runtime.execPath, prefixArgs: [installedCli] }
  const entry = runtime.argv[1]
  if (entry !== undefined && isAbsolute(entry) && existsSync(entry)) {
    return { command: runtime.execPath, prefixArgs: [entry] }
  }
  throw new Error("Unable to resolve a runnable Senpi launcher")
}

/**
 * Resolve the launch for a memory child, honoring an explicit host-supplied command.
 *
 * A host that resolves its own senpi command (the npm install shape: the node binary plus the
 * CLI entry in `senpiPrefixArgs`) must keep BOTH halves. Dropping the prefix leaves the bare
 * interpreter receiving senpi flags, which dies as `node: bad option: --fork`.
 */
export function resolveMemoryChildLaunch(input: {
  readonly senpiCommand?: string
  readonly senpiPrefixArgs?: readonly string[]
  readonly env: NodeJS.ProcessEnv
}): SenpiLauncher {
  if (input.senpiCommand === undefined) return resolveSenpiLaunch(input.env)
  return { command: input.senpiCommand, prefixArgs: input.senpiPrefixArgs ?? [] }
}

export type SenpiLaunchRuntime = {
  readonly isBunBinary: boolean
  readonly execPath: string
  readonly platform: NodeJS.Platform
  readonly argv: readonly string[]
  readonly resolveInstalledCli: () => string | null
}

function resolveInstalledSenpiCli(): string | null {
  const require = createRequire(import.meta.url)
  for (const modulesDir of require.resolve.paths(join(SENPI_PACKAGE_DIR, "package.json")) ?? []) {
    const candidate = join(modulesDir, SENPI_PACKAGE_DIR, CLI_RELATIVE)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function defaultRuntime(): SenpiLaunchRuntime {
  return {
    isBunBinary: detectBunBinary(import.meta.url),
    execPath: process.execPath,
    platform: process.platform,
    argv: process.argv,
    resolveInstalledCli: resolveInstalledSenpiCli,
  }
}
