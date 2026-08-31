#!/usr/bin/env node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { redact, run } from "./lib.mjs"

export const PROFILES = Object.freeze({
  ci: Object.freeze({ durationSeconds: 2, messages: 10, events: 100, toolOutputBytes: 1024 * 1024, reconnects: 3, attaches: 3, hubRestarts: 2, foregroundCycles: 3, networkCycles: 3, maxRssGrowthBytes: 32 * 1024 * 1024 }),
  long: Object.freeze({ durationSeconds: 8 * 60 * 60, messages: 1_000, events: 10_000, toolOutputBytes: 500 * 1024 * 1024, reconnects: 100, attaches: 100, hubRestarts: 20, foregroundCycles: 100, networkCycles: 100, maxRssGrowthBytes: 256 * 1024 * 1024 }),
})

const ACTIONS = [
  ["session", "durationSeconds"],
  ["message", "messages"],
  ["event", "events"],
  ["tool-output", "toolOutputBytes"],
  ["reconnect", "reconnects"],
  ["attach", "attaches"],
  ["hub-restart", "hubRestarts"],
  ["foreground-background", "foregroundCycles"],
  ["network-transition", "networkCycles"],
]

export async function qualify(options = {}) {
  const profileName = options.profile ?? "long"
  const profile = { ...(PROFILES[profileName] ?? (() => { throw new Error(`unknown qualification profile: ${profileName}`) })()), ...(options.overrides ?? {}) }
  const driverRoot = options.driverRoot ?? await mkdtemp(join(tmpdir(), "rubato-qualification-"))
  const driverCommand = options.driverCommand ?? [process.execPath, join(import.meta.dirname, "qualification-driver.mjs"), "--root", driverRoot]
  const driver = options.driver ?? createCommandDriver(driverCommand, options.runner ?? run)
  const mobileDriver = options.mobileDriverCommand ? createCommandDriver(options.mobileDriverCommand, options.runner ?? run) : null
  const startedAt = new Date().toISOString()
  const beforeRss = await measureRss(options.pid, options.runner ?? run)
  const counters = {}
  const actions = []
  const pending = []
  let nativeIdentity = null
  try {
    for (const [action, field] of ACTIONS) {
      const expected = profile[field]
      let result = await driver(action, expected, { profile: profileName })
      if ((action === "foreground-background" || action === "network-transition") && mobileDriver) result = await mobileDriver(action, expected, { profile: profileName })
      const completed = Number(result?.completed)
      const devicePending = (action === "foreground-background" || action === "network-transition") && completed === 0 && Number(result?.pending) === expected && result?.status === "IMPLEMENTED, RENDER VERIFICATION PENDING"
      if (!Number.isSafeInteger(completed) || (completed !== expected && !devicePending)) throw new Error(`${action} qualification completed ${completed}; expected ${expected}`)
      if (profileName === "long" && action !== "foreground-background" && action !== "network-transition") {
        nativeIdentity = validateNativeEvidence(action, result?.measurements, nativeIdentity)
      }
      counters[field] = completed
      if (devicePending) pending.push({ action, expected, status: result.status })
      actions.push({ action, expected, completed, ...(result?.measurements ? { measurements: result.measurements } : {}), ...(devicePending ? { pending: expected, status: result.status } : {}) })
    }
  } finally {
    await driver("cleanup", 0, { profile: profileName }).catch(() => {})
  }
  const afterRss = await measureRss(options.pid, options.runner ?? run)
  const rssGrowthBytes = beforeRss === null || afterRss === null ? null : afterRss - beforeRss
  if (rssGrowthBytes !== null && rssGrowthBytes > profile.maxRssGrowthBytes) throw new Error(`RSS grew by ${rssGrowthBytes} bytes; limit is ${profile.maxRssGrowthBytes}`)
  const report = {
    schemaVersion: 1,
    profile: profileName,
    passed: pending.length === 0,
    status: pending.length === 0 ? "passed" : "IMPLEMENTED, RENDER VERIFICATION PENDING",
    startedAt,
    finishedAt: new Date().toISOString(),
    counters,
    memory: { pid: options.pid ?? null, beforeRss, afterRss, rssGrowthBytes, limitBytes: profile.maxRssGrowthBytes },
    actions,
    pending,
    qualificationIdentity: nativeIdentity,
    environment: { realIPhone: pending.every((item) => item.action !== "foreground-background"), realNetworkTransitions: pending.every((item) => item.action !== "network-transition"), mobileAugmentation: mobileDriver !== null },
  }
  if (options.output) {
    await mkdir(dirname(resolve(options.output)), { recursive: true })
    await writeFile(resolve(options.output), `${JSON.stringify(redact(report), null, 2)}\n`)
  }
  return report
}

export function validateNativeEvidence(action, measurements, expectedIdentity = null) {
  if (measurements?.nativeZmx !== true || measurements?.fixture === true) throw new Error(`${action} did not report native zmx evidence`)
  const identity = { liveSessionId: measurements.liveSessionId, zmxName: measurements.zmxName, sessionPid: measurements.stableSessionPid }
  if (typeof identity.liveSessionId !== "string" || !/^rubato-[0-9a-f]{12}$/.test(identity.zmxName ?? "") || !Number.isSafeInteger(identity.sessionPid) || identity.sessionPid <= 0) throw new Error(`${action} native zmx identity is incomplete`)
  if (expectedIdentity && (identity.liveSessionId !== expectedIdentity.liveSessionId || identity.zmxName !== expectedIdentity.zmxName || identity.sessionPid !== expectedIdentity.sessionPid)) throw new Error(`${action} changed the qualified live session identity or PID`)
  return expectedIdentity ?? identity
}

export function createCommandDriver(command, runner = run) {
  if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== "string" || !item)) throw new Error("qualification requires a JSON argv driver; shell strings are not accepted")
  return async (action, expected, context) => {
    const result = await runner(command[0], [...command.slice(1), action, String(expected), context.profile], { timeoutMs: action === "session" ? (expected + 300) * 1000 : 30 * 60_000 })
    try { return JSON.parse(result.stdout) } catch { throw new Error(`${action} driver returned invalid JSON`) }
  }
}

export function createMockDriver() {
  return async (_action, expected) => ({ completed: expected })
}

async function measureRss(pid, runner) {
  if (!pid) return null
  const result = await runner("/bin/ps", ["-o", "rss=", "-p", String(pid)], { check: false, timeoutMs: 5_000 })
  if (result.code !== 0) throw new Error(`cannot measure RSS for pid ${pid}`)
  const kib = Number(result.stdout.trim())
  if (!Number.isFinite(kib)) throw new Error(`invalid RSS for pid ${pid}`)
  return kib * 1024
}

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--profile") options.profile = args[++index]
    else if (arg === "--driver-json") options.driverCommand = JSON.parse(args[++index])
    else if (arg === "--mobile-driver-json") options.mobileDriverCommand = JSON.parse(args[++index])
    else if (arg === "--driver-root") options.driverRoot = args[++index]
    else if (arg === "--mock-driver") options.mock = true
    else if (arg === "--pid") options.pid = Number(args[++index])
    else if (arg === "--output") options.output = args[++index]
    else if (arg === "--real-iphone") options.realIPhone = true
    else if (arg === "--real-network") options.realNetworkTransitions = true
    else if (arg === "--allow-device-pending") options.allowDevicePending = true
    else throw new Error(`unknown option: ${arg}`)
  }
  if (options.mock && options.profile !== "ci") throw new Error("mock qualification driver is restricted to the short CI profile")
  if (options.allowDevicePending && options.profile !== "ci") throw new Error("--allow-device-pending is restricted to the short CI profile")
  options.driver = options.mock ? createMockDriver() : undefined
  return options
}

export function qualificationExitCode(report, options = {}) {
  return report.passed === true || (options.profile === "ci" && options.allowDevicePending === true) ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const options = parseArgs(process.argv.slice(2))
  qualify(options).then((report) => { console.log(JSON.stringify(report)); process.exitCode = qualificationExitCode(report, options) }).catch((error) => { console.error(`qualification: ${error.message}`); process.exitCode = 1 })
}
