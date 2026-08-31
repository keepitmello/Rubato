import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { ZmxProcessAdapter, type CommandRunner, type DetachedCommandLauncher } from "../src/zmx.js"
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
    })

    const call = launcher.calls[0]!
    const descriptorPath = `${temporary.path}/${SESSION_ID}.json`
    expect(call.args).toEqual(["attach", "--labels", `app=rubato rubato_live_id=${SESSION_ID}`, "rubato-018f1e2d3c4b", "/fixed/it's safe; bootstrap", descriptorPath])
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<string, unknown>
    expect(descriptor).toEqual({ schemaVersion: 1, socketPath: "/tmp/rubato-hub.sock", token: "launch-token" })
    expect(await readFile(descriptorPath, "utf8")).not.toContain("environment")
    expect(runner.calls[0]?.args).toEqual(["get", "rubato-018f1e2d3c4b", "app"])
  })

  test("uses short listing and authoritative labels rather than parsing a human table", async () => {
    const runner = new FakeRunner()
    runner.responses.set("list --short", "rubato-018f1e2d3c4b\n")
    runner.responses.set("get rubato-018f1e2d3c4b app", "rubato\n")
    runner.responses.set("get rubato-018f1e2d3c4b rubato_live_id", `${SESSION_ID}\n`)
    const adapter = new ZmxProcessAdapter({ zmx: "zmx", bootstrap: "bootstrap", descriptorRoot: "/tmp", runner })
    expect(await adapter.discover()).toHaveLength(1)
    expect(runner.calls[0]?.args).toEqual(["list", "--short"])
  })
})
