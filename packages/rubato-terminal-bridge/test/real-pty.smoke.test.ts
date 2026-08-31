import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BunTerminalBackend, TerminalFrameDecoder, type TerminalFrame } from "../src/index.js"

const helper = fileURLToPath(new URL("../src/bun-helper.ts", import.meta.url))
const zmxBinary = process.env["RUBATO_ZMX_BIN"] ?? join(homedir(), ".local", "lib", "rubato", "bin", "zmx")
const runPinned = existsSync(zmxBinary) ? test : test.skip

test("real Bun PTY helper executes its fixed attach argv through a PTY", async () => {
  const frames = await runHelper("/usr/bin/true")
  expect(frames.some((frame) => frame.type === "exit")).toBe(true)
})

test("real Node-side backend controls the Bun PTY helper", async () => {
  const backend = new BunTerminalBackend({ bunBinary: process.execPath, helperPath: helper })
  let timeout: ReturnType<typeof setTimeout> | undefined
  const exited = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("real Bun PTY backend smoke timed out")), 5_000)
    timeout.unref()
    void backend.open({ zmxBinary: "/usr/bin/true", zmxName: "rubato-ffffffffffff", cols: 80, rows: 24 }, {
      output: () => true,
      exit: resolve,
      error: reject,
    }).catch(reject)
  })
  await exited
  clearTimeout(timeout)
})

runPinned("real Bun PTY helper starts the pinned zmx attach client and reports its exit", async () => {
  const frames = await runHelper(zmxBinary)
  expect(frames.some((frame) => frame.type === "exit" || frame.type === "error")).toBe(true)
})

async function runHelper(binary: string): Promise<readonly TerminalFrame[]> {
  const child = Bun.spawn([
    process.execPath,
    helper,
    "--zmx", binary,
    "--name", "rubato-ffffffffffff",
    "--cols", "80",
    "--rows", "24",
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill("SIGTERM"), 5_000)
  timeout.unref()
  const output = new Uint8Array(await new Response(child.stdout).arrayBuffer())
  await child.exited
  clearTimeout(timeout)
  const decoder = new TerminalFrameDecoder()
  const frames = decoder.push(output)
  decoder.finish()
  return frames
}
