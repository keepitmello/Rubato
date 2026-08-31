import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import test from "node:test"

import { createReleaseManifest } from "./artifact.mjs"
import { ZMX_COMMIT } from "./constants.mjs"

const execute = promisify(execFile)
const repository = resolve(import.meta.dirname, "..", "..")

test("release wrappers execute their main module through a symlinked checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rubato-release-wrapper-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const release = join(root, "release")
  await mkdir(release)
  await writeFile(join(release, "payload.txt"), "wrapper contract\n")
  await createReleaseManifest(release, {
    buildId: "wrapper-contract",
    sourceCommit: "a".repeat(40),
    node: "24.0.0",
    bun: "1.4.0",
    zmx: { commit: ZMX_COMMIT, version: "0.7.0", asset: "zmx", sha256: "b".repeat(64) },
  })
  const checkout = join(root, "checkout")
  await symlink(repository, checkout, "dir")

  const { stdout } = await execute(join(checkout, "scripts", "remote-release", "verify.sh"), [
    "--release", release, "--trusted-local-build",
  ], { cwd: root })
  const result = JSON.parse(stdout)
  assert.equal(result.buildId, "wrapper-contract")

  for (const name of ["doctor.sh", "install.sh", "uninstall.sh", "update.sh", "verify.sh"]) {
    assert.match(await readFile(join(repository, "scripts", "remote-release", name), "utf8"), /pwd -P/)
  }
})
