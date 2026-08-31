import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import test from "node:test"

import { lockedRegistryPackages, parseJsonc, validatePolicy } from "./license-policy.mjs"

const root = resolve(import.meta.dirname, "..")

test("full bun lock has a reviewed, exact license record for every registry package", async () => {
  const packages = lockedRegistryPackages(parseJsonc(await readFile(join(root, "bun.lock"), "utf8")))
  const policy = JSON.parse(await readFile(join(root, "third_party", "npm-license-policy.json"), "utf8"))
  assert.ok(packages.length > 700, "expected the complete workspace lock, not direct dependencies only")
  assert.deepEqual(validatePolicy(packages, policy), [])
})

test("unknown, stale, GPL, AGPL, and unexplained exceptions fail closed", () => {
  const packages = [{ name: "unknown", version: "1.0.0" }, { name: "gpl", version: "1.0.0" }, { name: "agpl", version: "1.0.0" }, { name: "exception", version: "1.0.0" }]
  const failures = validatePolicy(packages, { packages: [
    { name: "unknown", version: "1.0.0", license: "UNKNOWN" },
    { name: "gpl", version: "1.0.0", license: "GPL-3.0-only", approvedException: true, exceptionReason: "not sufficient" },
    { name: "agpl", version: "1.0.0", license: "AGPL-3.0-only" },
    { name: "exception", version: "1.0.0", license: "0BSD", approvedException: true },
    { name: "stale", version: "1.0.0", license: "MIT" },
  ] })
  assert.equal(failures.length, 5)
  assert.ok(failures.some((failure) => failure.includes("unknown license")))
  assert.ok(failures.filter((failure) => failure.includes("forbidden copyleft")).length === 2)
  assert.ok(failures.some((failure) => failure.includes("no reason")))
  assert.ok(failures.some((failure) => failure.includes("stale")))
})
