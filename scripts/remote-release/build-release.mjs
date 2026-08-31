#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"

import { createReleaseManifest, signReleaseManifest, verifyRelease } from "./artifact.mjs"
import { verifyZmxReleaseAsset } from "./build-zmx-release.mjs"
import { ZMX_COMMIT } from "./constants.mjs"
import { copyTree, readJson, run, sha256 } from "./lib.mjs"
import { assertBunVersion, assertMacOS, assertNodeVersion } from "./system.mjs"

export async function buildRelease(options) {
  const repository = resolve(options.repository ?? join(import.meta.dirname, "..", ".."))
  const output = resolve(options.output)
  const zmxAsset = resolve(options.zmxAsset)
  assertMacOS()
  const nodeVersion = assertNodeVersion()
  const bunVersion = await assertBunVersion(options.bun ?? "bun", options.runner ?? run)
  const runner = options.runner ?? run
  const lock = options.zmxLock ?? await readJson(join(repository, "third_party", "zmx-lock.json"))
  const zmx = await verifyBuiltZmx(zmxAsset, lock, runner)
  if (options.zmxManifestDirectory) await verifyZmxReleaseAsset(options.zmxManifestDirectory, zmxAsset, options.publicKey)
  const sourceCommit = (await runner("/usr/bin/git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()
  const dirty = (await runner("/usr/bin/git", ["-C", repository, "status", "--porcelain", "--untracked-files=no"])).stdout.trim()
  if (dirty && !options.allowDirty) throw new Error("release source has tracked modifications")
  const buildId = options.buildId ?? `${sourceCommit.slice(0, 12)}-${process.arch}`
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(buildId)) throw new Error("invalid build id")

  if (!options.skipChecks) {
    const checks = [
      [options.bun ?? "bun", ["install", "--frozen-lockfile"], 10 * 60_000],
      [process.execPath, ["harness/scripts/build-engine.mjs", "--force"], 5 * 60_000],
      [process.execPath, ["harness/scripts/build-engine.mjs", "--check"], 2 * 60_000],
      [options.bun ?? "bun", ["test", "patch-tests"], 10 * 60_000],
      ["npm", ["--prefix", "packages/rubato-remote-hub", "run", "build"], 5 * 60_000],
      ["npm", ["--prefix", "packages/rubato-remote-web", "run", "build"], 10 * 60_000],
      ["npm", ["--prefix", "packages/rubato-live-cli", "run", "check"], 2 * 60_000],
      [options.bun ?? "bun", ["test", "packages/rubato-terminal-bridge/test"], 5 * 60_000],
      [options.bun ?? "bun", ["audit", "--production"], 5 * 60_000],
      [process.execPath, ["scripts/license-policy.mjs"], 5 * 60_000],
      [process.execPath, ["scripts/check-third-party-notices.mjs"], 2 * 60_000],
    ]
    for (const [file, args, timeoutMs] of checks) await runner(file, args, { cwd: repository, timeoutMs })
  }

  await rm(output, { recursive: true, force: true })
  await mkdir(join(output, "hub"), { recursive: true, mode: 0o755 })
  await buildHubBundle({ repository, output, runner })
  const esbuild = join(repository, "packages", "rubato-remote-hub", "node_modules", ".bin", "esbuild")
  await mkdir(join(output, "protocol"), { recursive: true, mode: 0o755 })
  await runner(esbuild, [
    join(repository, "packages", "rubato-remote-protocol", "src", "index.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node24",
    `--outfile=${join(output, "protocol", "index.mjs")}`,
  ], { cwd: repository, timeoutMs: 2 * 60_000 })
  await runner(esbuild, [
    join(repository, "packages", "rubato-terminal-bridge", "src", "bun-helper.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node24",
    `--outfile=${join(output, "hub", "bun-helper.ts")}`,
  ], { cwd: repository, timeoutMs: 2 * 60_000 })
  const terminalModules = join(output, "node_modules")
  await mkdir(terminalModules, { recursive: true })
  await cp(join(repository, "packages", "rubato-terminal-bridge", "node_modules", "node-pty"), join(terminalModules, "node-pty"), { recursive: true, dereference: true })
  await cp(join(repository, "packages", "rubato-live-cli", "node_modules", "qrcode-terminal"), join(terminalModules, "qrcode-terminal"), { recursive: true, dereference: true })
  await copyTree(join(repository, "packages", "rubato-remote-web", "dist"), join(output, "web"))
  await copyTree(join(repository, "packages", "rubato-live-cli"), join(output, "live-cli"), (source) => !source.includes(`${join("live-cli", "test")}`) && !source.includes("node_modules"))
  await copyTree(join(repository, "scripts", "remote-release"), join(output, "remote-release"), (source) => !source.includes("fixtures") && !source.endsWith(".test.mjs") && !source.endsWith("VERIFICATION.md"))
  await copyTree(join(repository, "packages", "rubato-remote-protocol", "src"), join(output, "remote-protocol", "src"))
  await cp(join(repository, "packages", "rubato-remote-protocol", "package.json"), join(output, "remote-protocol", "package.json"))
  await cp(zmxAsset, join(output, "zmx"))
  await chmod(join(output, "zmx"), 0o755)
  await cp(join(repository, "THIRD-PARTY-NOTICES.md"), join(output, "THIRD-PARTY-NOTICES.md"))
  await copyTree(join(repository, "third_party"), join(output, "third_party"))
  if (options.zmxManifestDirectory) {
    const qualification = join(output, "third_party", "zmx-release")
    await mkdir(qualification, { recursive: true })
    for (const file of ["zmx-release-manifest.json", "zmx-release-manifest.sig", "zmx-smoke-report.json"]) {
      await cp(join(options.zmxManifestDirectory, file), join(qualification, file))
    }
  }

  // The live CLI imports the protocol source through its workspace-relative path.
  await mkdir(join(output, "packages"), { recursive: true })
  await copyTree(join(output, "remote-protocol"), join(output, "packages", "rubato-remote-protocol"))
  await rewriteLiveCliProtocolImport(output)

  const bin = join(output, "bin")
  await mkdir(bin, { recursive: true })
  await executable(join(bin, "rubato-live"), `#!/bin/sh\nexec '${process.execPath}' "$(dirname "$0")/../live-cli/bin/rubato-live.mjs" "$@"\n`)
  await executable(join(bin, "rubato-live-bootstrap"), `#!/bin/sh\nexec '${process.execPath}' "$(dirname "$0")/../live-cli/bin/rubato-live.mjs" internal-run --descriptor "$1"\n`)
  const metadata = { buildId, sourceCommit, createdAt: new Date().toISOString(), node: nodeVersion, bun: bunVersion, zmx: { commit: ZMX_COMMIT, version: zmx.version, asset: basename(zmxAsset), sha256: zmx.sha256 } }
  await writeFile(join(output, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  await createReleaseManifest(output, metadata)
  if (options.signingKey) await signReleaseManifest(output, options.signingKey)
  await verifyRelease(output, { publicKeyPem: options.publicKey, requireSignature: Boolean(options.publicKey) })
  return metadata
}

export async function buildHubBundle({ repository, output, runner = run }) {
  const esbuild = join(repository, "packages", "rubato-remote-hub", "node_modules", ".bin", "esbuild")
  const main = join(output, "hub", "main.mjs")
  await mkdir(dirname(main), { recursive: true, mode: 0o755 })
  await runner(esbuild, [
    join(repository, "packages", "rubato-remote-hub", "src", "main.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node24",
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    `--outfile=${main}`,
  ], { cwd: repository, timeoutMs: 2 * 60_000 })
}

export async function verifyBuiltZmx(path, lock, runner = run) {
  if (lock.schemaVersion !== 2 || lock.commit !== ZMX_COMMIT || lock.baseRelease !== "0.7.1" || lock.binaryVersion !== "0.7.0" || lock.qualifiedAssets?.status !== "release-manifest-required") {
    throw new Error("zmx source lock is not the truthful schema-v2 pin")
  }
  const file = await runner("/usr/bin/file", [path])
  const expectedArch = process.arch === "arm64" ? "arm64" : "x86_64"
  if (!file.stdout.includes("Mach-O 64-bit executable") || !file.stdout.includes(expectedArch)) throw new Error(`zmx asset architecture does not match ${expectedArch}`)
  const version = await runner(path, ["version"])
  const match = /^zmx\s+([0-9]+\.[0-9]+\.[0-9]+)$/m.exec(version.stdout)
  if (!match || match[1] !== lock.binaryVersion) throw new Error(`zmx embedded version does not match source lock: ${match?.[1] ?? "unknown"}`)
  return { version: match[1], sha256: await sha256(path) }
}

async function rewriteLiveCliProtocolImport(output) {
  const path = join(output, "live-cli", "src", "identifiers.mjs")
  const value = await readFile(path, "utf8")
  const expected = 'from "../../rubato-remote-protocol/src/identifiers.ts";'
  if (!value.includes(expected)) throw new Error("live CLI protocol import layout changed")
  await writeFile(path, value.replace(expected, 'from "../../remote-protocol/src/identifiers.ts";'))
}

async function executable(path, content) {
  await writeFile(path, content, { mode: 0o755 })
  await chmod(path, 0o755)
}

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--output") options.output = args[++index]
    else if (arg === "--zmx-asset") options.zmxAsset = args[++index]
    else if (arg === "--repository") options.repository = args[++index]
    else if (arg === "--zmx-manifest-directory") options.zmxManifestDirectory = resolve(args[++index])
    else if (arg === "--build-id") options.buildId = args[++index]
    else if (arg === "--allow-dirty") options.allowDirty = true
    else if (arg === "--skip-checks") options.skipChecks = true
    else throw new Error(`unknown option: ${arg}`)
  }
  if (!options.output || !options.zmxAsset) throw new Error("usage: build-release.mjs --output <directory> --zmx-asset <path> [--build-id <id>]")
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    options.signingKey = process.env.RUBATO_RELEASE_SIGNING_KEY
    options.publicKey = process.env.RUBATO_RELEASE_PUBLIC_KEY
    const metadata = await buildRelease(options)
    console.log(JSON.stringify(metadata))
  } catch (error) {
    console.error(`build-release: ${error.message}`)
    process.exitCode = 1
  }
}
