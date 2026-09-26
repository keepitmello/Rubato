import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { resolveMemoryRoot } from "@rubato/memory-core"

// Session start and end ask `rubato dream --due` whether a store is due. The dream CLI owns every
// decision (which stores are on, the 20-hour gap, unread sessions, the per-store lock), so this
// side only starts it: detached, output to a log, never awaited, never able to fail the session.
// The launcher publishes the CLI path in RUBATO_DREAM_CLI; a host that does not (bare engine runs)
// launches nothing, and neither does an offline run (PI_OFFLINE, which every test harness sets) or a
// test runner: the dream needs a model on the network.

export const DREAM_CLI_ENV = "RUBATO_DREAM_CLI"
export const DREAM_LOG_NAME = "dream-due.log"
/** Session start and the end of the session before it land together on /new and /resume. */
const RELAUNCH_GAP_MS = 60_000

export type SpawnDetached = typeof spawn

export interface DreamLauncher {
  /** Starts `rubato dream --due` in the background; returns whether a process was started. */
  launch(reason: string): boolean
}

export function createDreamLauncher(options: {
  readonly env: Record<string, string | undefined>
  readonly now?: () => number
  readonly spawn?: SpawnDetached
  readonly log?: (message: string, details?: Record<string, unknown>) => void
}): DreamLauncher {
  const now = options.now ?? Date.now
  const spawnChild = options.spawn ?? spawn
  let lastLaunchAt = Number.NEGATIVE_INFINITY

  return {
    launch(reason) {
      const cli = options.env[DREAM_CLI_ENV]
      if (cli === undefined || cli.trim() === "") return false
      if (options.env.PI_OFFLINE === "1" || options.env.NODE_ENV === "test") return false
      if (now() - lastLaunchAt < RELAUNCH_GAP_MS) return false
      lastLaunchAt = now()
      let logFd: number | undefined
      try {
        const memoryRoot = resolveMemoryRoot(options.env, homedir())
        mkdirSync(memoryRoot, { recursive: true })
        logFd = openSync(join(memoryRoot, DREAM_LOG_NAME), "a")
        const child = spawnChild("bun", [cli, "--due"], {
          cwd: homedir(),
          env: { ...options.env, RUBATO_DREAM_TRIGGER: reason },
          detached: true,
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
        })
        child.on("error", (error) => options.log?.("rubato dream --due failed to start", { error: String(error) }))
        child.unref()
        return true
      } catch (error) {
        options.log?.("rubato dream --due failed to start", { error: String(error) })
        return false
      } finally {
        if (logFd !== undefined) closeSync(logFd)
      }
    },
  }
}
