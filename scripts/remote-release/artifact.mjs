import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

import { RELEASE_SCHEMA_VERSION } from "./constants.mjs"
import { isInside, sha256 } from "./lib.mjs"

const MANIFEST = "release-manifest.json"
const SIGNATURE = "release-manifest.sig"

async function walkFiles(root, directory = root, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const relativePath = relative(root, path).split(sep).join("/")
    if (relativePath === MANIFEST || relativePath === SIGNATURE) continue
    if (entry.isSymbolicLink()) throw new Error(`release contains symlink: ${relativePath}`)
    if (entry.isDirectory()) await walkFiles(root, path, output)
    else if (entry.isFile()) output.push({ path, relativePath })
    else throw new Error(`release contains unsupported entry: ${relativePath}`)
  }
  return output
}

export async function createReleaseManifest(root, metadata = {}) {
  const files = []
  for (const item of (await walkFiles(root)).sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const info = await stat(item.path)
    files.push({ path: item.relativePath, bytes: info.size, sha256: await sha256(item.path), executable: (info.mode & 0o111) !== 0 })
  }
  const manifest = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    buildId: metadata.buildId,
    sourceCommit: metadata.sourceCommit,
    createdAt: metadata.createdAt ?? new Date().toISOString(),
    node: metadata.node,
    bun: metadata.bun,
    zmx: metadata.zmx,
    files,
  }
  validateManifest(manifest)
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(join(root, MANIFEST), encoded, { mode: 0o644 })
  return manifest
}

export async function signReleaseManifest(root, privateKeyPem) {
  if (!privateKeyPem) throw new Error("release signing key is required")
  const manifest = await readFile(join(root, MANIFEST))
  const signature = cryptoSign(null, manifest, privateKeyPem).toString("base64")
  await writeFile(join(root, SIGNATURE), `${signature}\n`, { mode: 0o644 })
}

export async function verifyRelease(root, options = {}) {
  const rootReal = await realpath(root)
  const manifestPath = join(rootReal, MANIFEST)
  const encoded = await readFile(manifestPath)
  const manifest = JSON.parse(encoded.toString("utf8"))
  validateManifest(manifest)

  if (options.publicKeyPem) {
    const signature = Buffer.from((await readFile(join(rootReal, SIGNATURE), "utf8")).trim(), "base64")
    if (!cryptoVerify(null, encoded, createPublicKey(options.publicKeyPem), signature)) throw new Error("release manifest signature is invalid")
  } else if (options.requireSignature) {
    throw new Error("trusted release public key is required")
  }

  const expected = new Map(manifest.files.map((file) => [file.path, file]))
  const actual = await walkFiles(rootReal)
  if (actual.length !== expected.size) throw new Error("release file set differs from manifest")
  for (const item of actual) {
    const record = expected.get(item.relativePath)
    if (!record) throw new Error(`unmanifested release file: ${item.relativePath}`)
    const info = await stat(item.path)
    if (info.size !== record.bytes || await sha256(item.path) !== record.sha256) throw new Error(`release checksum mismatch: ${item.relativePath}`)
    if (((info.mode & 0o111) !== 0) !== record.executable) throw new Error(`release executable mode mismatch: ${item.relativePath}`)
  }
  return manifest
}

export async function extractTarballAtomic(tarball, destination, { run, publicKeyPem, requireSignature = true } = {}) {
  if (!run) throw new TypeError("extractTarballAtomic requires a command runner")
  await mkdir(dirname(destination), { recursive: true })
  const staging = `${destination}.staging-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { mode: 0o700 })
  try {
    await run("/usr/bin/tar", ["-xzf", resolve(tarball), "-C", staging, "--no-same-owner"])
    const entries = await readdir(staging)
    const root = entries.length === 1 && (await lstat(join(staging, entries[0]))).isDirectory() ? join(staging, entries[0]) : staging
    const rootReal = await realpath(root)
    if (!isInside(rootReal, await realpath(staging))) throw new Error("archive root escapes staging directory")
    await verifyRelease(rootReal, { publicKeyPem, requireSignature })
    if (root !== staging) await rename(root, `${staging}.verified`)
    const verified = root === staging ? staging : `${staging}.verified`
    await rename(verified, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    await rm(`${staging}.verified`, { recursive: true, force: true })
    throw error
  }
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== RELEASE_SCHEMA_VERSION || typeof manifest.buildId !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(manifest.buildId)) throw new Error("invalid release manifest")
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("release manifest has no files")
  const seen = new Set()
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || file.path.startsWith("/") || file.path.includes("\\") || file.path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe release manifest path")
    if (seen.has(file.path)) throw new Error("duplicate release manifest path")
    seen.add(file.path)
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/.test(file.sha256) || typeof file.executable !== "boolean") throw new Error("invalid release manifest file")
  }
}
