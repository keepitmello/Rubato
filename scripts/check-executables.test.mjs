import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import test from "node:test"

import { collectIndexModes, findFailures, parseRequired } from "./check-executables.mjs"

const root = resolve(import.meta.dirname, "..")

test("required-executables.txt is a sorted unique list", async () => {
  const required = parseRequired(await readFile(join(root, "scripts/required-executables.txt"), "utf8"))
  assert.ok(required.includes("harness/scripts/rubato-update.sh"))
  assert.ok(required.includes("harness/scripts/install-skills.sh"))
  assert.ok(required.includes("scripts/ci-local.sh"))
  assert.ok(required.includes(".githooks/pre-push"))
  assert.deepEqual(required, [...required].sort())
  assert.equal(new Set(required).size, required.length)
})

test("a rewrite that drops +x fails closed", () => {
  const required = ["harness/scripts/rubato-update.sh"]
  const index = collectIndexModes("100644 abc 0\tharness/scripts/rubato-update.sh\n")
  const worktree = new Map([["harness/scripts/rubato-update.sh", false]])
  const failures = findFailures(required, index, worktree)
  assert.ok(failures.some((line) => line.includes("100644")))
  assert.ok(failures.some((line) => line.includes("worktree")))
})

test("an intact 100755 path with +x on disk is clean", () => {
  const required = ["harness/scripts/rubato-update.sh"]
  const index = collectIndexModes("100755 abc 0\tharness/scripts/rubato-update.sh\n")
  const worktree = new Map([["harness/scripts/rubato-update.sh", true]])
  assert.deepEqual(findFailures(required, index, worktree), [])
})

test("a required path deleted from the index fails closed", () => {
  const failures = findFailures(["install.sh"], new Map(), new Map())
  assert.deepEqual(failures, ["install.sh: missing from the git index"])
})
