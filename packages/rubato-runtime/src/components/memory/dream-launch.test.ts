import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { rmSyncEfaultTolerant } from "./teardown.test-support"
import { DREAM_CLI_ENV, DREAM_LOG_NAME, createDreamLauncher, type SpawnDetached } from "./dream-launch"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSyncEfaultTolerant(root, { recursive: true, force: true })
})

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

  test("#given the launcher's dream CLI #when asked twice within a minute #then one detached `--due` run starts and logs under the memory root", () => {
    const home = mkdtempSync(join(tmpdir(), "rubato-dream-launch-"))
    roots.push(home)
    const { calls, spawn } = recorder()
    let now = 1_000
    const launcher = createDreamLauncher({ env: { [DREAM_CLI_ENV]: "/repo/dream/cli.ts", RUBATO_MEMORY_HOME: home }, spawn, now: () => now })

    expect(launcher.launch("session_start")).toBe(true)
    now += 30_000
    expect(launcher.launch("session_end")).toBe(false)
    now += 60_000
    expect(launcher.launch("session_end")).toBe(true)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.args).toEqual(["/repo/dream/cli.ts", "--due"])
    expect(calls[0]?.options.detached).toBe(true)
    expect(existsSync(join(home, DREAM_LOG_NAME))).toBe(true)
  })
})
