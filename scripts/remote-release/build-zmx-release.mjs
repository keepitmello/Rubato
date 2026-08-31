#!/usr/bin/env node
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import { readJson, run, sha256 } from "./lib.mjs"

export async function buildZmxRelease(options) {
  const repository = resolve(options.repository ?? join(import.meta.dirname, "..", ".."))
  const output = resolve(options.output)
  const work = resolve(options.work ?? `${output}.work`)
  const runner = options.runner ?? run
  const lock = await readJson(join(repository, "third_party", "zmx-lock.json"))
  validateSourceLock(lock)
  const zig = (await runner(options.zig ?? "zig", ["version"])).stdout.trim()
  if (zig !== "0.16.0") throw new Error(`zmx release requires exactly Zig 0.16.0; found ${zig}`)
  await rm(output, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  await mkdir(work, { recursive: true })
  const source = join(work, "source")
  await runner("/usr/bin/git", ["clone", "--filter=blob:none", lock.repository, source], { timeoutMs: 2 * 60_000 })
  await runner("/usr/bin/git", ["-C", source, "checkout", "--detach", lock.commit])
  const commit = (await runner("/usr/bin/git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim()
  const tree = (await runner("/usr/bin/git", ["-C", source, "rev-parse", "HEAD^{tree}"])).stdout.trim()
  const describe = (await runner("/usr/bin/git", ["-C", source, "describe", "--tags", "--always"])).stdout.trim()
  if (commit !== lock.commit || tree !== lock.tree || describe !== lock.describe) throw new Error("zmx checkout provenance differs from source lock")

  const selected = options.platform ? { [options.platform]: lock.build.targets[options.platform] } : lock.build.targets
  if (Object.values(selected).some((value) => typeof value !== "string")) throw new Error("unknown zmx platform")
  const assets = []
  for (const [platform, target] of Object.entries(selected)) {
    const prefix = join(work, `prefix-${platform}`)
    const cache = join(work, `cache-${platform}`)
    await runner(options.zig ?? "zig", ["build", `-Dtarget=${target}`, `-Doptimize=${lock.build.optimize}`, "--prefix", prefix, "--cache-dir", cache], { cwd: source, timeoutMs: 15 * 60_000 })
    const sourceAsset = join(prefix, "bin", "zmx")
    const asset = join(output, `zmx-${platform}`)
    await cp(sourceAsset, asset)
    await chmod(asset, 0o755)
    const versionResult = await runAssetVersion(asset, platform, runner)
    const version = /^zmx\s+([^\s]+)$/m.exec(versionResult.stdout)?.[1]
    if (version !== lock.binaryVersion) throw new Error(`${platform} reports zmx ${version ?? "unknown"}; expected embedded version ${lock.binaryVersion}`)
    const info = await stat(asset)
    assets.push({ platform, target, file: basename(asset), bytes: info.size, sha256: await sha256(asset), version })
  }
  const manifest = {
    schemaVersion: 1,
    source: { repository: lock.repository, commit, tree, describe, baseRelease: lock.baseRelease, baseReleaseCommit: lock.baseReleaseCommit, releaseLineRelation: lock.releaseLineRelation, binaryVersion: lock.binaryVersion },
    build: { zigVersion: zig, optimize: lock.build.optimize },
    createdAt: new Date().toISOString(),
    assets: assets.sort((left, right) => left.platform.localeCompare(right.platform)),
    license: lock.license,
  }
  const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(output, lock.qualifiedAssets.manifest), encoded)
  if (options.signingKey) {
    const signature = cryptoSign(null, encoded, options.signingKey)
    await writeFile(join(output, lock.qualifiedAssets.signature), `${signature.toString("base64")}\n`)
    if (options.publicKey && !cryptoVerify(null, encoded, createPublicKey(options.publicKey), signature)) throw new Error("zmx release signature self-verification failed")
  } else if (options.requireSignature) throw new Error("RUBATO_RELEASE_SIGNING_KEY is required")
  await cp(join(repository, "third_party", lock.license.path), join(output, "LICENSE.zmx"))
  return manifest
}

export async function verifyZmxReleaseAsset(directory, asset, publicKey) {
  const lock = await readJson(join(resolve(directory), "zmx-release-manifest.json"))
  const encoded = await readFile(join(resolve(directory), "zmx-release-manifest.json"))
  const signature = Buffer.from((await readFile(join(resolve(directory), "zmx-release-manifest.sig"), "utf8")).trim(), "base64")
  const verificationKey = typeof publicKey === "string" || Buffer.isBuffer(publicKey) ? createPublicKey(publicKey) : publicKey
  if (!verificationKey || !cryptoVerify(null, encoded, verificationKey, signature)) throw new Error("invalid zmx release manifest signature")
  if (lock.schemaVersion !== 1 || lock.source?.commit !== "0266042ca8f399c9d76825739b93443e2d5bf47a" || lock.source?.baseRelease !== "0.7.1" || lock.source?.baseReleaseCommit !== "1cea103fef83cd53586fcb2c5f90d693fc9f5a30" || lock.source?.releaseLineRelation !== "diverged-not-ancestor" || lock.source?.binaryVersion !== "0.7.0" || lock.build?.zigVersion !== "0.16.0" || lock.build?.optimize !== "ReleaseSafe") throw new Error("signed zmx release manifest differs from the source/build policy")
  const entry = lock.assets.find((candidate) => candidate.file === basename(asset))
  if (!entry || entry.version !== lock.source.binaryVersion || entry.sha256 !== await sha256(asset)) throw new Error("zmx asset is not covered by its signed release manifest")
  return entry
}

async function runAssetVersion(asset, platform, runner) {
  if (platform === "darwin-x64" && process.arch === "arm64") return runner("/usr/bin/arch", ["-x86_64", asset, "version"])
  return runner(asset, ["version"])
}

function validateSourceLock(lock) {
  if (lock.schemaVersion !== 2 || lock.commit !== "0266042ca8f399c9d76825739b93443e2d5bf47a" || lock.baseRelease !== "0.7.1" || lock.baseReleaseCommit !== "1cea103fef83cd53586fcb2c5f90d693fc9f5a30" || lock.releaseLineRelation !== "diverged-not-ancestor" || lock.binaryVersion !== "0.7.0") throw new Error("invalid zmx source lock")
  if (lock.buildTool !== "zig-0.16.0" || lock.build.optimize !== "ReleaseSafe") throw new Error("invalid zmx build lock")
  if (lock.qualifiedAssets?.status !== "release-manifest-required") throw new Error("zmx assets must be qualified by a signed per-release manifest")
}

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--output") options.output = args[++index]
    else if (argument === "--work") options.work = args[++index]
    else if (argument === "--repository") options.repository = args[++index]
    else if (argument === "--platform") options.platform = args[++index]
    else if (argument === "--require-signature") options.requireSignature = true
    else throw new Error(`unknown option: ${argument}`)
  }
  if (!options.output) throw new Error("usage: build-zmx-release.mjs --output <directory> [--platform darwin-arm64|darwin-x64] [--require-signature]")
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const options = parseArgs(process.argv.slice(2))
  options.signingKey = process.env.RUBATO_RELEASE_SIGNING_KEY
  options.publicKey = process.env.RUBATO_RELEASE_PUBLIC_KEY
  buildZmxRelease(options).then((manifest) => console.log(JSON.stringify(manifest))).catch((error) => { console.error(`build-zmx-release: ${error.message}`); process.exitCode = 1 })
}
