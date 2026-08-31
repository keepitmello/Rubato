import { afterEach, describe, expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { EnvironmentHandoffStore, EnvironmentVault, type SecretKeyStore } from "../src/environment.js"
import { temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

describe("encrypted launch environment and one-time handoff", () => {
  test("encrypts the baseline at rest with mode 0600 and excludes volatile terminal values", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const path = join(temporary.path, "launch-env.enc")
    const keys: SecretKeyStore = { getOrCreate: async () => Buffer.alloc(32, 7) }
    const vault = new EnvironmentVault(path, keys)
    await vault.save({ PATH: "/custom/bin", API_TOKEN: "secret-value", PWD: "/private/project", ZMX_SESSION: "nested" })

    const stored = await readFile(path, "utf8")
    expect(stored).not.toContain("secret-value")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await vault.load()).toEqual({ PATH: "/custom/bin", API_TOKEN: "secret-value" })
  })

  test("returns terminal environment exactly once and expires without polling", () => {
    let now = 1_000
    const handoffs = new EnvironmentHandoffStore(() => now)
    const token = handoffs.issue({ PATH: "/bin" }, 60_000)
    expect(handoffs.consume(token)).toEqual({ PATH: "/bin" })
    expect(handoffs.consume(token)).toBeNull()

    const expired = handoffs.issue({ PATH: "/other" }, 1)
    now += 2
    expect(handoffs.consume(expired)).toBeNull()
  })
})
