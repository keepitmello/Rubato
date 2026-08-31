import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto"
import { spawn } from "node:child_process"
import { access, chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises"
import { constants as fsConstants, existsSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { arch, platform, tmpdir } from "node:os"

import { HUB_LABEL, HUB_PORT_MAX, HUB_PORT_MIN, MINIMUM_NODE_MAJOR, REMOTE_PATH, SUPPORTED_BUN_VERSION, ZMX_COMMIT } from "./constants.mjs"
import { atomicSymlink, commandString, currentRelease, ensurePrivateDirectories, fileMode, isInside, parseJsonOutput, pathExists, readJson, redact, relativeTarget, run, sha256, uuidV7, writeJsonPrivate, writePrivate } from "./lib.mjs"

export function assertMacOS() {
  if (platform() !== "darwin") throw new Error("Rubato Remote supports macOS only")
  if (!["arm64", "x64"].includes(arch())) throw new Error(`unsupported macOS architecture: ${arch()}`)
}

export function assertNodeVersion(version = process.versions.node) {
  const major = Number(version.split(".")[0])
  if (!Number.isSafeInteger(major) || major < MINIMUM_NODE_MAJOR) throw new Error(`Node ${MINIMUM_NODE_MAJOR}+ is required; found ${version}`)
  return version
}

export async function assertBunVersion(command = "bun", runner = run) {
  const result = await runner(command, ["--version"])
  const version = result.stdout.trim()
  if (version !== SUPPORTED_BUN_VERSION) throw new Error(`Bun ${SUPPORTED_BUN_VERSION} is required; found ${version || "unknown"}`)
  return version
}

export function zmxAssetName(machineArch = arch()) {
  if (machineArch === "arm64") return "zmx-darwin-arm64"
  if (machineArch === "x64") return "zmx-darwin-x64"
  throw new Error(`unsupported zmx architecture: ${machineArch}`)
}

export async function verifyZmxAsset(path, expectedSha256) {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? "")) throw new Error("zmx SHA-256 must come from the signed per-release manifest")
  const actual = await sha256(path)
  if (actual !== expectedSha256) throw new Error(`zmx checksum mismatch: expected ${expectedSha256}, got ${actual}`)
  await access(path, fsConstants.X_OK)
  return actual
}

export async function listManagedZmxSessions(zmxPath, runner = run) {
  if (!await pathExists(zmxPath)) return []
  const result = await runner(zmxPath, ["list", "--short"], { check: false, timeoutMs: 5_000 })
  if (result.code !== 0) throw new Error(`zmx inventory failed with exit ${result.code}`)
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((name) => /^rubato-[0-9a-f]{12}$/.test(name))
}

export async function installZmx(source, destination, expectedHash) {
  const existing = await pathExists(destination) ? await sha256(destination) : null
  if (existing === expectedHash) return { changed: false, hash: existing }
  const active = await listManagedZmxSessions(destination)
  if (active.length > 0) throw new Error(`zmx update deferred; active sessions: ${active.join(", ")}`)
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
  const temporary = `${destination}.${process.pid}.tmp`
  await rm(temporary, { force: true })
  await BunWriteExecutable(source, temporary)
  if (await sha256(temporary) !== expectedHash) throw new Error("staged zmx checksum changed")
  await import("node:fs/promises").then(({ rename }) => rename(temporary, destination))
  return { changed: true, hash: expectedHash }
}

async function BunWriteExecutable(source, destination) {
  const data = await readFile(source)
  await writeFile(destination, data, { mode: 0o755, flag: "wx" })
  await chmod(destination, 0o755)
}

export async function activeSessions(paths, runner = run) {
  const live = []
  if (await pathExists(paths.socket)) {
    const cli = join(paths.current, "live-cli", "bin", "rubato-live.mjs")
    if (await pathExists(cli)) {
      const result = await runner(process.execPath, [cli, "list", "--json"], { check: false, timeoutMs: 5_000 })
      if (result.code === 0) {
        try { live.push(...JSON.parse(result.stdout)) } catch { throw new Error("active session inventory returned invalid JSON") }
      }
    }
  }
  if (live.length === 0) {
    for (const name of await listManagedZmxSessions(paths.zmx, runner)) live.push({ zmxName: name, state: "unknown" })
  }
  return live
}

export async function guardUpdate(paths, { forceLive = false, runner = run } = {}) {
  const sessions = await activeSessions(paths, runner)
  if (sessions.length > 0 && !forceLive) throw new Error(`update blocked by ${sessions.length} live session(s): ${sessions.map((item) => item.liveSessionId ?? item.zmxName).join(", ")}`)
  return sessions
}

export function renderLaunchAgent({ nodePath, bunPath, tailscalePath, entryPath, bootstrapPath, launcherPath, zmxPath, stdoutPath, stderrPath, home, tmpDirectory = tmpdir(), buildId }) {
  const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${HUB_LABEL}</string>\n<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(entryPath)}</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>TMPDIR</key><string>${xml(tmpDirectory)}</string><key>RUBATO_BUILD_ID</key><string>${xml(buildId)}</string><key>RUBATO_BUN_BIN</key><string>${xml(bunPath)}</string><key>RUBATO_BOOTSTRAP_PATH</key><string>${xml(bootstrapPath)}</string><key>RUBATO_LAUNCHER_PATH</key><string>${xml(launcherPath)}</string><key>RUBATO_ZMX_PATH</key><string>${xml(zmxPath)}</string><key>RUBATO_TAILSCALE_PATH</key><string>${xml(tailscalePath)}</string></dict>\n<key>StandardOutPath</key><string>${xml(stdoutPath)}</string>\n<key>StandardErrorPath</key><string>${xml(stderrPath)}</string>\n</dict></plist>\n`
}

export async function installLaunchAgent(paths, buildId, runner = run, bunPath = "bun", launcherPath = join(paths.current, "bin", "rubato"), tailscalePath = "tailscale") {
  await mkdir(dirname(paths.plist), { recursive: true })
  await mkdir(paths.logs, { recursive: true, mode: 0o700 })
  const plist = renderLaunchAgent({
    nodePath: process.execPath,
    bunPath,
    tailscalePath,
    entryPath: join(paths.current, "hub", "main.mjs"),
    bootstrapPath: join(paths.current, "bin", "rubato-live-bootstrap"),
    launcherPath,
    zmxPath: paths.zmx,
    stdoutPath: join(paths.logs, "hub.stdout.log"),
    stderrPath: join(paths.logs, "hub.stderr.log"),
    home: paths.home,
    buildId,
  })
  await writePrivate(paths.plist, plist)
  const domain = `gui/${process.getuid()}`
  await runner("/bin/launchctl", ["bootout", domain, paths.plist], { check: false, timeoutMs: 10_000 })
  await runner("/bin/launchctl", ["bootstrap", domain, paths.plist])
  await runner("/bin/launchctl", ["enable", `${domain}/${HUB_LABEL}`])
  await runner("/bin/launchctl", ["kickstart", "-k", `${domain}/${HUB_LABEL}`])
}

export async function waitForHealth(port, { attempts = 40, delayMs = 250, fetchImpl = fetch } = {}) {
  let last = "unreachable"
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/rubato/api/v1/health`, { signal: AbortSignal.timeout(1_000) })
      const body = await response.json()
      if (response.ok && body?.ok === true) return body
      last = `HTTP ${response.status}`
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
    if (index + 1 < attempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
  }
  throw new Error(`localhost hub health failed: ${last}`)
}

export async function tailscaleIdentity(tailscale = "tailscale", runner = run) {
  const result = await runner(tailscale, ["status", "--json"], { check: false, timeoutMs: 10_000 })
  if (result.code !== 0) return { loggedIn: false, reason: "tailscale status unavailable" }
  const status = parseJsonOutput(result, "tailscale status")
  if (status.BackendState !== "Running" || !status.Self?.Online) return { loggedIn: false, reason: `Tailscale state is ${status.BackendState ?? "unknown"}` }
  const user = status.User?.[String(status.Self.UserID)]
  const login = user?.LoginName
  if (typeof login !== "string" || !login.trim()) throw new Error("Tailscale owner login is unavailable")
  return { loggedIn: true, login: login.normalize("NFKC").trim().toLowerCase(), dnsName: String(status.Self.DNSName ?? "").replace(/\.$/, ""), hostName: status.Self.HostName }
}

export async function configureServe(tailscale, port, webRoot, runner = run) {
  if (!Number.isSafeInteger(port) || port < HUB_PORT_MIN || port > HUB_PORT_MAX) throw new Error("invalid hub port")
  const resolvedWebRoot = await realpath(webRoot)
  const snapshot = await serveStatus(tailscale, runner)
  assertNoFunnel(snapshot)
  assertRubatoServeRoutesAvailable(snapshot, port, resolvedWebRoot)
  try {
    await setServePath(tailscale, "/rubato", `http://127.0.0.1:${port}/rubato`, runner)
    await setServePath(tailscale, "/rubato/api", `http://127.0.0.1:${port}/rubato/api`, runner)
    const after = await serveStatus(tailscale, runner)
    assertNoFunnel(after)
    assertExactRubatoServeRoutes(after, port, resolvedWebRoot)
    return { status: after, snapshot, port, webRoot: resolvedWebRoot }
  } catch (cause) {
    try { await restoreServeSnapshot(tailscale, snapshot, port, resolvedWebRoot, runner) }
    catch (restoreError) { throw new AggregateError([cause, restoreError], "Tailscale Serve mutation failed and its exact pre-mutation Rubato routes could not be restored") }
    throw cause
  }
}

export async function restoreServeSnapshot(tailscale, snapshot, port, webRoot, runner = run) {
  assertNoFunnel(snapshot)
  const current = await serveStatus(tailscale, runner)
  assertNoFunnel(current)
  assertRubatoServeRoutesAvailable(current, port, webRoot)
  for (const path of RUBATO_SERVE_PATHS) {
    if (servePathHandlers(current, path).length > 0) await clearServePath(tailscale, path, runner)
  }
  for (const path of RUBATO_SERVE_PATHS) {
    const handlers = servePathHandlers(snapshot, path)
    if (handlers.length > 1) throw new Error(`cannot restore ambiguous Tailscale Serve route ${path}`)
    const handler = handlers[0]
    if (!handler) continue
    const target = typeof handler.Proxy === "string" ? handler.Proxy : typeof handler.Path === "string" ? handler.Path : null
    if (!target) throw new Error(`cannot restore unsupported Tailscale Serve handler ${path}`)
    await setServePath(tailscale, path, target, runner)
  }
  const restored = await serveStatus(tailscale, runner)
  if (JSON.stringify(rubatoServeHandlers(restored)) !== JSON.stringify(rubatoServeHandlers(snapshot))) throw new Error("Tailscale Serve Rubato route rollback did not restore the exact prior handlers")
}

export async function writeServeStateRecord(paths, state) {
  if (!["present", "absent"].includes(state)) throw new Error("invalid installer Serve state")
  await mkdir(dirname(paths.installerStateKey), { recursive: true, mode: 0o700 })
  let privateKey
  if (await pathExists(paths.installerStateKey)) privateKey = createPrivateKey(await readFile(paths.installerStateKey))
  else {
    privateKey = generateKeyPairSync("ed25519").privateKey
    await writePrivate(paths.installerStateKey, privateKey.export({ type: "pkcs8", format: "pem" }))
  }
  const payload = { schemaVersion: 1, owner: "rubato-remote-installer", serveRoutes: state }
  const encoded = Buffer.from(JSON.stringify(payload))
  await writeJsonPrivate(paths.serveState, { payload, signature: sign(null, encoded, privateKey).toString("base64") })
  return payload
}

export async function readServeStateRecord(paths) {
  try {
    const envelope = await readJson(paths.serveState, null)
    if (!envelope?.payload || envelope.payload.schemaVersion !== 1 || envelope.payload.owner !== "rubato-remote-installer" || !["present", "absent"].includes(envelope.payload.serveRoutes)) return null
    const privateKey = createPrivateKey(await readFile(paths.installerStateKey))
    const encoded = Buffer.from(JSON.stringify(envelope.payload))
    return verify(null, encoded, createPublicKey(privateKey), Buffer.from(envelope.signature, "base64")) ? envelope.payload : null
  } catch { return null }
}

export async function serveStatus(tailscale = "tailscale", runner = run) {
  const result = await runner(tailscale, ["serve", "status", "--json"], { check: false, timeoutMs: 10_000 })
  if (result.code !== 0) throw new Error("Tailscale Serve status unavailable")
  return parseJsonOutput(result, "tailscale serve status")
}

export function assertNoFunnel(status) {
  if (hasEnabledFunnel(status)) throw new Error("Tailscale Funnel is forbidden for Rubato Remote")
}

function hasEnabledFunnel(value, underFunnelKey = false) {
  if (value === null || value === undefined || value === false) return false
  if (underFunnelKey && (value === true || typeof value === "string" || typeof value === "number")) return Boolean(value)
  if (Array.isArray(value)) return value.some((item) => hasEnabledFunnel(item, underFunnelKey))
  if (typeof value !== "object") return false
  return Object.entries(value).some(([key, item]) => hasEnabledFunnel(item, underFunnelKey || /funnel/i.test(key)))
}

export function serveHasRubatoTarget(status, port) {
  const encoded = JSON.stringify(status)
  return encoded.includes("/rubato") && encoded.includes(`127.0.0.1:${port}`)
}

export function assertRubatoServeRoutesAvailable(config, port, webRoot) {
  const expectedRootProxy = `http://127.0.0.1:${port}/rubato`
  const expectedProxy = `http://127.0.0.1:${port}/rubato/api`
  for (const web of Object.values(config?.Web ?? {})) {
    const handlers = web?.Handlers ?? {}
    for (const path of ["/rubato", "/rubato/"]) {
      const handler = handlers[path]
      if (handler && handler.Path !== webRoot && handler.Path !== `${webRoot}/` && handler.Proxy !== `http://127.0.0.1:${port}` && handler.Proxy !== expectedRootProxy) throw new Error(`refusing to overwrite existing non-Rubato Serve route ${path}`)
    }
    for (const path of ["/rubato/api", "/rubato/api/"]) {
      const handler = handlers[path]
      if (handler && handler.Proxy !== expectedProxy) throw new Error(`refusing to overwrite existing non-Rubato Serve route ${path}`)
    }
  }
}

export function assertExactRubatoServeRoutes(config, port, webRoot) {
  assertRubatoServeRoutesAvailable(config, port, webRoot)
  const rootProxy = `http://127.0.0.1:${port}/rubato`
  const apiProxy = `http://127.0.0.1:${port}/rubato/api`
  if (!servePathHandlers(config, "/rubato").some((handler) => handler.Proxy === rootProxy)
    || !servePathHandlers(config, "/rubato/api").some((handler) => handler.Proxy === apiProxy)) {
    throw new Error("Tailscale Serve did not retain both exact Rubato routes")
  }
}

export async function removeRubatoServeRoute(tailscale = "tailscale", port, webRoot, runner = run) {
  if (!Number.isSafeInteger(port) || port < HUB_PORT_MIN || port > HUB_PORT_MAX) throw new Error("valid Rubato hub port is required for selective Serve removal")
  const status = await serveStatus(tailscale, runner)
  assertNoFunnel(status)
  if (!serveHasRubatoTarget(status, port)) return { changed: false }

  const resolvedWebRoot = await realpath(webRoot)
  assertRubatoServeRoutesAvailable(status, port, resolvedWebRoot)
  const owned = rubatoServeHandlers(status)
  if (Object.keys(owned).length === 0) throw new Error("could not identify the owned /rubato handler in Serve config; refusing broad cleanup")
  for (const path of Object.keys(owned)) await clearServePath(tailscale, path, runner)
  const verified = await serveStatus(tailscale, runner)
  if (serveHasRubatoTarget(verified, port)) throw new Error("Rubato Serve route removal did not take effect")
  return { changed: true }
}

export function withoutRubatoServeRoute(config, port, webRoot) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid Tailscale Serve config")
  const next = structuredClone(config)
  const expectedProxy = `http://127.0.0.1:${port}/rubato/api`
  const expectedRootProxy = `http://127.0.0.1:${port}/rubato`
  let removed = false
  for (const web of Object.values(next.Web ?? {})) {
    if (!web || typeof web !== "object" || Array.isArray(web)) continue
    const handlers = web.Handlers
    if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) continue
    for (const path of ["/rubato/api", "/rubato/api/"]) {
      const handler = handlers[path]
      if (handler?.Proxy !== expectedProxy) continue
      delete handlers[path]
      removed = true
    }
    for (const path of ["/rubato", "/rubato/"]) {
      const handler = handlers[path]
      const ownedStaticPath = typeof webRoot === "string" && (handler?.Path === webRoot || handler?.Path === `${webRoot}/`)
      // Legacy one-proxy installations are also owned when they target this exact hub.
      const ownedProxy = handler?.Proxy === expectedRootProxy || handler?.Proxy === `http://127.0.0.1:${port}`
      if (!ownedStaticPath && !ownedProxy) continue
      delete handlers[path]
      removed = true
    }
  }
  return { config: next, removed }
}

const RUBATO_SERVE_PATHS = ["/rubato", "/rubato/api"]

function servePathHandlers(config, path) {
  const handlers = []
  for (const web of Object.values(config?.Web ?? {})) {
    const handler = web?.Handlers?.[path]
    if (handler && typeof handler === "object" && !Array.isArray(handler)) handlers.push(handler)
  }
  return handlers
}

function rubatoServeHandlers(config) {
  const handlers = {}
  for (const path of RUBATO_SERVE_PATHS) {
    const found = servePathHandlers(config, path)
    if (found.length === 1) handlers[path] = found[0]
    else if (found.length > 1) handlers[path] = found
  }
  return handlers
}

async function setServePath(tailscale, path, target, runner) {
  await runner(tailscale, ["serve", "--bg", "--yes", `--set-path=${path}`, target], { timeoutMs: 30_000 })
}

async function clearServePath(tailscale, path, runner) {
  await runner(tailscale, ["serve", "--https=443", `--set-path=${path}`, "off"], { timeoutMs: 30_000 })
}

export async function initializeIdentity(paths, identity, { displayName, port = HUB_PORT_MIN } = {}) {
  if (!identity.loggedIn) throw new Error("Tailscale login is required to establish owner identity")
  const existing = await readJson(paths.host, null)
  if (existing && existing.ownerLogin !== identity.login) throw new Error("existing Rubato owner differs from the logged-in Tailscale identity")
  const createdAt = existing?.createdAt ?? new Date().toISOString()
  const host = {
    schemaVersion: 1,
    hostId: existing?.hostId ?? uuidV7(),
    displayName: displayName ?? existing?.displayName ?? identity.hostName ?? "Rubato Mac",
    ownerLogin: identity.login,
    httpPort: existing?.httpPort ?? port,
    createdAt,
  }
  await writeJsonPrivate(paths.host, host)
  await writeJsonPrivate(paths.owner, { schemaVersion: 1, login: identity.login, establishedAt: createdAt, source: "tailscale-local-status" })
  return host
}

export async function ensureStateLayout(paths) {
  await ensurePrivateDirectories([paths.state, paths.keys, paths.push, paths.pair, paths.journal, paths.snapshots, paths.artifacts, paths.audit, paths.logs])
}

export async function terminalBridgeSmoke(paths, bunPath, runner = run) {
  const helper = join(paths.current, "hub", "bun-helper.ts")
  const name = `rubato-${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex")}`
  const marker = `rubato-terminal-smoke-${randomUUID()}`
  await runner(paths.zmx, ["run", name, "-d", "/bin/cat"])
  const child = spawn(bunPath, [helper, "--zmx", paths.zmx, "--name", name, "--cols", "80", "--rows", "24"], { stdio: ["pipe", "pipe", "pipe"], shell: false })
  let output = Buffer.alloc(0)
  try {
    await new Promise((resolveSmoke, reject) => {
      let settled = false
      const finish = (operation, value) => { if (settled) return; settled = true; clearTimeout(timer); operation(value) }
      const timer = setTimeout(() => finish(reject, new Error("terminal bridge attach smoke timed out")), 5_000)
      timer.unref?.()
      child.once("error", (error) => finish(reject, error))
      child.once("exit", (code) => finish(reject, new Error(`terminal bridge exited ${code} before echo`)))
      child.stdout.on("data", (chunk) => {
        output = Buffer.concat([output, chunk])
        if (output.includes(marker)) finish(resolveSmoke)
      })
      // Subscribe to the exact output before sending the input frame.
      const payload = Buffer.from(`${marker}\n`)
      const frame = Buffer.alloc(5 + payload.length)
      frame[0] = 0x02
      frame.writeUInt32BE(payload.length, 1)
      payload.copy(frame, 5)
      child.stdin.write(frame)
    })
    const exit = Buffer.alloc(5)
    exit[0] = 0x04
    child.stdin.end(exit)
    return { bytes: output.length }
  } finally {
    child.kill("SIGTERM")
    await runner(paths.zmx, ["kill", name], { check: false, timeoutMs: 5_000 })
  }
}

export async function zmxSmoke(zmx, runner = run) {
  const name = `rubato-${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex")}`
  try {
    await runner(zmx, ["run", name, "-d", "/usr/bin/true"])
    const inventory = await runner(zmx, ["list", "--short"])
    if (!inventory.stdout.split(/\r?\n/).includes(name)) throw new Error("zmx smoke session was not listed")
  } finally {
    await runner(zmx, ["kill", name], { check: false, timeoutMs: 5_000 })
  }
}

export function setupInstructions(identity) {
  if (!identity.loggedIn) return ["Install Tailscale, run `tailscale up`, then rerun `node scripts/remote-release/remote-release.mjs install ...`."]
  const url = `https://${identity.dnsName}${REMOTE_PATH}`
  return [
    `Open ${url} on an iPhone signed into the same tailnet.`,
    "In Safari, choose Share > Add to Home Screen, then launch Rubato from the Home Screen.",
    "Do not enable Tailscale Funnel.",
  ]
}
