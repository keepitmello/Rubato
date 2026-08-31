#!/usr/bin/env node
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { readJson, sha256 } from "./lib.mjs"

const PLATFORMS = new Map([
  ["darwin-arm64", "aarch64-macos"],
  ["darwin-x64", "x86_64-macos"],
])

export async function combineZmxRelease(options) {
  if (options.partialDirectories?.length !== 2) throw new Error("exactly two native zmx partial artifacts are required")
  const repository = resolve(options.repository ?? join(import.meta.dirname, "..", ".."))
  const output = resolve(options.output)
  const lock = await readJson(join(repository, "third_party", "zmx-lock.json"))
  const partials = []
  for (const directoryValue of options.partialDirectories) {
    const directory = resolve(directoryValue)
    const manifest = await readJson(join(directory, "zmx-release-manifest.json"))
    const smoke = await readJson(join(directory, "zmx-smoke-report.json"))
    if (manifest.schemaVersion !== 1 || manifest.assets?.length !== 1) throw new Error("each native partial manifest must contain exactly one asset")
    const asset = manifest.assets[0]
    if (PLATFORMS.get(asset.platform) !== asset.target || asset.file !== `zmx-${asset.platform}`) throw new Error("native partial has an unexpected platform or target")
    if (manifest.source?.commit !== lock.commit || manifest.source?.tree !== lock.tree || manifest.source?.describe !== lock.describe || manifest.source?.baseRelease !== lock.baseRelease || manifest.source?.baseReleaseCommit !== lock.baseReleaseCommit || manifest.source?.releaseLineRelation !== lock.releaseLineRelation || manifest.source?.binaryVersion !== lock.binaryVersion) throw new Error("native partial source provenance differs from the lock")
    if (manifest.build?.zigVersion !== "0.16.0" || manifest.build?.optimize !== "ReleaseSafe" || asset.version !== lock.binaryVersion) throw new Error("native partial build metadata differs from policy")
    if (smoke.sourceCommit !== lock.commit || smoke.assets?.length !== 1 || smoke.assets[0]?.platform !== asset.platform || smoke.assets[0]?.runListKill !== "pass" || smoke.assets[0]?.terminalAttachFrameEcho !== "pass" || smoke.assets[0]?.leakedSessions !== 0) throw new Error("native partial lacks its exact architecture smoke evidence")
    const assetPath = join(directory, asset.file)
    if (await sha256(assetPath) !== asset.sha256) throw new Error(`${asset.platform} bytes differ from its partial manifest`)
    partials.push({ directory, manifest, smoke: smoke.assets[0], asset, assetPath })
  }
  const platforms = partials.map((item) => item.asset.platform).sort()
  if (platforms.join(",") !== [...PLATFORMS.keys()].sort().join(",")) throw new Error("native arm64 and x86_64 partials are both required")

  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  for (const item of partials) {
    await cp(item.assetPath, join(output, item.asset.file))
    await chmod(join(output, item.asset.file), 0o755)
  }
  const license = await readFile(join(repository, "third_party", lock.license.path))
  for (const item of partials) {
    const shipped = await readFile(join(item.directory, "LICENSE.zmx"))
    if (!shipped.equals(license)) throw new Error(`${item.asset.platform} MIT notice differs from vendored evidence`)
  }
  await writeFile(join(output, "LICENSE.zmx"), license)

  const first = partials[0].manifest
  const manifest = {
    schemaVersion: 1,
    source: first.source,
    build: first.build,
    createdAt: new Date().toISOString(),
    assets: partials.map((item) => item.asset).sort((left, right) => left.platform.localeCompare(right.platform)),
    license: lock.license,
  }
  const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(output, lock.qualifiedAssets.manifest), encoded)
  if (!options.signingKey) throw new Error("RUBATO_RELEASE_SIGNING_KEY is required to combine native assets")
  const signature = cryptoSign(null, encoded, options.signingKey)
  await writeFile(join(output, lock.qualifiedAssets.signature), `${signature.toString("base64")}\n`)
  const publicKey = typeof options.publicKey === "string" || Buffer.isBuffer(options.publicKey) ? createPublicKey(options.publicKey) : options.publicKey
  if (!publicKey || !cryptoVerify(null, encoded, publicKey, signature)) throw new Error("combined zmx manifest signature self-verification failed")
  const report = { schemaVersion: 1, sourceCommit: lock.commit, assets: partials.map((item) => item.smoke).sort((left, right) => left.platform.localeCompare(right.platform)) }
  await writeFile(join(output, "zmx-smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`)
  return manifest
}

function parseArgs(args) {
  const options = { partialDirectories: [] }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--partial") options.partialDirectories.push(args[++index])
    else if (argument === "--output") options.output = args[++index]
    else if (argument === "--repository") options.repository = args[++index]
    else throw new Error(`unknown option: ${argument}`)
  }
  if (!options.output || options.partialDirectories.length !== 2) throw new Error("usage: combine-zmx-release.mjs --partial <arm64> --partial <x64> --output <directory>")
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const options = parseArgs(process.argv.slice(2))
  options.signingKey = process.env.RUBATO_RELEASE_SIGNING_KEY
  options.publicKey = process.env.RUBATO_RELEASE_PUBLIC_KEY
  combineZmxRelease(options).then((manifest) => console.log(JSON.stringify(manifest))).catch((error) => { console.error(`combine-zmx-release: ${error.message}`); process.exitCode = 1 })
}
