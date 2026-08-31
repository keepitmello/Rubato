import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AllowedPathResolver } from "../src/path-security.js"
import { temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

describe("path boundary enforcement", () => {
  test("uses real paths and rejects traversal through a symlink", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const allowed = join(temporary.path, "allowed")
    const outside = join(temporary.path, "outside")
    await Promise.all([mkdir(allowed), mkdir(outside)])
    await writeFile(join(outside, "secret"), "secret")
    await symlink(outside, join(allowed, "escape"))
    const resolver = new AllowedPathResolver([allowed])

    await expect(resolver.resolve(join(allowed, "escape", "secret"), "file")).rejects.toThrow("path_not_allowed")
    expect(await resolver.resolve(allowed, "directory")).toBe(await realpath(allowed))
  })
})
