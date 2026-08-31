import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { ensureHostConfig, loadHostConfig } from "../src/config.js"
import { renderLaunchAgent } from "../src/launchd.js"
import { findAvailableHubPort } from "../src/ports.js"
import { configureTailscaleServe, tailscaleGrantExample, tailscalePairingBaseUrl } from "../src/tailscale.js"
import type { CommandRunner } from "../src/zmx.js"
import { HOST_ID, temporaryDirectory } from "./helpers.js"

const execFileAsync = promisify(execFile)

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

describe("localhost service configuration", () => {
  test("selects a fallback in the stable range when the configured port is occupied", async () => {
    const preferred = await findAvailableHubPort(7399)
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject)
      blocker.listen(preferred, "127.0.0.1", resolve)
    })
    cleanups.push(() => new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve())))
    const selected = await findAvailableHubPort(preferred)
    expect(selected).toBeGreaterThanOrEqual(7315)
    expect(selected).toBeLessThanOrEqual(7399)
  })

  test("renders a persistent user launch agent without a shell command", () => {
    const plist = renderLaunchAgent({
      nodePath: "/usr/local/bin/node",
      entryPath: "/Users/test/Rubato & Remote/main.ts",
      stdoutPath: "/tmp/rubato.out",
      stderrPath: "/tmp/rubato.err",
      home: "/Users/test",
      tmpdir: "/tmp/",
    })
    expect(plist).toContain("com.keepitmello.rubato.remote-hub")
    expect(plist).toContain("<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>")
    expect(plist).toContain("Rubato &amp; Remote")
    expect(plist).not.toContain("/bin/sh")
  })

  test("remote setup initialization writes a complete private config accepted by the real loader", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const path = join(temporary.path, "host.json")
    const configured = await ensureHostConfig(path, { displayName: "Mac", ownerLogin: "owner@example.com" })
    expect(await loadHostConfig(path)).toEqual(configured)
    expect(configured).toMatchObject({ schemaVersion: 1, displayName: "Mac", ownerLogin: "owner@example.com", httpPort: 7314 })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("an existing complete host config survives legacy CLI state use byte-for-byte", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const path = join(temporary.path, "host.json")
    const complete = { schemaVersion: 1 as const, hostId: HOST_ID, displayName: "Mac", ownerLogin: "owner@example.com", httpPort: 7314, createdAt: "2026-08-31T00:00:00.000Z" }
    await writeFile(path, JSON.stringify(complete, null, 2), { mode: 0o600 })
    const before = await readFile(path, "utf8")
    const stateStore = resolve(import.meta.dirname, "../../rubato-live-cli/src/state-store.mjs")
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", `import { LiveStateStore } from ${JSON.stringify(new URL(`file://${stateStore}`).href)}; new LiveStateStore(${JSON.stringify(temporary.path)}).hostId()`], { env: { ...process.env, NODE_OPTIONS: "" } })
    await ensureHostConfig(path, { displayName: "Other", ownerLogin: "other@example.com" })
    expect(await readFile(path, "utf8")).toBe(before)
    expect(await loadHostConfig(path)).toEqual(complete)
  })

  test("configures only Tailscale Serve at /rubato on localhost", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const runner: CommandRunner = {
      run: async (file, args) => { calls.push({ file, args }); return { stdout: "", stderr: "" } },
    }
    await configureTailscaleServe(runner, "/Applications/Tailscale.app/tailscale", 7314)
    expect(calls).toEqual([{
      file: "/Applications/Tailscale.app/tailscale",
      args: ["serve", "--bg", "--set-path=/rubato", "http://127.0.0.1:7314"],
    }])
    expect(JSON.parse(tailscaleGrantExample("owner@example.com", "mac-mini"))).toHaveProperty("grants")
    const statusRunner: CommandRunner = { run: async () => ({ stdout: JSON.stringify({ Self: { DNSName: "mac-mini.tailnet.ts.net." } }), stderr: "" }) }
    expect(await tailscalePairingBaseUrl(statusRunner, "/tailscale")).toBe("https://mac-mini.tailnet.ts.net/rubato/")
  })
})
