import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { parseZmxListInventory, ZmxProcessAdapter, type CommandRunner, type DetachedCommandLauncher } from "../src/zmx.js"
import { SESSION_ID, temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ file: string; args: readonly string[] }> = []
  readonly responses = new Map<string, string>()

  async run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ file, args })
    return { stdout: this.responses.get(args.join(" ")) ?? "", stderr: "" }
  }
}

class FakeLauncher implements DetachedCommandLauncher {
  readonly calls: Array<{ file: string; args: readonly string[] }> = []
  async launch(file: string, args: readonly string[]): Promise<void> { this.calls.push({ file, args }) }
}

describe("zmx process adapter", () => {
  test("launches only a fixed bootstrap with a privately written token descriptor", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const runner = new FakeRunner()
    const launcher = new FakeLauncher()
    runner.responses.set("get rubato-018f1e2d3c4b app", "rubato\n")
    const adapter = new ZmxProcessAdapter({ zmx: "/fixed/zmx", bootstrap: "/fixed/it's safe; bootstrap", descriptorRoot: temporary.path, runner, launcher })
    await adapter.launch({
      liveSessionId: SESSION_ID,
      launchToken: "launch-token",
      socketPath: "/tmp/rubato-hub.sock",
      labels: { app: "rubato", rubato_live_id: SESSION_ID },
      cwd: temporary.path,
    })

    const call = launcher.calls[0]!
    const descriptorPath = `${temporary.path}/${SESSION_ID}.json`
    expect(call.args).toEqual(["attach", "--labels", `app=rubato rubato_live_id=${SESSION_ID}`, "rubato-018f1e2d3c4b", "/fixed/it's safe; bootstrap", descriptorPath])
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<string, unknown>
    expect(descriptor).toEqual({ schemaVersion: 1, socketPath: "/tmp/rubato-hub.sock", token: "launch-token" })
    expect(await readFile(descriptorPath, "utf8")).not.toContain("environment")
    expect(runner.calls[0]?.args).toEqual(["get", "rubato-018f1e2d3c4b", "app"])
  })

  test("reads clients and pid from the zmx list table because they are not labels", () => {
    const line = "  name=rubato-018f1e2d3c4b\tpid=24134\tclients=0\tcreated=1\tcwd=file://host/tmp\tcmd=/bin/rubato\tapp=rubato\trubato_live_id=018f1e2d-3c4b-7b6f-8abc-1234567890ab"
    const current = `→ name=rubato-018f1e2d3c4c\tpid=99\tclients=1\tapp=rubato`
    const inventory = parseZmxListInventory(`${line}\n${current}\n`)
    expect(inventory.get("rubato-018f1e2d3c4b")).toEqual({ pid: 24134, clients: 0 })
    expect(inventory.get("rubato-018f1e2d3c4c")).toEqual({ pid: 99, clients: 1 })
  })

  test("uses short listing and authoritative labels rather than parsing a human table", async () => {
    const runner = new FakeRunner()
    runner.responses.set("list --short", "rubato-018f1e2d3c4b\n")
    runner.responses.set("list", "name=rubato-018f1e2d3c4b\tpid=24134\tclients=0\tapp=rubato\n")
    runner.responses.set("get rubato-018f1e2d3c4b app", "rubato\n")
    runner.responses.set("get rubato-018f1e2d3c4b rubato_live_id", `${SESSION_ID}\n`)
    const adapter = new ZmxProcessAdapter({ zmx: "zmx", bootstrap: "bootstrap", descriptorRoot: "/tmp", runner })
    const discovered = await adapter.discover()
    expect(discovered).toHaveLength(1)
    expect(discovered[0]).toMatchObject({ pid: 24134, clients: 0 })
    expect(runner.calls[0]?.args).toEqual(["list", "--short"])
  })
})
