import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { verifyBuiltZmx } from "./build-release.mjs"
import { verifyZmxReleaseAsset } from "./build-zmx-release.mjs"
import { sha256 } from "./lib.mjs"

const sourceLock = {
  schemaVersion: 2,
  commit: "0266042ca8f399c9d76825739b93443e2d5bf47a",
  baseRelease: "0.7.1",
  binaryVersion: "0.7.0",
  qualifiedAssets: { status: "release-manifest-required" },
}

test("built zmx version must match the version recorded by the source pin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rubato-zmx-version-"))
  const asset = join(directory, "zmx")
  await writeFile(asset, "exact bytes")
  try {
    const architecture = process.arch === "arm64" ? "arm64" : "x86_64"
    const runner = async (file, args) => file === "/usr/bin/file"
      ? { stdout: `${asset}: Mach-O 64-bit executable ${architecture}\n` }
      : { stdout: "zmx\t\t0.7.0\nghostty_vt\ttest\n" }
    const result = await verifyBuiltZmx(asset, sourceLock, runner)
    assert.equal(result.version, sourceLock.binaryVersion)
    await assert.rejects(() => verifyBuiltZmx(asset, sourceLock, async (file) => file === "/usr/bin/file"
      ? { stdout: `${asset}: Mach-O 64-bit executable ${architecture}\n` }
      : { stdout: "zmx\t\t0.7.1\n" }), /version does not match/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("signed zmx release manifest qualifies only its exact one-time asset bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rubato-zmx-manifest-"))
  const asset = join(directory, `zmx-darwin-${process.arch === "arm64" ? "arm64" : "x64"}`)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  try {
    await writeFile(asset, "one-time source build")
    const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, source: { commit: sourceLock.commit, baseRelease: "0.7.1", baseReleaseCommit: "1cea103fef83cd53586fcb2c5f90d693fc9f5a30", releaseLineRelation: "diverged-not-ancestor", binaryVersion: "0.7.0" }, build: { zigVersion: "0.16.0", optimize: "ReleaseSafe" }, assets: [{ file: asset.split("/").at(-1), sha256: await sha256(asset), version: "0.7.0" }] }, null, 2)}\n`)
    await writeFile(join(directory, "zmx-release-manifest.json"), manifest)
    await writeFile(join(directory, "zmx-release-manifest.sig"), `${sign(null, manifest, privateKey).toString("base64")}\n`)
    assert.equal((await verifyZmxReleaseAsset(directory, asset, publicKey)).file, asset.split("/").at(-1))
    await writeFile(asset, "different rebuild")
    await assert.rejects(() => verifyZmxReleaseAsset(directory, asset, publicKey), /not covered/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
