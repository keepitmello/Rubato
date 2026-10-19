#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { verifyRelease } from "./artifact.mjs"
import { defaultPaths, ZMX_COMMIT } from "./constants.mjs"
import { doctor } from "./doctor.mjs"
import { atomicSymlink, copyTree, currentRelease, pathExists, readJson, relativeTarget, removeTreeInside, run, sha256 } from "./lib.mjs"
import {
  activeSessions,
  assertBunVersion,
  assertMacOS,
  assertNodeVersion,
  ensureStateLayout,
  guardUpdate,
  initializeIdentity,
  activateHub,
  installZmx,
  readServeStateRecord,
  removeLegacyHubAgent,
  removeRubatoServeRoute,
  serveStatus,
  setupInstructions,
  tailscaleIdentity,
  terminalBridgeSmoke,
  writeHubService,
  writeServeStateRecord,
  zmxSmoke,
} from "./system.mjs"

export async function install(options) {
  assertMacOS()
  assertNodeVersion()
  const paths = options.paths ?? defaultPaths()
  const runner = options.runner ?? run
  const bunCommand = options.bun ?? "bun"
  await assertBunVersion(bunCommand, runner)
  const bunProbe = await runner("/usr/bin/which", [bunCommand], { check: false, timeoutMs: 2_000 })
  const bunPath = bunProbe.code === 0 ? bunProbe.stdout.trim() : bunCommand
  const releaseSource = resolve(options.release)
  const publicKey = options.publicKey ?? process.env.RUBATO_RELEASE_PUBLIC_KEY
  const manifest = await verifyRelease(releaseSource, { publicKeyPem: publicKey, requireSignature: !options.trustedLocalBuild })
  await ensureStateLayout(paths)
  await mkdir(paths.releases, { recursive: true, mode: 0o755 })
  const final = join(paths.releases, manifest.buildId)
  const stage = join(paths.releases, `.staging-${manifest.buildId}-${process.pid}`)
  if (await pathExists(final)) {
    const installed = await verifyRelease(final, { publicKeyPem: publicKey, requireSignature: !options.trustedLocalBuild })
    if (installed.sourceCommit !== manifest.sourceCommit) throw new Error("build id collision with a different source commit")
  } else {
    await rm(stage, { recursive: true, force: true })
    await copyTree(releaseSource, stage)
    await verifyRelease(stage, { publicKeyPem: publicKey, requireSignature: !options.trustedLocalBuild })
    await rename(stage, final)
  }

  const zmxHash = manifest.zmx?.sha256
  if (manifest.zmx?.commit !== ZMX_COMMIT || !/^[0-9a-f]{64}$/.test(zmxHash ?? "")) throw new Error("release does not pin the qualified zmx source and checksum")
  const tailscaleCommand = options.tailscale ?? "tailscale"
  const identity = await tailscaleIdentity(tailscaleCommand, runner)
  if (!identity.loggedIn) {
    return { installed: true, configured: false, buildId: manifest.buildId, instructions: setupInstructions(identity) }
  }
  const host = await initializeIdentity(paths, identity, { displayName: options.displayName })
  const launcherPath = join(resolve(options.repository ?? process.cwd()), "harness", "scripts", "rubato-pi.sh")
  if (!await pathExists(launcherPath)) throw new Error("Rubato base launcher is missing from the installation clone")
  const tailscaleProbe = await runner("/usr/bin/which", [tailscaleCommand], { check: false, timeoutMs: 2_000 })
  const tailscalePath = tailscaleProbe.code === 0 ? tailscaleProbe.stdout.trim() : tailscaleCommand
  const previous = await currentRelease(paths.current)
  const previousZmxHash = await pathExists(paths.zmx) ? await sha256(paths.zmx) : null
  const zmxBackup = previousZmxHash && previousZmxHash !== zmxHash ? `${paths.zmx}.rollback-${process.pid}` : null
  if (zmxBackup) await cp(paths.zmx, zmxBackup)
  try {
    await installZmx(join(final, "zmx"), paths.zmx, zmxHash)
  } catch (error) {
    if (zmxBackup) await rename(zmxBackup, paths.zmx).catch(() => {})
    throw error
  }
  await atomicSymlink(relativeTarget(final, paths.current), paths.current)
  const ensureEngine = options.ensureEngine ?? (() => ensureProfileEngineFrom(options.repository))
  const previousService = await readFile(paths.service, "utf8").catch(() => null)
  try {
    // The profile engine runs the hub; this hands it the new release and waits until it runs.
    await writeHubService(paths, manifest.buildId, bunPath, launcherPath, tailscalePath)
    await activateHub(paths, { runner, ensureEngine, ...(options.hubTimeouts ?? {}) })
    await saveBaseline(paths, runner)
    await configureCmux(options.repository, runner)
    if (!options.skipSmoke) {
      await zmxSmoke(paths.zmx, runner)
      await terminalBridgeSmoke(paths, bunPath, runner)
    }
    const url = `https://${identity.dnsName}/rubato/`
    await printQr(url, paths, runner, options.stdout ?? process.stdout)
    if (zmxBackup) await rm(zmxBackup, { force: true })
    return { installed: true, configured: true, buildId: manifest.buildId, url, instructions: setupInstructions(identity) }
  } catch (error) {
    if (zmxBackup) await rename(zmxBackup, paths.zmx).catch(() => {})
    else if (previousZmxHash === null) await rm(paths.zmx, { force: true })
    if (previous && await pathExists(previous)) {
      await atomicSymlink(relativeTarget(previous, paths.current), paths.current)
      const prior = await readJson(join(previous, "release.json"), null)
      if (prior?.buildId) {
        await writeHubService(paths, prior.buildId, bunPath, launcherPath, tailscalePath).catch(() => {})
        await activateHub(paths, { runner, ensureEngine, ...(options.hubTimeouts ?? {}) }).catch(() => {})
      }
    } else {
      // Nothing to go back to: without its spec the engine stops the hub it started.
      if (previousService === null) await rm(paths.service, { force: true })
      await rm(paths.current, { force: true })
    }
    throw error
  }
}

export async function update(options) {
  const paths = options.paths ?? defaultPaths()
  const runner = options.runner ?? run
  const sessions = await guardUpdate(paths, { forceLive: options.forceLive, runner })
  const previous = await currentRelease(paths.current)
  try {
    const result = await install({ ...options, paths, runner })
    return { ...result, previousBuildId: previous ? basename(previous) : null, liveSessionsPreserved: sessions.length }
  } catch (error) {
    if (previous && await pathExists(previous)) {
      await atomicSymlink(relativeTarget(previous, paths.current), paths.current)
      const metadata = await readJson(join(previous, "release.json"), null)
      if (metadata?.buildId) {
        const bunProbe = await runner("/usr/bin/which", [options.bun ?? "bun"], { check: false, timeoutMs: 2_000 })
        const launcherPath = join(resolve(options.repository ?? process.cwd()), "harness", "scripts", "rubato-pi.sh")
        const tailscaleProbe = await runner("/usr/bin/which", [options.tailscale ?? "tailscale"], { check: false, timeoutMs: 2_000 })
        await writeHubService(paths, metadata.buildId, bunProbe.stdout.trim() || options.bun || "bun", launcherPath, tailscaleProbe.stdout.trim() || options.tailscale || "tailscale").catch(() => {})
      }
    }
    throw error
  }
}

export async function uninstall(options) {
  const paths = options.paths ?? defaultPaths()
  const runner = options.runner ?? run
  if (!options.yes) throw new Error("uninstall requires --yes after reviewing the preserved-data summary")
  const pushProfile = join(paths.push, "profile.json")
  const hadPushProfile = await pathExists(pushProfile)
  const sessions = await activeSessions(paths, runner)
  if (sessions.length > 0 && !options.forceLive) throw new Error(`uninstall blocked by ${sessions.length} live session(s); end them or use --force-live to leave them running`)

  const host = await readJson(paths.host, null)
  const tailscale = options.tailscale ?? "tailscale"
  // Serve cleanup is fallible and externally visible. Keep the service and
  // LaunchAgent intact until scoped cleanup succeeds, so a retry remains safe.
  let status
  try { status = await serveStatus(tailscale, runner) }
  catch {
    const prior = await readServeStateRecord(paths)
    if (prior?.serveRoutes !== "absent") throw new Error("uninstall cannot inspect persisted /rubato Serve state while Tailscale is unavailable or logged out; reconnect or log in to Tailscale and retry. Offline uninstall is allowed only when a signed installer state proves Rubato Serve routes were already absent or removed")
  }
  if (status) {
    if (host?.httpPort) await removeRubatoServeRoute(tailscale, host.httpPort, join(paths.current, "web"), runner)
    else if (JSON.stringify(status).includes("/rubato")) throw new Error("uninstall found persisted /rubato Serve state but the signed Rubato host port is unavailable; restore the installation state and retry cleanup")
    await writeServeStateRecord(paths, "absent")
  }
  // Without its spec the engine stops the hub; an install from before engine supervision still
  // has the hub's own LaunchAgent, which goes too.
  await rm(paths.service, { force: true })
  await removeLegacyHubAgent(paths, runner)
  await waitForHubStop(paths)
  if (options.removeRegistry) {
    for (const name of ["host.json", "owner.json", "origins.json", "favorites.json"]) await rm(join(paths.state, name), { force: true })
  }
  if (options.removePush) await rm(pushProfile, { force: true })
  const zmxSessions = await activeSessions(paths, runner)
  if (zmxSessions.length === 0) await rm(paths.zmx, { force: true })
  await rm(paths.current, { force: true })
  if (await pathExists(paths.releases)) {
    for (const entry of await readdir(paths.releases, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      await removeTreeInside(join(paths.releases, entry.name), paths.releases)
    }
  }
  return {
    uninstalled: true,
    sessionsLeftRunning: sessions.length,
    pushProfileRevoked: options.removePush && hadPushProfile,
    browserUnsubscribeRequired: false,
    browserCleanupCompleted: true,
    browserCleanupInstructions: hadPushProfile ? "The self-built PWA is discontinued. Host push state was revoked; leftover browser subscriptions, if any, are inert." : null,
    registryRemovalIncludesBrowserCleanup: false,
    preserved: ["journal", "snapshots", "artifacts", "audit", "logs", "launch-env.enc", "serve-state.json", "installer-state signing key", ...(options.removeRegistry ? [] : ["host.json", "owner.json", "origins.json", "favorites.json"]), ...(options.removePush ? ["push-key-material"] : ["push"])],
  }
}

async function waitForHubStop(paths, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && await pathExists(paths.servicePid)) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
}

/** Starts the person's profile engine from the installation clone when none runs. */
async function ensureProfileEngineFrom(repository) {
  if (!repository) return
  const root = resolve(repository)
  const discovery = join(root, "harness", "pi-server", "src", "discovery.mjs")
  const launch = join(root, "harness", "rubato-pi", "src", "launch.mjs")
  if (!await pathExists(discovery) || !await pathExists(launch)) return
  const { ensureProfileEngine } = await import(pathToFileURL(discovery).href)
  const { resolveLaunchAgentDir } = await import(pathToFileURL(launch).href)
  await ensureProfileEngine({ descriptorPath: join(resolveLaunchAgentDir(), "server", "connection.json") })
}

async function saveBaseline(paths, runner) {
  const cli = join(paths.current, "live-cli", "bin", "rubato-live.mjs")
  await runner(process.execPath, [cli, "remote", "setup"], { timeoutMs: 30_000 })
  if (!await pathExists(paths.baseline)) throw new Error("baseline environment was not encrypted to disk")
}

async function configureCmux(repository, runner) {
  if (!repository) return { configured: false, reason: "repository path not supplied" }
  const script = join(resolve(repository), "harness", "scripts", "cmux-vault.mjs")
  if (!await pathExists(script)) throw new Error("cmux Vault configurator is missing")
  await runner(process.execPath, [script, "--apply"], { timeoutMs: 30_000 })
  await runner(process.execPath, [script, "--check"], { timeoutMs: 10_000 })
  return { configured: true }
}

async function printQr(url, paths, runner, stdout) {
  const png = join(paths.pair, "rubato-remote-qr.png")
  await runner("/usr/bin/swift", [join(import.meta.dirname, "qr.swift"), url, png], { timeoutMs: 30_000 })
  await chmod(png, 0o600)
  stdout.write(`Pairing QR: ${png}\n`)
  const probe = await runner("/usr/bin/which", ["qrencode"], { check: false, timeoutMs: 2_000 })
  if (probe.code === 0) {
    const qr = await runner(probe.stdout.trim(), ["-t", "ANSIUTF8", url], { timeoutMs: 5_000 })
    stdout.write(qr.stdout)
  } else stdout.write(`QR payload: ${url}\n`)
}

function parse(args) {
  const command = args.shift()
  const sourceRoot = resolve(import.meta.dirname, "..", "..")
  const options = { repository: process.env.RUBATO_REPOSITORY ? resolve(process.env.RUBATO_REPOSITORY) : existsSync(join(sourceRoot, "package.json")) ? sourceRoot : process.cwd() }
  while (args.length) {
    const arg = args.shift()
    if (arg === "--release") options.release = args.shift()
    else if (arg === "--public-key") options.publicKey = readFile(resolve(args.shift()), "utf8")
    else if (arg === "--trusted-local-build") options.trustedLocalBuild = true
    else if (arg === "--force-live") options.forceLive = true
    else if (arg === "--yes") options.yes = true
    else if (arg === "--remove-registry") options.removeRegistry = true
    else if (arg === "--remove-push") options.removePush = true
    else if (arg === "--skip-smoke") options.skipSmoke = true
    else if (arg === "--repository") options.repository = resolve(args.shift())
    else if (arg === "--display-name") options.displayName = args.shift()
    else if (arg === "--json") options.json = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return { command, options }
}

async function main() {
  const { command, options } = parse(process.argv.slice(2))
  if (options.publicKey instanceof Promise) options.publicKey = await options.publicKey
  let result
  if (command === "install") {
    if (!options.release) throw new Error("install requires --release <verified release directory>")
    result = await install(options)
  } else if (command === "update") {
    if (!options.release) throw new Error("update requires --release <verified release directory>")
    result = await update(options)
  } else if (command === "uninstall") result = await uninstall(options)
  else if (command === "guard-update") result = { safe: true, liveSessions: (await guardUpdate(defaultPaths(), { forceLive: false, runner: run })).length }
  else if (command === "verify") {
    if (!options.release) throw new Error("verify requires --release <release directory>")
    result = await verifyRelease(resolve(options.release), { publicKeyPem: options.publicKey ?? process.env.RUBATO_RELEASE_PUBLIC_KEY, requireSignature: !options.trustedLocalBuild })
  } else if (command === "doctor") {
    result = await doctor(defaultPaths(), options)
    if (!result.ok) process.exitCode = 1
  } else throw new Error("usage: remote-release.mjs <install|update|guard-update|uninstall|doctor|verify> [options]")
  process.stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => { console.error(`rubato-remote: ${error.message}`); process.exitCode = 1 })
}
