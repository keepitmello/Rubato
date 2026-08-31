import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { ZmxProcessAdapter, quote, type CommandRunner } from "../src/zmx.js"
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

describe("zmx process adapter", () => {
  test("launches only a fixed bootstrap with a privately written token descriptor", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const runner = new FakeRunner()
    const adapter = new ZmxProcessAdapter({ zmx: "/fixed/zmx", bootstrap: "/fixed/bootstrap", descriptorRoot: temporary.path, runner })
    await adapter.launch({
      liveSessionId: SESSION_ID,
      launchToken: "launch-token",
      socketPath: "/tmp/rubato-hub.sock",
      labels: { app: "rubato", rubato_live_id: SESSION_ID },
    })

    const call = runner.calls[0]!
    expect(call.args.slice(0, 3)).toEqual(["run", "rubato-018f1e2d3c4b", "-d"])
    expect(call.args[3]).toContain("/fixed/bootstrap")
    const descriptorPath = `${temporary.path}/${SESSION_ID}.json`
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<string, unknown>
    expect(descriptor).toEqual({ schemaVersion: 1, socketPath: "/tmp/rubato-hub.sock", token: "launch-token" })
    expect(await readFile(descriptorPath, "utf8")).not.toContain("environment")
    expect(runner.calls[1]?.args).toEqual(["set", "rubato-018f1e2d3c4b", "app=rubato", `rubato_live_id=${SESSION_ID}`])
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

  test("POSIX-quotes bootstrap descriptor paths", () => {
    expect(quote("/tmp/it's safe")).toBe("'/tmp/it'\"'\"'s safe'")
  })
})
