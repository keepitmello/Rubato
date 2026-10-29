import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { ChildLaunch } from "./runner"

const here = dirname(fileURLToPath(import.meta.url))
/** The Rubato checkout this code runs from. */
export const repoRoot = join(here, "..", "..", "..", "..")

/** How a memory child (a dream, a request about the user's memory) starts the engine in print mode. */
export async function resolveLaunch(env: NodeJS.ProcessEnv): Promise<ChildLaunch> {
  const enginePaths = await import(join(repoRoot, "harness", "rubato-pi", "src", "engine-paths.mjs"))
  const childRuntime = await import(join(repoRoot, "harness", "pi-runtime", "features", "child-runtime", "stock-rpc-runtime.mjs"))
  const root: string = enginePaths.resolvePiEngineDir(env)
  return childRuntime.resolvePiMemoryChildLaunch({ root }) as ChildLaunch
}
