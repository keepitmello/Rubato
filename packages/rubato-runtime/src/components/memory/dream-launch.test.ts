import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { rmSyncEfaultTolerant } from "./teardown.test-support"
import { DREAM_CLI_ENV, DREAM_LOG_NAME, createDreamLauncher, type SpawnDetached } from "./dream-launch"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSyncEfaultTolerant(root, { recursive: true, force: true })
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "rubato-dream-launch-"))
  roots.push(home)
  return home
}

/** A home whose ~/.local/bin/rubato runs the checkout at `root`, as install.sh writes it. */
function installedAt(home: string, root: string): void {
  mkdirSync(join(home, ".local", "bin"), { recursive: true })
  writeFileSync(join(home, ".local", "bin", "rubato"), `#!/bin/sh\nexec /bin/sh "${root}/harness/scripts/rubato-pi.sh" "$@"\n`)
}

const cliIn = (root: string) => join(root, "packages", "rubato-runtime", "src", "dream", "cli.ts")

function recorder() {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = []
  const spawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options })
    return { on: () => undefined, unref: () => undefined }
  }) as unknown as SpawnDetached
  return { calls, spawn }
}

describe("createDreamLauncher", () => {
  test("#given no published dream CLI #when asked #then nothing starts", () => {
    const { calls, spawn } = recorder()
    expect(createDreamLauncher({ env: {}, spawn }).launch("session_start")).toBe(false)
    expect(calls).toEqual([])
  })

  test("#given an offline run or a test runner #when asked #then nothing starts", () => {
    const { calls, spawn } = recorder()
    for (const env of [{ PI_OFFLINE: "1" }, { NODE_ENV: "test" }]) {
      expect(createDreamLauncher({ env: { [DREAM_CLI_ENV]: "/repo/dream/cli.ts", ...env }, spawn }).launch("session_start")).toBe(false)
    }
    expect(calls).toEqual([])
  })

  test("#given the installed Rubato's dream CLI #when asked twice within a minute #then one detached `--due` run starts and logs under the memory root", () => {
    const home = tempHome()
    const installed = join(home, "rubato")
    installedAt(home, installed)
    const { calls, spawn } = recorder()
    let now = 1_000
    const launcher = createDreamLauncher({ env: { [DREAM_CLI_ENV]: cliIn(installed) }, home, spawn, now: () => now })

    expect(launcher.launch("session_start")).toBe(true)
    now += 30_000
    expect(launcher.launch("session_end")).toBe(false)
    now += 60_000
    expect(launcher.launch("session_end")).toBe(true)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.args).toEqual([cliIn(installed), "--due"])
    expect(calls[0]?.options.detached).toBe(true)
    expect(existsSync(join(home, ".rubato", "memory", DREAM_LOG_NAME))).toBe(true)
  })

  test("#given an isolated memory root #when any copy asks #then the run starts and logs under that root", () => {
    const home = tempHome()
    const memory = join(home, "isolated-memory")
    const { calls, spawn } = recorder()
    expect(createDreamLauncher({ env: { [DREAM_CLI_ENV]: "/tmp/scratch/packages/rubato-runtime/src/dream/cli.ts", RUBATO_MEMORY_HOME: memory }, home, spawn }).launch("session_start")).toBe(true)
    expect(calls).toHaveLength(1)
    expect(existsSync(join(memory, DREAM_LOG_NAME))).toBe(true)
  })

  // 2026-10-03: a verifier's /tmp copy started `dream --due` against ~/.rubato/memory and logged there.
  test("#given a scratch copy or an isolated profile with no memory root of its own #when asked #then nothing starts and the live root is not touched", () => {
    const home = tempHome()
    const installed = join(home, "rubato")
    installedAt(home, installed)
    const scratch = join(home, "tmp", "pi1", "base-src")
    const cases: Record<string, string | undefined>[] = [
      { [DREAM_CLI_ENV]: cliIn(scratch) },
      { [DREAM_CLI_ENV]: cliIn(installed), RUBATO_PI_CODING_AGENT_DIR: join(home, "isolated-agent") },
    ]
    const { calls, spawn } = recorder()
    for (const env of cases) expect(createDreamLauncher({ env, home, spawn }).launch("session_start")).toBe(false)
    const bare = tempHome()
    expect(createDreamLauncher({ env: { [DREAM_CLI_ENV]: cliIn(scratch) }, home: bare, spawn }).launch("session_start")).toBe(false)
    expect(calls).toEqual([])
    expect(existsSync(join(home, ".rubato", "memory", DREAM_LOG_NAME))).toBe(false)
  })
})
