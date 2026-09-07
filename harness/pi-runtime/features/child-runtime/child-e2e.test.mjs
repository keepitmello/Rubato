import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildRubatoComponents } from "../../build-rubato.mjs"
import { stagePiRuntime } from "../../stage-runtime.mjs"
import { childRuntimeFeature } from "./feature.mjs"

const run = promisify(execFile)
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

test("staged stock child fixture consumes the in-process and RPC runner seams", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-child-e2e-test-"))
  try {
    const build = await buildRubatoComponents({
      outputRoot: join(scratch, "build"),
      fixtureEntries: { "fixtures/child-e2e.mjs": "harness/pi-runtime/features/child-runtime/fixture.ts" },
    })
    const staged = await stagePiRuntime({
      sourceRoot,
      outputRoot: join(scratch, "stage"),
      features: [build.feature, childRuntimeFeature],
    })
    const env = {
      HOME: join(scratch, "home"),
      PATH: process.env.PATH,
      PI_OFFLINE: "1",
      NO_COLOR: "1",
    }
    const result = await run(process.execPath, [join(staged.root, "rubato-features/rubato-components/fixtures/child-e2e.mjs")], {
      cwd: scratch,
      env,
      timeout: 20_000,
      maxBuffer: 512 * 1024,
    })
    const receipt = JSON.parse(result.stdout.trim())
    assert.equal(receipt.ok, true)
    assert.match(receipt.rpcEntry, /node_modules[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]rpc-entry\.js$/)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
