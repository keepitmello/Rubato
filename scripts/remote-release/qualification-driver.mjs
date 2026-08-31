#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream, watch } from "node:fs"
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { once } from "node:events"

import { run, uuidV7 } from "./lib.mjs"

const DEVICE_PENDING = "IMPLEMENTED, RENDER VERIFICATION PENDING"
const MAX_FRAME_PAYLOAD = 256 * 1024
const WORKER_SOURCE = `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
writeFileSync(fileURLToPath(import.meta.url)+".pid",String(process.pid));
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
const write=(value)=>new Promise((ok)=>process.stdout.write(value)?ok():process.stdout.once("drain",ok));
lines.on("line",async(line)=>{const [kind,id,value]=line.trim().split(" ");
 if(kind==="MESSAGE")await write("ACK MESSAGE "+id+" "+value+"\\n");
 else if(kind==="EVENT")await write("ACK EVENT "+id+"\\n");
 else if(kind==="OUTPUT"){const bytes=Number(value),chunk=Buffer.alloc(65536,0x5a),hash=createHash("sha256");let left=bytes;await write("BEGIN OUTPUT "+id+" "+bytes+"\\n");while(left>0){const part=chunk.subarray(0,Math.min(left,chunk.length));hash.update(part);await write(part);left-=part.length}await write("\\nEND OUTPUT "+id+" "+bytes+" "+hash.digest("hex")+"\\n");}
});
`

export async function driveQualification(action, expected, options = {}) {
  const root = resolve(options.root ?? join(tmpdir(), "rubato-qualification-driver"))
  const real = realHostConfiguration(options)
  const native = options.profile === "long"
  if (native && !real.complete) throw new Error("long qualification requires RUBATO_QUALIFICATION_ZMX, RUBATO_QUALIFICATION_CURRENT, RUBATO_QUALIFICATION_CLI, and RUBATO_QUALIFICATION_HUB_RESTART_ARGV_JSON")
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (action === "cleanup") return native ? cleanupNative(root, real) : cleanupFixture(root)
  if (action === "foreground-background" || action === "network-transition") return { completed: 0, pending: expected, status: DEVICE_PENDING }
  if (!native) return driveFixture(action, expected, root)

  const state = await ensureNativeState(root, real)
  const identity = await assertNativeIdentity(state, real)
  if (action === "session") {
    const started = Date.now()
    const deadline = started + expected * 1000
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(60_000, deadline - Date.now())))
      await assertNativeIdentity(state, real)
    }
    return evidence(expected, identity, { elapsedMilliseconds: Date.now() - started })
  }
  if (action === "message") {
    const result = await nativeAcknowledgements(state, real, "MESSAGE", expected)
    return evidence(result.completed, identity, { acknowledgements: result.completed, ordered: true, transcriptBytes: result.transcriptBytes })
  }
  if (action === "event") {
    const result = await nativeAcknowledgements(state, real, "EVENT", expected)
    const persisted = await persistAcknowledgedEvents(root, result.ids)
    return evidence(persisted.completed, identity, { persisted: persisted.completed, ordered: true, journalBytes: persisted.bytes })
  }
  if (action === "tool-output") {
    const streamed = await nativeStreamingOutput(state, real, expected)
    return evidence(streamed.bytes, identity, { bytes: streamed.bytes, sha256: streamed.sha256, maxChunkBytes: MAX_FRAME_PAYLOAD })
  }
  if (action === "reconnect" || action === "attach") {
    let frameBytes = 0
    for (let index = 0; index < expected; index++) {
      const attached = await nativeAcknowledgements(state, real, "MESSAGE", 1, `${action}-${index + 1}`)
      frameBytes += attached.transcriptBytes
      await assertNativeIdentity(state, real)
    }
    return evidence(expected, identity, { acknowledgements: expected, terminalFrameBytes: frameBytes })
  }
  if (action === "hub-restart") {
    for (let index = 0; index < expected; index++) {
      await run(real.hubRestart[0], real.hubRestart.slice(1), { timeoutMs: 60_000 })
      const inventory = JSON.parse((await run(process.execPath, [real.cli, "list", "--json"], { timeoutMs: 10_000 })).stdout)
      if (!Array.isArray(inventory) || !inventory.some((entry) => entry?.liveSessionId === state.liveSessionId && entry?.zmxName === state.zmxName)) throw new Error("hub inventory did not recover the driver-owned live session")
      await assertNativeIdentity(state, real)
      await verifyPersistedEvents(root)
    }
    return evidence(expected, identity, { restarts: expected, inventoryRecovered: true, journalRecovered: true })
  }
  throw new Error(`unknown qualification action: ${action}`)
}

function evidence(completed, identity, extra = {}) {
  return { completed, measurements: { nativeZmx: true, liveSessionId: identity.liveSessionId, zmxName: identity.zmxName, stableSessionPid: identity.sessionPid, ...extra } }
}

async function ensureNativeState(root, real) {
  const statePath = join(root, "state.json")
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"))
    if (state.owner !== "rubato-qualification-driver-v1") throw new Error("qualification state is not driver-owned")
    await assertNativeIdentity(state, real)
    return state
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const liveSessionId = uuidV7()
  const zmxName = `rubato-${liveSessionId.replaceAll("-", "").slice(0, 12)}`
  const hostId = uuidV7()
  const worker = join(root, "native-session-worker.mjs")
  await writeFile(worker, WORKER_SOURCE, { mode: 0o700 })
  await chmod(worker, 0o700)
  await run(real.zmx, ["run", zmxName, "-d", worker], { timeoutMs: 10_000 })
  const labels = { app: "rubato", rubato_protocol: "1", rubato_live_id: liveSessionId, rubato_host_id: hostId, rubato_build_id: "qualification" }
  try {
    await run(real.zmx, ["set", zmxName, ...Object.entries(labels).map(([key, value]) => `${key}=${value}`)])
    const sessionPid = await waitForWorkerPid(worker)
    const state = { schemaVersion: 1, owner: "rubato-qualification-driver-v1", liveSessionId, zmxName, hostId, sessionPid, worker }
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    return state
  } catch (error) {
    await run(real.zmx, ["kill", zmxName], { check: false, timeoutMs: 5_000 }).catch(() => {})
    throw error
  }
}

async function assertNativeIdentity(state, real) {
  const inventory = (await run(real.zmx, ["list", "--short"], { timeoutMs: 5_000 })).stdout.split(/\r?\n/)
  if (!inventory.includes(state.zmxName)) throw new Error("driver-owned zmx session disappeared")
  try { process.kill(state.sessionPid, 0) } catch { throw new Error(`driver-owned zmx PID ${state.sessionPid} is not alive`) }
  const sessionPid = Number((await readFile(`${state.worker}.pid`, "utf8")).trim())
  if (sessionPid !== state.sessionPid) throw new Error(`driver-owned zmx PID changed from ${state.sessionPid} to ${sessionPid}`)
  for (const [label, expected] of [["app", "rubato"], ["rubato_live_id", state.liveSessionId], ["rubato_host_id", state.hostId]]) {
    const actual = (await run(real.zmx, ["get", state.zmxName, label], { timeoutMs: 5_000 })).stdout.trim()
    if (actual !== expected) throw new Error(`driver-owned zmx ${label} changed`)
  }
  return { nativeZmx: true, liveSessionId: state.liveSessionId, zmxName: state.zmxName, sessionPid }
}

async function waitForWorkerPid(worker) {
  const path = `${worker}.pid`
  const read = async () => {
    const value = Number((await readFile(path, "utf8")).trim())
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("native worker did not report a valid PID")
    return value
  }
  try { return await read() } catch (error) { if (error?.code !== "ENOENT") throw error }
  return new Promise((resolvePid, rejectPid) => {
    const timer = setTimeout(() => { watcher.close(); rejectPid(new Error("native worker PID acknowledgement timed out")) }, 5_000)
    const watcher = watch(resolve(worker, ".."), (_event, name) => {
      if (name !== `${worker.split("/").at(-1)}.pid`) return
      read().then((value) => { clearTimeout(timer); watcher.close(); resolvePid(value) }, rejectPid)
    })
  })
}

async function nativeAcknowledgements(state, real, kind, expected, prefix = kind.toLowerCase()) {
  const token = randomUUID().replaceAll("-", "")
  const wanted = Array.from({ length: expected }, (_, index) => `${token}-${prefix}-${index + 1}`)
  const acknowledged = []
  let transcriptBytes = 0
  await withNativeAttach(state, real, async ({ send, outputs, finish }) => {
    let text = ""
    outputs((chunk) => {
      transcriptBytes += chunk.length
      text = (text + chunk.toString("utf8")).slice(-1024 * 1024)
      for (const id of wanted.slice(acknowledged.length)) {
        const marker = `ACK ${kind} ${id}`
        if (!text.includes(marker)) break
        acknowledged.push(id)
      }
      if (acknowledged.length === expected) finish()
    })
    for (const id of wanted) await send(`${kind} ${id}${kind === "MESSAGE" ? ` ${Buffer.from(id).toString("base64")}` : ""}\n`)
  }, 30 * 60_000)
  if (acknowledged.length !== expected || acknowledged.some((id, index) => id !== wanted[index])) throw new Error(`${kind} acknowledgements were incomplete or out of order`)
  return { completed: acknowledged.length, ids: acknowledged, transcriptBytes }
}

async function nativeStreamingOutput(state, real, expected) {
  const token = randomUUID().replaceAll("-", "")
  let bytes = 0
  const hash = createHash("sha256")
  let begun = false
  let ended = false
  let tail = ""
  await withNativeAttach(state, real, async ({ send, outputs, finish }) => {
    outputs((chunk) => {
      tail = (tail + chunk.toString("latin1")).slice(-4096)
      if (!begun && tail.includes(`BEGIN OUTPUT ${token} ${expected}`)) begun = true
      if (begun && !ended) {
        let count = 0
        for (const value of chunk) if (value === 0x5a) count += 1
        if (count) { bytes += count; hash.update(Buffer.alloc(count, 0x5a)) }
      }
      if (begun && tail.includes(`END OUTPUT ${token} ${expected} `)) { ended = true; finish() }
    })
    await send(`OUTPUT ${token} ${expected}\n`)
  }, 2 * 60 * 60_000)
  if (!ended || bytes !== expected) throw new Error(`native session streamed ${bytes} bytes; expected ${expected}`)
  return { bytes, sha256: hash.digest("hex") }
}

async function withNativeAttach(state, real, operation, timeoutMs) {
  const helper = join(real.current, "hub", "bun-helper.ts")
  const child = spawn(real.bun, [helper, "--zmx", real.zmx, "--name", state.zmxName, "--cols", "160", "--rows", "50"], { stdio: ["pipe", "pipe", "pipe"], shell: false })
  let frameBuffer = Buffer.alloc(0)
  const listeners = []
  let settle
  const completed = new Promise((resolveDone, rejectDone) => { settle = { resolveDone, rejectDone } })
  const timer = setTimeout(() => settle.rejectDone(new Error("native zmx attach acknowledgement timed out")), timeoutMs)
  timer.unref?.()
  child.once("error", settle.rejectDone)
  child.once("exit", (code) => settle.rejectDone(new Error(`native zmx attach exited ${code} before acknowledgement`)))
  child.stdout.on("data", (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk])
    while (frameBuffer.length >= 5) {
      const type = frameBuffer[0]; const length = frameBuffer.readUInt32BE(1)
      if (length > MAX_FRAME_PAYLOAD) { settle.rejectDone(new Error("terminal frame exceeds qualification bound")); return }
      if (frameBuffer.length < 5 + length) return
      const payload = frameBuffer.subarray(5, 5 + length); frameBuffer = frameBuffer.subarray(5 + length)
      if (type === 0x01) for (const listener of listeners) listener(payload)
      else if (type === 0x05) settle.rejectDone(new Error(payload.toString("utf8")))
    }
  })
  const send = async (value) => {
    const payload = Buffer.from(value); const frame = Buffer.alloc(5 + payload.length); frame[0] = 0x02; frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5)
    if (!child.stdin.write(frame)) await once(child.stdin, "drain")
  }
  try {
    await operation({ send, outputs: (listener) => listeners.push(listener), finish: settle.resolveDone })
    await completed
  } finally {
    clearTimeout(timer)
    const exit = Buffer.alloc(5); exit[0] = 0x04; child.stdin.end(exit); child.kill("SIGTERM")
  }
}

async function persistAcknowledgedEvents(root, ids) {
  const path = join(root, "events.ndjson")
  const output = createWriteStream(path, { flags: "a", mode: 0o600 })
  for (let index = 0; index < ids.length; index++) if (!output.write(`${JSON.stringify({ sequence: index + 1, acknowledgement: ids[index] })}\n`)) await once(output, "drain")
  output.end(); await once(output, "close")
  const completed = await verifyPersistedEvents(root)
  return { completed, bytes: (await stat(path)).size }
}

async function verifyPersistedEvents(root) {
  const path = join(root, "events.ndjson")
  let count = 0
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    const event = JSON.parse(line); count += 1
    if (event.sequence !== count || typeof event.acknowledgement !== "string") throw new Error("recovered event journal changed order")
  }
  return count
}

async function cleanupNative(root, real) {
  try {
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"))
    if (state.owner !== "rubato-qualification-driver-v1") throw new Error("refusing to clean non-owned qualification session")
    await run(real.zmx, ["kill", state.zmxName], { check: false, timeoutMs: 5_000 })
  } catch (error) { if (error?.code !== "ENOENT") throw error }
  await rm(root, { recursive: true, force: true })
  return { completed: 0, measurements: { cleaned: true, nativeZmx: true } }
}

async function driveFixture(action, expected, root) {
  if (action === "session") return { completed: expected, measurements: { nativeZmx: false, fixture: true, elapsedMilliseconds: 0 } }
  if (action === "message") return fixtureMessageEcho(expected)
  if (action === "event") return fixtureEvents(root, expected)
  if (action === "tool-output") return fixtureOutput(root, expected)
  if (["reconnect", "attach", "hub-restart"].includes(action)) return { completed: expected, measurements: { nativeZmx: false, fixture: true, acknowledgements: expected } }
  throw new Error(`unknown qualification action: ${action}`)
}

async function fixtureMessageEcho(expected) {
  const child = spawn(process.execPath, ["-e", "const r=require('readline').createInterface({input:process.stdin});r.on('line',v=>process.stdout.write(v+'\\n'))"], { stdio: ["pipe", "pipe", "inherit"] })
  const lines = []; createInterface({ input: child.stdout }).on("line", (line) => lines.push(line))
  for (let index = 1; index <= expected; index++) child.stdin.write(`fixture-${index}\n`)
  child.stdin.end(); await once(child, "close")
  if (lines.some((line, index) => line !== `fixture-${index + 1}`)) throw new Error("fixture acknowledgement order changed")
  return { completed: lines.length, measurements: { nativeZmx: false, fixture: true, ordered: true } }
}

async function fixtureEvents(root, expected) {
  const path = join(root, "fixture-events.ndjson"); const output = createWriteStream(path, { mode: 0o600 })
  for (let sequence = 1; sequence <= expected; sequence++) output.write(`${JSON.stringify({ sequence })}\n`)
  output.end(); await once(output, "close")
  return { completed: expected, measurements: { nativeZmx: false, fixture: true, persisted: expected } }
}

async function fixtureOutput(root, expected) {
  const path = join(root, "fixture-output.bin"); const output = createWriteStream(path, { mode: 0o600 }); const chunk = Buffer.alloc(64 * 1024, 0x5a); let left = expected
  while (left > 0) { const part = chunk.subarray(0, Math.min(left, chunk.length)); if (!output.write(part)) await once(output, "drain"); left -= part.length }
  output.end(); await once(output, "close")
  return { completed: expected, measurements: { nativeZmx: false, fixture: true, maxChunkBytes: chunk.length } }
}

async function cleanupFixture(root) { await rm(root, { recursive: true, force: true }); return { completed: 0, measurements: { cleaned: true, nativeZmx: false } } }

function realHostConfiguration(options) {
  const zmx = options.zmx ?? process.env.RUBATO_QUALIFICATION_ZMX
  const current = options.current ?? process.env.RUBATO_QUALIFICATION_CURRENT
  const cli = options.cli ?? process.env.RUBATO_QUALIFICATION_CLI
  let hubRestart = options.hubRestart
  try { hubRestart ??= JSON.parse(process.env.RUBATO_QUALIFICATION_HUB_RESTART_ARGV_JSON ?? "null") } catch { throw new Error("RUBATO_QUALIFICATION_HUB_RESTART_ARGV_JSON is invalid") }
  return { zmx, current, cli, hubRestart, bun: options.bun ?? process.env.RUBATO_QUALIFICATION_BUN ?? "bun", complete: Boolean(zmx && current && cli && Array.isArray(hubRestart) && hubRestart.length) }
}

function parse(args) {
  const options = {}; const positional = []
  for (let index = 0; index < args.length; index++) { if (args[index] === "--root") options.root = args[++index]; else positional.push(args[index]) }
  if (positional.length !== 3) throw new Error("usage: qualification-driver.mjs [--root path] <action> <expected> <profile>")
  const expected = Number(positional[1]); if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("expected must be a non-negative safe integer")
  return { action: positional[0], expected, options: { ...options, profile: positional[2] } }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const parsed = parse(process.argv.slice(2))
  driveQualification(parsed.action, parsed.expected, parsed.options).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { console.error(`qualification-driver: ${error.message}`); process.exitCode = 1 })
}
