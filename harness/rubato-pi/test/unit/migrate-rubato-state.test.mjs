import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname } from "node:path"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { migrateRoot, migrateRubatoState, resolveMigrationHome } from "../../../scripts/migrate-rubato-state.mjs"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

function fixture() {
  return mkdtempSync(join(tmpdir(), "rubato-state-migration-"))
}

function write(path, contents) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, contents)
}

test("moves a legacy root atomically when the Rubato root is absent", () => {
  const root = fixture()
  try {
    const source = join(root, ".omo")
    const target = join(root, ".rubato")
    write(join(source, "omo.jsonc"), "{\n}\n")
    const result = migrateRoot(source, target)
    assert.equal(result.moved, 1)
    assert.equal(existsSync(source), false)
    assert.equal(readFileSync(join(target, "rubato.jsonc"), "utf8"), "{\n}\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("merges missing files, removes identical copies, and preserves conflicts", () => {
  const root = fixture()
  try {
    const source = join(root, ".omo")
    const target = join(root, ".rubato")
    write(join(source, "only-old"), "move")
    write(join(source, "same"), "same")
    write(join(source, "conflict"), "old")
    write(join(target, "same"), "same")
    write(join(target, "conflict"), "new")
    const result = migrateRoot(source, target)
    assert.equal(readFileSync(join(target, "only-old"), "utf8"), "move")
    assert.equal(existsSync(join(source, "same")), false)
    assert.deepEqual(result.conflicts, [join(source, "conflict")])
    assert.equal(readFileSync(join(source, "conflict"), "utf8"), "old")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("migrates both the user root and the current project root", () => {
  const root = fixture()
  try {
    const home = join(root, "home")
    const project = join(home, "work", "repo")
    write(join(home, ".omo", "settings.json"), "{}")
    write(join(project, ".omo", "rubato.jsonc"), "{}")
    migrateRubatoState({ home, cwd: project })
    assert.equal(existsSync(join(home, ".omo")), false)
    assert.equal(existsSync(join(project, ".omo")), false)
    assert.equal(existsSync(join(home, ".rubato", "settings.json")), true)
    assert.equal(existsSync(join(project, ".rubato", "rubato.jsonc")), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("leaves a symlinked legacy root untouched", () => {
  const root = fixture()
  try {
    const outside = join(root, "outside")
    mkdirSync(outside)
    const source = join(root, ".omo")
    symlinkSync(outside, source, "dir")
    const result = migrateRoot(source, join(root, ".rubato"))
    assert.deepEqual(result.conflicts, [source])
    assert.equal(existsSync(source), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("launcher, updater, and installer all invoke state migration", () => {
  const launcher = readFileSync(join(repoRoot, "harness", "scripts", "rubato-pi.sh"), "utf8")
  const updater = readFileSync(join(repoRoot, "harness", "scripts", "rubato-update.sh"), "utf8")
  const installer = readFileSync(join(repoRoot, "install.sh"), "utf8")
  assert.match(launcher, /migrate-rubato-state\.mjs" --cwd "\$PWD"/)
  assert.match(updater, /\[ "\$MODE" != check \].*migrate-rubato-state\.mjs/s)
  assert.match(installer, /migrate-rubato-state\.mjs" --cwd "\$PWD"/)
})

test("HOME and USERPROFILE override the operating-system account home", () => {
  assert.equal(resolveMigrationHome({ HOME: "/tmp/rubato-home" }), "/tmp/rubato-home")
  assert.equal(resolveMigrationHome({ USERPROFILE: "C:\\Users\\rubato" }), "C:\\Users\\rubato")
})
