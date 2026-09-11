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
import { providersFeature } from "../providers/patches.mjs"
import { providerExecutionFeature } from "../provider-execution/patches.mjs"
import { toolExecutionFeature } from "../tool-execution/patches.mjs"
import { feature as contextNotesFeature } from "../context-notes/patches.mjs"
import { feature as contextWindowFeature } from "../context-window/patches.mjs"
import { toolGuardsFeature } from "../tool-guards/feature.mjs"
import { childRuntimeFeature } from "./feature.mjs"

const run = promisify(execFile)
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

test("staged stock child fixture consumes the in-process and RPC runner seams", { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-child-e2e-test-"))
  try {
    const build = await buildRubatoComponents({
      outputRoot: join(scratch, "build"),
      fixtureEntries: { "fixtures/child-e2e.mjs": "harness/pi-runtime/features/child-runtime/fixture.ts" },
    })
    const staged = await stagePiRuntime({
      sourceRoot,
      outputRoot: join(scratch, "stage"),
      features: [toolExecutionFeature, providersFeature, providerExecutionFeature, contextNotesFeature, contextWindowFeature,
        toolGuardsFeature, childRuntimeFeature, build.feature],
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
      timeout: 80_000,
      maxBuffer: 512 * 1024,
    })
    const receipt = JSON.parse(result.stdout.trim())
    assert.equal(receipt.ok, true)
    assert.match(receipt.rpcEntry, /node_modules[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]rpc-entry\.js$/)
    assert.equal(receipt.inProcess.notesInit, true)
    assert.equal(receipt.inProcess.loopGuardBlocked, true)
    assert.match(receipt.inProcess.loopGuardReason, /Loop guard blocked|blocked repeated call/)
    assert.match(receipt.inProcess.bashCwd, /in-process-cwd/)
    assert.equal(receipt.inProcess.bashParentProbeExists, false)
    assert.equal(receipt.inProcess.parentProbeExists, false)
    assert.match(receipt.inProcess.childProbe, /in-process-cwd[\\/]cwd-probe\.txt$/)
    assert.equal(receipt.rpc.notesInit, true)
    assert.equal(receipt.rpc.loopGuardBlocked, true)
    assert.match(receipt.rpc.loopGuardReason, /Loop guard blocked|blocked repeated call|loop-guard:notice/)
    assert.match(receipt.rpc.bashCwd, /rpc-cwd/)
    assert.equal(receipt.rpc.bashParentProbeExists, false)
    assert.equal(receipt.rpc.parentProbeExists, false)
    assert.match(receipt.rpc.childProbe, /rpc-cwd[\\/]cwd-probe\.txt$/)
    assert.equal(receipt.rpc.rpcExtensions.includes("provider-extension.mjs"), true)
    assert.equal(receipt.rpc.rpcExtensions.includes("extension.mjs"), true)
    assert.equal(receipt.rpc.rpcExtensions.includes("guard-extension.mjs"), true)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
