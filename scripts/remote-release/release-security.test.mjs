import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createReleaseManifest, signReleaseManifest, verifyRelease } from "./artifact.mjs"
import { defaultPaths, ZMX_COMMIT } from "./constants.mjs"
import { atomicSymlink, pathExists, redact, removeTreeInside, sha256 } from "./lib.mjs"
import { install, uninstall } from "./remote-release.mjs"
import { createMockDriver, qualify } from "./qualification.mjs"
import { assertBunVersion, assertNoFunnel, configureServe, guardUpdate, renderLaunchAgent, serveHasRubatoTarget, withoutRubatoServeRoute, writeServeStateRecord } from "./system.mjs"

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "rubato-release-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function signedRelease(t) {
  const root = await temporary(t)
  await mkdir(join(root, "bin"))
  await writeFile(join(root, "bin", "hub"), "release payload", { mode: 0o755 })
  await writeFile(join(root, "zmx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const metadata = { buildId: "test-arm64", sourceCommit: "a".repeat(40), node: "24.1.0", bun: "1.4.0", zmx: { commit: ZMX_COMMIT, sha256: await sha256(join(root, "zmx")) } }
  await createReleaseManifest(root, metadata)
  const pair = generateKeyPairSync("ed25519")
  await signReleaseManifest(root, pair.privateKey.export({ type: "pkcs8", format: "pem" }))
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" })
  return { root, publicKey }
}

test("signed release verification rejects payload tampering and extra files", async (t) => {
  const first = await signedRelease(t)
  assert.equal((await verifyRelease(first.root, { publicKeyPem: first.publicKey, requireSignature: true })).buildId, "test-arm64")
  await writeFile(join(first.root, "bin", "hub"), "tampered", { mode: 0o755 })
  await assert.rejects(verifyRelease(first.root, { publicKeyPem: first.publicKey, requireSignature: true }), /checksum mismatch/)

  const second = await signedRelease(t)
  await writeFile(join(second.root, "unmanifested"), "surprise")
  await assert.rejects(verifyRelease(second.root, { publicKeyPem: second.publicKey, requireSignature: true }), /file set differs|unmanifested/)
})

test("trusted local install atomically stages assets and defers setup without Tailscale login", async (t) => {
  const release = await signedRelease(t)
  const home = await temporary(t)
  const paths = defaultPaths(home, 501)
  const runner = async (file, args) => {
    if (file === "bun" && args[0] === "--version") return { code: 0, stdout: "1.4.0\n", stderr: "" }
    if (file === "/usr/bin/which") return { code: 0, stdout: "/Users/test/.bun/bin/bun\n", stderr: "" }
    if (args[0] === "status") return { code: 1, stdout: "", stderr: "not logged in" }
    throw new Error(`unexpected command: ${args.join(" ")}`)
  }
  const result = await install({ release: release.root, publicKey: release.publicKey, paths, runner })
  assert.equal(result.configured, false)
  assert.equal(await pathExists(join(paths.releases, "test-arm64", "release-manifest.json")), true)
  assert.equal(await pathExists(paths.zmx), false, "an unconfigured release must not replace process assets")
  assert.equal(await pathExists(paths.current), false, "an unconfigured release must not become current")
})

test("isolated uninstall revokes host Push state without touching global launchd or user prefixes", async (t) => {
  const home = await temporary(t)
  const paths = defaultPaths(home, 501)
  await mkdir(paths.push, { recursive: true, mode: 0o700 })
  await mkdir(join(paths.releases, "old"), { recursive: true })
  await writeFile(join(paths.push, "profile.json"), JSON.stringify({ endpoint: "private" }), { mode: 0o600 })
  await writeServeStateRecord(paths, "absent")
  const calls = []
  const runner = async (file, args) => {
    calls.push([file, ...args])
    if (file === "/bin/launchctl") return { code: 0, stdout: "", stderr: "" }
    if (args[0] === "status") return { code: 1, stdout: "", stderr: "disabled in isolated test" }
    throw new Error(`unexpected isolated command: ${file} ${args.join(" ")}`)
  }
  const result = await uninstall({ paths, runner, yes: true, removePush: true })
  assert.equal(result.pushProfileRevoked, true)
  assert.equal(result.browserUnsubscribeRequired, true)
  assert.equal(result.browserCleanupCompleted, false)
  assert.match(result.browserCleanupInstructions, /paired PWA.*PushSubscription\.unsubscribe/)
  assert.equal(result.registryRemovalIncludesBrowserCleanup, false)
  assert.equal(await pathExists(join(paths.push, "profile.json")), false)
  assert.equal(calls.some(([file]) => file === "/bin/launchctl"), true)
  assert.equal(calls.every((call) => !call.join(" ").includes(process.env.HOME)), true)
})

test("uninstall fails transactionally when Tailscale Serve state is unavailable", async (t) => {
  const home = await temporary(t)
  const paths = defaultPaths(home, 501)
  await mkdir(join(paths.current, "web"), { recursive: true })
  await mkdir(join(paths.plist, ".."), { recursive: true })
  await writeFile(paths.plist, "launch agent")
  await mkdir(paths.state, { recursive: true })
  await writeFile(paths.host, JSON.stringify({ httpPort: 7314 }))
  let launchctlCalled = false
  const runner = async (file, args) => {
    if (file === "/bin/launchctl") { launchctlCalled = true; return { code: 0, stdout: "", stderr: "" } }
    if (args.join(" ") === "serve status --json") return { code: 127, stdout: "", stderr: "tailscale unavailable" }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`)
  }
  await assert.rejects(() => uninstall({ paths, runner, yes: true }), /cannot inspect persisted \/rubato Serve state.*reconnect or log in.*retry/)
  assert.equal(await pathExists(paths.plist), true)
  assert.equal(await pathExists(paths.current), true)
  assert.equal(launchctlCalled, false)
})

test("uninstall fails transactionally when Tailscale is logged out unless signed state proves routes absent", async (t) => {
  const home = await temporary(t)
  const paths = defaultPaths(home, 501)
  await mkdir(join(paths.plist, ".."), { recursive: true })
  await writeFile(paths.plist, "launch agent")
  const runner = async (file, args) => {
    if (file === "/bin/launchctl") return { code: 0, stdout: "", stderr: "" }
    if (args.join(" ") === "serve status --json") return { code: 1, stdout: "", stderr: "Logged out." }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`)
  }
  await assert.rejects(() => uninstall({ paths, runner, yes: true }), /cannot inspect persisted \/rubato Serve state/)
  assert.equal(await pathExists(paths.plist), true)
  await writeServeStateRecord(paths, "absent")
  const tampered = JSON.parse(await readFile(paths.serveState, "utf8"))
  tampered.payload.serveRoutes = "present"
  await writeFile(paths.serveState, JSON.stringify(tampered))
  await assert.rejects(() => uninstall({ paths, runner, yes: true }), /cannot inspect persisted \/rubato Serve state/)
  assert.equal(await pathExists(paths.plist), true)
  await writeServeStateRecord(paths, "absent")
  const result = await uninstall({ paths, runner, yes: true })
  assert.equal(result.uninstalled, true)
  assert.equal(await pathExists(paths.plist), false)
})

test("uninstall leaves LaunchAgent and service intact when scoped Serve cleanup fails", async (t) => {
  const home = await temporary(t)
  const paths = defaultPaths(home, 501)
  await mkdir(join(paths.current, "web"), { recursive: true })
  await mkdir(join(paths.plist, ".."), { recursive: true })
  await writeFile(paths.plist, "launch agent")
  await mkdir(paths.state, { recursive: true })
  await writeFile(paths.host, JSON.stringify({ httpPort: 7314 }))
  let launchctlCalled = false
  const runner = async (file, args) => {
    if (file === "/bin/launchctl") { launchctlCalled = true; return { code: 0, stdout: "", stderr: "" } }
    if (args.join(" ") === "status --json") return { code: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { Online: true, UserID: 1, DNSName: "mac.ts.net." }, User: { "1": { LoginName: "owner@example.com" } } }), stderr: "" }
    if (args.join(" ") === "serve status --json") return { code: 0, stdout: JSON.stringify({ Web: { "host:443": { Handlers: { "/rubato/api": { Proxy: "http://127.0.0.1:7314/rubato/api" } } } } }), stderr: "" }
    if (args[0] === "serve" && args[1] === "get-config") throw new Error("injected Serve cleanup failure")
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`)
  }
  await assert.rejects(() => uninstall({ paths, runner, yes: true }), /injected Serve cleanup failure/)
  assert.equal(await pathExists(paths.plist), true)
  assert.equal(launchctlCalled, false)
})

test("release manifests reject symlinks and traversal-shaped payloads", async (t) => {
  const root = await temporary(t)
  await writeFile(join(root, "outside"), "secret")
  await mkdir(join(root, "release"))
  await symlink(join(root, "outside"), join(root, "release", "escape"))
  await assert.rejects(createReleaseManifest(join(root, "release"), { buildId: "bad" }), /symlink/)
})

test("atomic current switch never creates a recursive deletion boundary", async (t) => {
  const root = await temporary(t)
  const releases = join(root, "releases")
  const one = join(releases, "one")
  const two = join(releases, "two")
  await mkdir(one, { recursive: true })
  await mkdir(two)
  const current = join(root, "current")
  await atomicSymlink("releases/one", current)
  await atomicSymlink("releases/two", current)
  assert.equal(await readlink(current), "releases/two")
  await assert.rejects(removeTreeInside(root, releases), /outside managed root/)
})

test("update guard lists active sessions and requires the explicit force switch", async () => {
  const paths = { socket: "/missing", current: "/missing", zmx: "/bin/sh" }
  const runner = async (_file, args) => args[0] === "list" ? { code: 0, stdout: "rubato-0123456789ab\nunrelated\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }
  await assert.rejects(guardUpdate(paths, { runner }), /update blocked.*rubato-0123456789ab/)
  assert.equal((await guardUpdate(paths, { runner, forceLive: true })).length, 1)
})

test("launchd and Serve checks retain argv boundaries, localhost, scoped path, and no shell", () => {
  const plist = renderLaunchAgent({ nodePath: "/node 24/bin/node", bunPath: "/Users/a/.bun/bin/bun", tailscalePath: "/usr/local/bin/tailscale", entryPath: "/release & one/main.mjs", bootstrapPath: "/release/bin/bootstrap", launcherPath: "/clone/harness/rubato-pi.sh", zmxPath: "/Users/a/.local/lib/rubato/bin/zmx", stdoutPath: "/tmp/out", stderrPath: "/tmp/err", home: "/Users/a", buildId: "build-1" })
  assert.match(plist, /<string>\/node 24\/bin\/node<\/string>/)
  assert.match(plist, /release &amp; one/)
  assert.doesNotMatch(plist, /\/bin\/sh/)
  assert.equal(serveHasRubatoTarget({ Web: { "host:443": { Handlers: { "/rubato": { Proxy: "http://127.0.0.1:7314" } } } } }, 7314), true)
  assert.equal(serveHasRubatoTarget({ Web: { "/": "http://0.0.0.0:7314" } }, 7314), false)
})

test("selective Serve removal preserves unrelated routes, listeners, and same-name routes owned by others", async () => {
  const fixture = JSON.parse(await readFile(join(import.meta.dirname, "fixtures", "tailscale-serve-multiple-routes.json"), "utf8"))
  const webRoot = "/Users/test/.local/lib/rubato/remote/current/web"
  const { config, removed } = withoutRubatoServeRoute(fixture, 7314, webRoot)
  assert.equal(removed, true)
  assert.equal(config.Web["mac.example.ts.net:443"].Handlers["/rubato"], undefined)
  assert.equal(config.Web["mac.example.ts.net:443"].Handlers["/rubato/api"], undefined)
  assert.deepEqual(config.Web["mac.example.ts.net:443"].Handlers["/"], { Text: "personal home" })
  assert.deepEqual(config.Web["mac.example.ts.net:443"].Handlers["/docs"], { Proxy: "http://127.0.0.1:9000" })
  assert.deepEqual(config.Web["other.example.ts.net:8443"], fixture.Web["other.example.ts.net:8443"])
  assert.deepEqual(config.TCP, fixture.TCP)
  assert.deepEqual(config.AllowFunnel, fixture.AllowFunnel)
  assert.deepEqual(fixture.Web["mac.example.ts.net:443"].Handlers["/rubato"], { Path: webRoot }, "input fixture must not be mutated")
})

test("Serve setup refuses unrelated /rubato ownership before mutation", async (t) => {
  const root = await temporary(t)
  const web = join(root, "web"); await mkdir(web)
  const existing = { Web: { "host:443": { Handlers: { "/rubato": { Proxy: "http://127.0.0.1:9999" } } } } }
  const calls = []
  const runner = async (_file, args) => {
    calls.push(args)
    if (args.join(" ") === "serve status --json") return { code: 0, stdout: JSON.stringify(existing), stderr: "" }
    if (args[0] === "serve" && args[1] === "get-config") { await writeFile(args[2], JSON.stringify(existing)); return { code: 0, stdout: "", stderr: "" } }
    throw new Error(`unexpected mutation: ${args.join(" ")}`)
  }
  await assert.rejects(() => configureServe("tailscale", 7314, web, runner), /refusing to overwrite/)
  assert.equal(calls.some((args) => args.some((arg) => String(arg).startsWith("--set-path"))), false)
})

test("Serve setup restores the exact snapshot when the API route command fails", async (t) => {
  const root = await temporary(t)
  const web = join(root, "web"); await mkdir(web)
  const before = { Web: { "host:443": { Handlers: { "/docs": { Proxy: "http://127.0.0.1:9000" } } } }, TCP: { "22": { TCPForward: "127.0.0.1:22" } } }
  let current = structuredClone(before)
  let restored = null
  const runner = async (_file, args) => {
    if (args.join(" ") === "serve status --json") return { code: 0, stdout: JSON.stringify(current), stderr: "" }
    if (args[0] === "serve" && args[1] === "get-config") { await writeFile(args[2], JSON.stringify(before)); return { code: 0, stdout: "", stderr: "" } }
    if (args.some((arg) => String(arg) === "--set-path=/rubato")) { current.Web["host:443"].Handlers["/rubato"] = { Path: web }; return { code: 0, stdout: "", stderr: "" } }
    if (args.some((arg) => String(arg) === "--set-path=/rubato/api")) throw new Error("injected second command failure")
    if (args[0] === "serve" && args[1] === "set-config") { restored = JSON.parse(await readFile(args[2], "utf8")); current = structuredClone(restored); return { code: 0, stdout: "", stderr: "" } }
    throw new Error(`unexpected command: ${args.join(" ")}`)
  }
  await assert.rejects(() => configureServe("tailscale", 7314, web, runner), /injected second command failure/)
  assert.deepEqual(restored, before)
  assert.deepEqual(current, before)
})

test("empty Funnel policy is allowed but any enabled Funnel target fails closed", () => {
  assert.doesNotThrow(() => assertNoFunnel({ AllowFunnel: {} }))
  assert.throws(() => assertNoFunnel({ AllowFunnel: { "host:443": true } }), /Funnel is forbidden/)
})

test("selective Serve removal refuses to claim an unrelated /rubato proxy", () => {
  const input = { Web: { "host:443": { Handlers: { "/rubato": { Proxy: "http://127.0.0.1:9999" } } } } }
  assert.deepEqual(withoutRubatoServeRoute(input, 7314, "/owned/web"), { config: input, removed: false })
})

test("secret redaction is recursive and covers tokens without echoing values", () => {
  const output = JSON.stringify(redact({ authorization: "Bearer top-secret", nested: { value: "tskey-auth-k3y", privateKey: "nope" } }))
  assert.doesNotMatch(output, /top-secret|tskey-auth-k3y|nope/)
  assert.match(output, /REDACTED/)
})

test("security-fixed Hono versions are exact at root and hub with reviewed advisory evidence", async () => {
  const repository = join(import.meta.dirname, "..", "..")
  const rootPackage = JSON.parse(await readFile(join(repository, "package.json"), "utf8"))
  const hubPackage = JSON.parse(await readFile(join(repository, "packages", "rubato-remote-hub", "package.json"), "utf8"))
  assert.equal(rootPackage.overrides.hono, "4.13.5")
  assert.equal(rootPackage.overrides["@hono/node-server"], "1.19.17")
  assert.equal(hubPackage.dependencies.hono, "4.13.5")
  assert.equal(hubPackage.dependencies["@hono/node-server"], "1.19.17")
  const hubLock = JSON.parse(await readFile(join(repository, "packages", "rubato-remote-hub", "package-lock.json"), "utf8"))
  assert.equal(hubLock.packages[""].dependencies.hono, "4.13.5")
  assert.equal(hubLock.packages[""].dependencies["@hono/node-server"], "1.19.17")
  assert.equal(hubLock.packages[""].dependencies["@rubato/terminal-bridge"], "file:../rubato-terminal-bridge")
  assert.equal(hubLock.packages["node_modules/hono"].version, "4.13.5")
  assert.equal(hubLock.packages["node_modules/@hono/node-server"].version, "1.19.17")
  assert.equal(hubLock.packages["../rubato-terminal-bridge"].name, "@rubato/terminal-bridge")
  const evidence = await readFile(join(repository, "third_party", "hono-security-deviation.md"), "utf8")
  assert.match(evidence, /GHSA-88fw-hqm2-52qc/)
  assert.match(evidence, /GHSA-frvp-7c67-39w9/)
  assert.match(evidence, /bun audit --production/)
})

test("Bun support is an exact pin rather than a minimum", async () => {
  await assert.rejects(assertBunVersion("bun", async () => ({ code: 0, stdout: "1.4.1\n", stderr: "" })), /Bun 1.4.0 is required/)
  assert.equal(await assertBunVersion("bun", async () => ({ code: 0, stdout: "1.4.0\n", stderr: "" })), "1.4.0")
})

test("short qualification profile exercises every long-run counter", async () => {
  const report = await qualify({ profile: "ci", driver: createMockDriver() })
  assert.deepEqual(Object.keys(report.counters).sort(), ["attaches", "durationSeconds", "events", "foregroundCycles", "hubRestarts", "messages", "networkCycles", "reconnects", "toolOutputBytes"].sort())
  assert.equal(report.counters.toolOutputBytes, 1024 * 1024)
})
