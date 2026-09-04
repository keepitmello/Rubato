import { lstat, readFile, readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"

import { HUB_LABEL, HUB_PORT_MAX, HUB_PORT_MIN, SUPPORTED_BUN_VERSION, ZMX_COMMIT } from "./constants.mjs"
import { fileMode, pathExists, readJson, redact, run, SECRET_VALUE, sha256 } from "./lib.mjs"
import { assertBunVersion, assertNoFunnel, assertNodeVersion, listManagedZmxSessions, serveHasRubatoTarget, serveStatus, tailscaleIdentity, waitForHealth } from "./system.mjs"

export async function doctor(paths, options = {}) {
  const runner = options.runner ?? run
  const checks = []
  const check = async (name, operation, { warning = false } = {}) => {
    try {
      const detail = await operation()
      checks.push({ name, status: "pass", ...(detail === undefined ? {} : { detail: redact(detail) }) })
    } catch (error) {
      checks.push({ name, status: warning ? "warn" : "fail", detail: redact(error instanceof Error ? error.message : String(error)) })
    }
  }
  let host = null
  let release = null

  await check("node", () => ({ version: assertNodeVersion() }))
  await check("bun", async () => ({ version: await assertBunVersion(options.bun ?? "bun", runner), pinned: SUPPORTED_BUN_VERSION }))
  await check("state-permissions", async () => {
    const mode = await fileMode(paths.state)
    if ((mode & 0o077) !== 0) throw new Error("remote state directory is accessible to group or other users")
    return { mode: mode.toString(8) }
  })
  await check("host-config", async () => {
    host = await readJson(paths.host)
    if (host.schemaVersion !== 1 || !host.hostId || !host.ownerLogin || host.httpPort < HUB_PORT_MIN || host.httpPort > HUB_PORT_MAX) throw new Error("host config is invalid")
    return { hostId: host.hostId, ownerLogin: host.ownerLogin, httpPort: host.httpPort }
  })
  await check("owner-identity", async () => {
    const owner = await readJson(paths.owner)
    if (!host) host = await readJson(paths.host)
    if (owner.schemaVersion !== 1 || owner.login !== host.ownerLogin) throw new Error("owner identity does not match host config")
    const identity = await tailscaleIdentity(options.tailscale ?? "tailscale", runner)
    if (!identity.loggedIn || identity.login !== owner.login) throw new Error("logged-in Tailscale identity does not match Rubato owner")
    return { login: owner.login }
  })
  await check("current-release", async () => {
    release = await readJson(join(paths.current, "release.json"))
    if (!release.buildId || release.zmx?.commit !== ZMX_COMMIT) throw new Error("release metadata is invalid")
    return { buildId: release.buildId, sourceCommit: release.sourceCommit }
  })
  await check("launchd", async () => {
    const result = await runner("/bin/launchctl", ["print", `gui/${process.getuid()}/${HUB_LABEL}`], { check: false, timeoutMs: 5_000 })
    if (result.code !== 0) throw new Error("hub LaunchAgent is not loaded")
    return { loaded: true }
  })
  await check("localhost-health", async () => {
    if (!host) host = await readJson(paths.host)
    return waitForHealth(host.httpPort, { attempts: 1, fetchImpl: options.fetchImpl ?? fetch })
  })
  await check("unix-socket", async () => {
    const info = await lstat(paths.socket)
    if (!info.isSocket()) throw new Error("hub control path is not a Unix socket")
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error("hub socket is not owner-only")
    return { mode: (info.mode & 0o777).toString(8) }
  })
  await check("zmx-integrity", async () => {
    if (!release) release = await readJson(join(paths.current, "release.json"))
    const hash = await sha256(paths.zmx)
    if (hash !== release.zmx.sha256) throw new Error("installed zmx hash differs from release")
    const sessions = await listManagedZmxSessions(paths.zmx, runner)
    return { hash, managedSessions: sessions.length }
  })
  await check("zmx-smoke-candidates", async () => ({ staleCandidates: await staleCandidates(paths) }), { warning: true })
  await check("pi-patch-pin", async () => {
    const packageJson = await readJson(join(options.repository ?? process.cwd(), "package.json"))
    const pins = {
      "@earendil-works/pi-agent-core": "npm:@code-yeongyu/senpi-agent-core@2026.9.4-3",
      "@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@2026.9.4-3",
      "@earendil-works/pi-tui": "npm:@code-yeongyu/senpi-tui@2026.9.4-3",
    }
    for (const [name, version] of Object.entries(pins)) {
      if (packageJson.overrides?.[name] !== version) throw new Error(`${name} is not exactly pinned to ${version}`)
    }
    if (packageJson.devDependencies?.["@code-yeongyu/senpi"] !== "2026.9.4-3") {
      throw new Error("@code-yeongyu/senpi is not exactly pinned to 2026.9.4-3")
    }
    return { version: "2026.9.4-3" }
  })
  await check("tailscale-serve", async () => {
    if (!host) host = await readJson(paths.host)
    const status = await serveStatus(options.tailscale ?? "tailscale", runner)
    assertNoFunnel(status)
    if (!serveHasRubatoTarget(status, host.httpPort)) throw new Error("scoped /rubato Serve route is missing or points elsewhere")
    return { path: "/rubato", funnel: false }
  })
  await check("pwa", async () => {
    const manifest = await readJson(join(paths.current, "web", "manifest.webmanifest"))
    const sw = await readFile(join(paths.current, "web", "sw.js"), "utf8")
    if (manifest.scope !== "/rubato/" || manifest.start_url !== "/rubato/" || !sw.trim()) throw new Error("PWA manifest or service worker is invalid")
    return { scope: manifest.scope, serviceWorkerBytes: Buffer.byteLength(sw) }
  })
  await check("push-profile", async () => {
    const entries = await readdir(paths.push).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error))
    return { configured: entries.length > 0, files: entries.length }
  }, { warning: true })
  await check("cmux-vault", async () => {
    const script = join(options.repository ?? process.cwd(), "harness", "scripts", "cmux-vault.mjs")
    const result = await runner(process.execPath, [script, "--check"], { check: false, timeoutMs: 10_000 })
    if (result.code !== 0) throw new Error("cmux Vault Rubato command is missing or stale")
    return { configured: true }
  }, { warning: true })
  await check("baseline-environment", async () => {
    const document = await readJson(paths.baseline)
    if (document.schemaVersion !== 1 || document.algorithm !== "AES-256-GCM" || !document.ciphertext || !document.nonce || !document.tag) throw new Error("encrypted baseline environment is missing or invalid")
    const module = await import(pathToFileURL(join(paths.current, "live-cli", "src", "baseline-environment.mjs")).href)
    const environment = new module.BaselineEnvironmentStore({ path: paths.baseline }).load()
    if (!environment || typeof environment !== "object") throw new Error("baseline environment could not be decrypted")
    return { encrypted: true, decryptable: true, variables: Object.keys(environment).length, plaintextExposed: false }
  })
  await check("audit-log-secret-scan", async () => {
    const scanned = await scanForSecrets([paths.audit, paths.logs])
    return { files: scanned }
  })
  await check("protocol-compatibility", async () => {
    const constants = await readFile(join(options.repository ?? process.cwd(), "packages", "rubato-remote-protocol", "src", "constants.ts"), "utf8")
    if (!constants.includes("REMOTE_PROTOCOL_CURRENT_VERSION") || !constants.includes("REMOTE_PROTOCOL_MIN_VERSION")) throw new Error("N/N-1 protocol constants are unavailable")
    return { policy: "N/N-1" }
  })
  const failed = checks.filter((item) => item.status === "fail").length
  const warned = checks.filter((item) => item.status === "warn").length
  return { ok: failed === 0, summary: { passed: checks.length - failed - warned, warned, failed }, checks }
}

async function scanForSecrets(roots) {
  let scanned = 0
  const pending = [...roots]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { pending.push(path); continue }
      if (!entry.isFile()) continue
      const info = await stat(path)
      if (info.size > 10 * 1024 * 1024) throw new Error(`secret scan size limit exceeded: ${basename(path)}`)
      const text = await readFile(path, "utf8")
      SECRET_VALUE.lastIndex = 0
      if (SECRET_VALUE.test(text)) throw new Error(`credential-shaped value found in ${basename(path)}`)
      scanned += 1
      if (scanned > 1_000) throw new Error("secret scan file limit exceeded")
    }
  }
  return scanned
}

async function staleCandidates(paths) {
  const output = []
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const directory of [paths.artifacts, paths.journal, paths.snapshots]) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      const info = await stat(path).catch(() => null)
      if (info && info.mtimeMs < cutoff) output.push(`${basename(directory)}/${entry.name}`)
    }
  }
  return output.slice(0, 100)
}
