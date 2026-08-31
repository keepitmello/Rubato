import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { driveQualification } from "./qualification-driver.mjs"
import { qualify, qualificationExitCode, validateNativeEvidence } from "./qualification.mjs"

const realZmx = process.env.RUBATO_QUALIFICATION_ZMX
const realCurrent = process.env.RUBATO_QUALIFICATION_CURRENT

test("short CI driver uses deterministic bounded fixtures and marks them non-native", async () => {
  const root = await mkdtemp(join(tmpdir(), "rubato-driver-contract-"))
  try {
    assert.equal((await driveQualification("message", 5, { root, profile: "ci" })).measurements.fixture, true)
    assert.equal((await driveQualification("event", 20, { root, profile: "ci" })).measurements.persisted, 20)
    const output = await driveQualification("tool-output", 1024 * 1024 + 7, { root, profile: "ci" })
    assert.equal(output.completed, 1024 * 1024 + 7)
    assert.equal(output.measurements.maxChunkBytes, 64 * 1024)
    assert.equal((await driveQualification("attach", 4, { root, profile: "ci" })).measurements.nativeZmx, false)
    const pending = await driveQualification("network-transition", 3, { root, profile: "ci" })
    assert.deepEqual(pending, { completed: 0, pending: 3, status: "IMPLEMENTED, RENDER VERIFICATION PENDING" })
    assert.equal((await driveQualification("cleanup", 0, { root, profile: "ci" })).measurements.cleaned, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("long qualification rejects keeper/file-only evidence and identity drift", async () => {
  await assert.rejects(() => qualify({
    profile: "long",
    overrides: { durationSeconds: 0, messages: 0, events: 0, toolOutputBytes: 0, reconnects: 0, attaches: 0, hubRestarts: 0, foregroundCycles: 0, networkCycles: 0 },
    driver: async (_action, expected) => ({ completed: expected, measurements: { nativeZmx: false, fixture: true } }),
  }), /did not report native zmx evidence/)
  const identity = { nativeZmx: true, liveSessionId: "01900000-0000-7000-8000-000000000001", zmxName: "rubato-019000000000", stableSessionPid: 101 }
  assert.deepEqual(validateNativeEvidence("session", identity), { liveSessionId: identity.liveSessionId, zmxName: identity.zmxName, sessionPid: 101 })
  assert.throws(() => validateNativeEvidence("message", { ...identity, stableSessionPid: 102 }, { liveSessionId: identity.liveSessionId, zmxName: identity.zmxName, sessionPid: 101 }), /changed.*identity or PID/)
})

test("long driver fails before setup unless every native host boundary is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "rubato-driver-native-required-"))
  try { await assert.rejects(() => driveQualification("session", 0, { root, profile: "long" }), /long qualification requires/) }
  finally { await rm(root, { recursive: true, force: true }) }
})

test("one real zmx session preserves identity across PTY message, event, output, reconnect, and attach", { skip: !(realZmx && realCurrent) }, async () => {
  await Promise.all([access(realZmx), access(join(realCurrent, "hub", "bun-helper.ts"))])
  const root = await mkdtemp(join(tmpdir(), "rubato-driver-real-zmx-"))
  const options = { root, profile: "long", zmx: realZmx, current: realCurrent, cli: process.execPath, hubRestart: ["/usr/bin/true"], bun: "bun" }
  try {
    const results = []
    for (const [action, expected] of [["message", 3], ["event", 4], ["tool-output", 4097], ["reconnect", 2], ["attach", 2]]) results.push(await driveQualification(action, expected, options))
    const identities = results.map((result) => validateNativeEvidence("real", result.measurements))
    assert.equal(new Set(identities.map((identity) => `${identity.liveSessionId}:${identity.zmxName}:${identity.sessionPid}`)).size, 1)
    assert.equal(results[2].measurements.bytes, 4097)
  } finally { await driveQualification("cleanup", 0, options).catch(() => {}); await rm(root, { recursive: true, force: true }) }
})

test("short built-in qualification cannot claim device or native-host pass", async () => {
  const report = await qualify({ profile: "ci", overrides: { durationSeconds: 0, messages: 2, events: 3, toolOutputBytes: 4097, reconnects: 2, attaches: 2, hubRestarts: 1 } })
  assert.equal(report.passed, false)
  assert.equal(report.status, "IMPLEMENTED, RENDER VERIFICATION PENDING")
  assert.equal(report.actions.find((item) => item.action === "message").measurements.nativeZmx, false)
  assert.equal(report.pending.length, 2)
  assert.equal(qualificationExitCode(report, { profile: "ci" }), 1)
  assert.equal(qualificationExitCode(report, { profile: "ci", allowDevicePending: true }), 0)
  assert.equal(qualificationExitCode(report, { profile: "long", allowDevicePending: true }), 1)
})
