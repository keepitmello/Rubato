import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { SurfaceReconnectCredentials } from "../src/surface-credentials.js"
import { SESSION_ID, temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

describe("surface reconnect credentials", () => {
  test("survive a hub restart while remaining bound to process and surface identity", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const path = join(temporary.path, "credential-key")
    const firstHub = new SurfaceReconnectCredentials(path)
    await firstHub.load()
    const token = firstHub.issue(SESSION_ID, "surface-1")

    const restartedHub = new SurfaceReconnectCredentials(path)
    await restartedHub.load()
    expect(restartedHub.verify(token, SESSION_ID, "surface-1")).toBeTrue()
    expect(restartedHub.verify(token, SESSION_ID, "surface-2")).toBeFalse()
  })

  test("rejects expired or modified credentials", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    let now = 1_000
    const credentials = new SurfaceReconnectCredentials(join(temporary.path, "credential-key"), () => now)
    await credentials.load()
    const token = credentials.issue(SESSION_ID, "surface-1", 10)
    expect(credentials.verify(`${token}x`, SESSION_ID, "surface-1")).toBeFalse()
    now += 11
    expect(credentials.verify(token, SESSION_ID, "surface-1")).toBeFalse()
  })
})
