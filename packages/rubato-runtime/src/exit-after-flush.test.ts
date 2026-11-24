import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The reader is Node's execFile, as in the settings server: Bun's own reader keeps up and hides the cut.
const READER = `
const { execFile } = require("node:child_process")
const run = () => new Promise((resolve) => execFile("bun", [process.argv[1]], { maxBuffer: 1 << 26 }, (_e, out) => resolve(Buffer.byteLength(String(out)))))
;(async () => {
  const sizes = []
  for (let round = 0; round < 8; round++) sizes.push(...(await Promise.all([run(), run(), run()])))
  console.log(JSON.stringify(sizes))
})()
`
const sizesRead = (script: string) =>
  new Promise<number[]>((resolve, reject) =>
    execFile("node", ["-e", READER, script], (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout) as number[]))))

// Several readers at once keep the pipes busy, which is where exit-before-flush cuts the output.
test("a CLI's whole output reaches a pipe reader past the 64 KB pipe buffer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rubato-exit-flush-"))
  try {
    const helper = join(import.meta.dir, "exit-after-flush")
    const printed = 120_001
    const body = `process.stdout.write("é".repeat(60_000) + "\\n")`
    const withHelper = join(dir, "with.ts")
    const withExit = join(dir, "without.ts")
    writeFileSync(withHelper, `import { exitAfterFlush } from ${JSON.stringify(helper)}\n${body}\nexitAfterFlush(0)\n`)
    writeFileSync(withExit, `${body}\nprocess.exit(0)\n`)
    expect((await sizesRead(withHelper)).filter((size) => size !== printed)).toEqual([])
    // The control: the same output with a plain exit is cut short, so this test would catch a revert.
    expect((await sizesRead(withExit)).some((size) => size !== printed)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a process that something else keeps open still ends within the grace period", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rubato-exit-flush-"))
  try {
    const script = join(dir, "open.ts")
    writeFileSync(script, `import { exitAfterFlush } from ${JSON.stringify(join(import.meta.dir, "exit-after-flush"))}\nsetInterval(() => {}, 1000)\nexitAfterFlush(3, 200)\n`)
    const code = await new Promise<number | null>((resolve) => execFile("bun", [script], (error) => resolve(error ? (error as { code?: number }).code ?? 1 : 0)))
    expect(code).toBe(3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
