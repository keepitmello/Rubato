import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { combineZmxRelease } from "./combine-zmx-release.mjs"
import { verifyZmxReleaseAsset } from "./build-zmx-release.mjs"
import { sha256 } from "./lib.mjs"

const root = join(import.meta.dirname, "..", "..")

test("combiner signs the exact two downloaded native partial assets and rejects byte drift", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "rubato-zmx-combine-"))
  const lock = JSON.parse(await readFile(join(root, "third_party", "zmx-lock.json"), "utf8"))
  const partials = []
  const definitions = [["darwin-arm64", "aarch64-macos"], ["darwin-x64", "x86_64-macos"]]
  try {
    for (const [platform, target] of definitions) {
      const directory = join(temporary, platform); await mkdir(directory)
      const file = `zmx-${platform}`; const asset = join(directory, file)
      await writeFile(asset, `exact-${platform}`)
      const entry = { platform, target, file, bytes: (await readFile(asset)).length, sha256: await sha256(asset), version: lock.binaryVersion }
      const source = { repository: lock.repository, commit: lock.commit, tree: lock.tree, describe: lock.describe, baseRelease: lock.baseRelease, baseReleaseCommit: lock.baseReleaseCommit, releaseLineRelation: lock.releaseLineRelation, binaryVersion: lock.binaryVersion }
      await writeFile(join(directory, "zmx-release-manifest.json"), `${JSON.stringify({ schemaVersion: 1, source, build: { zigVersion: "0.16.0", optimize: "ReleaseSafe" }, createdAt: "partial", assets: [entry], license: lock.license }, null, 2)}\n`)
      await writeFile(join(directory, "zmx-smoke-report.json"), `${JSON.stringify({ schemaVersion: 1, sourceCommit: lock.commit, assets: [{ platform, runListKill: "pass", terminalAttachFrameEcho: "pass", frameBytes: 1, leakedSessions: 0 }] })}\n`)
      await cp(join(root, "third_party", lock.license.path), join(directory, "LICENSE.zmx"))
      partials.push(directory)
    }
    const keys = generateKeyPairSync("ed25519"); const output = join(temporary, "combined")
    const manifest = await combineZmxRelease({ repository: root, partialDirectories: partials, output, signingKey: keys.privateKey, publicKey: keys.publicKey })
    assert.deepEqual(manifest.assets.map((entry) => entry.platform), ["darwin-arm64", "darwin-x64"])
    await verifyZmxReleaseAsset(output, join(output, "zmx-darwin-arm64"), keys.publicKey)
    await writeFile(join(partials[1], "zmx-darwin-x64"), "rebuilt bytes")
    await assert.rejects(() => combineZmxRelease({ repository: root, partialDirectories: partials, output, signingKey: keys.privateKey, publicKey: keys.publicKey }), /bytes differ/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
