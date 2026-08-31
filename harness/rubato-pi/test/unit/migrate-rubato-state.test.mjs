import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
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

function json(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`)
}

function transcriptEntry(sourceLineId, sourceMessageId, kind, capturedAt) {
  return {
    kind,
    text: `${kind}-${sourceLineId}`,
    captured_at: capturedAt,
    source_line_id: sourceLineId,
    source_message_id: sourceMessageId,
  }
}

function jsonl(path, entries) {
  write(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
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

test("merges missing files, removes identical copies, and resolves generic conflicts", () => {
  const root = fixture()
  try {
    const source = join(root, ".omo")
    const target = join(root, ".rubato")
    write(join(source, "only-old"), "move")
    write(join(source, "same"), "same")
    write(join(source, "conflict"), "old")
    write(join(target, "same"), "same")
    write(join(target, "conflict"), "new")
    utimesSync(join(source, "conflict"), new Date("2030-01-01"), new Date("2030-01-01"))
    const result = migrateRoot(source, target)
    assert.equal(readFileSync(join(target, "only-old"), "utf8"), "move")
    assert.equal(existsSync(join(source, "same")), false)
    assert.equal(result.resolved, 1)
    assert.equal(readFileSync(join(target, "conflict"), "utf8"), "new")
    assert.equal(existsSync(join(target, ".migration-archive")), false)
    assert.equal(existsSync(source), false)
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

test("concurrent launchers serialize the same state migration", async () => {
  const root = fixture()
  try {
    const home = join(root, "home")
    write(join(home, ".omo", "settings.json"), '{"legacy":true}\n')
    const run = () => new Promise((resolveRun) => {
      const child = spawn(process.execPath, [
        join(repoRoot, "harness", "scripts", "migrate-rubato-state.mjs"),
        "--home",
        home,
        "--cwd",
        home,
      ], { stdio: "ignore" })
      child.on("exit", (status) => resolveRun(status))
    })
    assert.deepEqual(await Promise.all([run(), run()]), [0, 0])
    assert.equal(existsSync(join(home, ".omo")), false)
    assert.equal(readFileSync(join(home, ".rubato", "settings.json"), "utf8"), '{"legacy":true}\n')
    assert.equal(existsSync(join(home, ".rubato.omo-migration-lock")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("moves a symlinked legacy root without following it", () => {
  const root = fixture()
  try {
    const outside = join(root, "outside")
    const source = join(root, ".omo")
    symlinkSync(outside, source, "dir")
    const target = join(root, ".rubato")
    const result = migrateRoot(source, target)
    assert.equal(result.moved, 1)
    assert.equal(existsSync(source), false)
    assert.equal(lstatSync(target).isSymbolicLink(), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("moves a non-conflicting symlink entry into the live tree", () => {
  const root = fixture()
  try {
    const source = join(root, ".omo")
    const target = join(root, ".rubato")
    mkdirSync(source)
    mkdirSync(target)
    symlinkSync(join(root, "outside"), join(source, "auth-link"))
    const result = migrateRoot(source, target)
    assert.equal(result.moved, 1)
    assert.equal(lstatSync(join(target, "auth-link")).isSymbolicLink(), true)
    assert.equal(existsSync(join(source, "auth-link")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("drops a conflicting legacy symlink instead of overwriting the live file", () => {
  const root = fixture()
  try {
    const source = join(root, ".omo")
    const target = join(root, ".rubato")
    mkdirSync(source)
    write(join(target, "auth-link"), "live")
    symlinkSync(join(root, "outside"), join(source, "auth-link"))
    const result = migrateRoot(source, target)
    assert.equal(result.resolved, 1)
    assert.equal(readFileSync(join(target, "auth-link"), "utf8"), "live")
    assert.equal(existsSync(join(source, "auth-link")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("repairs archived transcripts, reflection state, and facts cursor into canonical runtime", () => {
  const root = fixture()
  try {
    const home = join(root, "home")
    const target = join(home, ".rubato")
    const archive = join(target, ".migration-archive", "omo")
    const relative = join("memory", "agents", "agent", "runtime")
    const session = join(relative, "transcripts", "session")
    const cursor = join(relative, "facts-queue", "cursor", "cursor.json")
    const u1 = transcriptEntry("u1", "m1", "user", "2026-01-01T00:00:00.000Z")
    const a1 = transcriptEntry("a1", "m2", "assistant", "2026-01-01T00:01:00.000Z")
    const u2 = transcriptEntry("u2", "m3", "user", "2026-01-01T00:02:00.000Z")
    const a2 = transcriptEntry("a2", "m4", "assistant", "2026-01-01T00:03:00.000Z")
    const u3 = transcriptEntry("u3", "m5", "user", "2026-01-01T00:04:00.000Z")
    const a3 = transcriptEntry("a3", "m6", "assistant", "2026-01-01T00:05:00.000Z")
    jsonl(join(target, session, "transcript.jsonl"), [u1, a1, u3, a3])
    jsonl(join(archive, session, "transcript.jsonl"), [
      { ...u1, captured_at: "2026-01-02T00:00:00.000Z" },
      { ...a1, captured_at: "2026-01-02T00:01:00.000Z" },
      u2,
      a2,
      u3,
      a3,
    ])
    json(join(target, session, "state.json"), {
      schema_version: "v3_assistant_steps",
      reflected_through_message_id: "m2",
      total_completed_steps: 2,
      reflected_completed_steps: 1,
      steps_since_last_successful_reflection: 1,
    })
    json(join(archive, session, "state.json"), {
      schema_version: "v3_assistant_steps",
      reflected_through_message_id: "m4",
      total_completed_steps: 2,
      reflected_completed_steps: 2,
      steps_since_last_successful_reflection: 0,
    })
    json(join(target, cursor), {
      version: 1,
      consumed_through_message_id: null,
      consumed_through_snapshot_line: -1,
      enqueued_through_message_id: "m2",
      enqueued_through_snapshot_line: 2,
    })
    json(join(archive, cursor), {
      version: 1,
      consumed_through_message_id: null,
      consumed_through_snapshot_line: -1,
      enqueued_through_message_id: "m4",
      enqueued_through_snapshot_line: 4,
    })

    migrateRubatoState({ home, cwd: home })

    const merged = readFileSync(join(target, session, "transcript.jsonl"), "utf8")
      .trim().split("\n").map(JSON.parse)
    assert.deepEqual(merged.map((entry) => entry.source_line_id), ["u1", "a1", "u2", "a2", "u3", "a3"])
    assert.equal(merged[0].captured_at, u1.captured_at)
    assert.deepEqual(readFileSync(join(target, session, "state.json"), "utf8").includes(
      '"reflected_through_message_id": "m4"',
    ), true)
    const mergedState = JSON.parse(readFileSync(join(target, session, "state.json"), "utf8"))
    assert.equal(mergedState.total_completed_steps, 3)
    assert.equal(mergedState.reflected_completed_steps, 2)
    assert.equal(mergedState.steps_since_last_successful_reflection, 1)
    const mergedCursor = JSON.parse(readFileSync(join(target, cursor), "utf8"))
    assert.equal(mergedCursor.enqueued_through_message_id, "m4")
    assert.equal(mergedCursor.enqueued_through_snapshot_line, 4)
    assert.equal(existsSync(join(target, ".migration-archive")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("facts cursor snapshot boundaries never decrease to a message position", () => {
  const root = fixture()
  try {
    const home = join(root, "home")
    const target = join(home, ".rubato")
    const archive = join(target, ".migration-archive", "omo")
    const relative = join("memory", "agents", "agent", "runtime")
    const session = join(relative, "transcripts", "session")
    const cursor = join(relative, "facts-queue", "cursor", "cursor.json")
    const entries = [
      transcriptEntry("u1", "m1", "user", "2026-01-01T00:00:00.000Z"),
      transcriptEntry("a1", "m1", "assistant", "2026-01-01T00:01:00.000Z"),
      transcriptEntry("e1", "m2", "error", "2026-01-01T00:02:00.000Z"),
    ]
    jsonl(join(target, session, "transcript.jsonl"), entries)
    json(join(target, cursor), {
      version: 1,
      consumed_through_message_id: null,
      consumed_through_snapshot_line: -1,
      enqueued_through_message_id: "m1",
      enqueued_through_snapshot_line: 3,
    })
    json(join(archive, cursor), {
      version: 1,
      consumed_through_message_id: null,
      consumed_through_snapshot_line: -1,
      enqueued_through_message_id: "m1",
      enqueued_through_snapshot_line: 2,
    })
    migrateRubatoState({ home, cwd: home })
    const merged = JSON.parse(readFileSync(join(target, cursor), "utf8"))
    assert.equal(merged.enqueued_through_message_id, "m1")
    assert.equal(merged.enqueued_through_snapshot_line, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a generic migration never rewrites unrelated live memory state", () => {
  const root = fixture()
  try {
    const home = join(root, "home")
    const target = join(home, ".rubato")
    const state = join(
      target,
      "memory",
      "agents",
      "agent",
      "runtime",
      "transcripts",
      "live",
      "state.json",
    )
    const original = '{"schema_version":"v3_assistant_steps","total_completed_steps":7}\n'
    write(state, original)
    write(join(home, ".omo", "settings.json"), "{}\n")
    migrateRubatoState({ home, cwd: home })
    assert.equal(readFileSync(state, "utf8"), original)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("keeps canonical ephemeral runtime files and removes archived copies", () => {
  const root = fixture()
  try {
    const home = join(root, "home")
    const target = join(home, ".rubato")
    const archive = join(target, ".migration-archive", "omo")
    for (const relative of [
      join("codegraph", "worker-sweep.stamp"),
      join("lsp-daemon", "v0.1.0", "daemon.auth"),
      join("memory", "agents", "agent", "runtime", "notices", "soul-head.json"),
    ]) {
      write(join(target, relative), "canonical")
      write(join(archive, relative), "legacy")
    }
    migrateRubatoState({ home, cwd: home })
    assert.equal(readFileSync(join(target, "codegraph", "worker-sweep.stamp"), "utf8"), "canonical")
    assert.equal(readFileSync(join(target, "lsp-daemon", "v0.1.0", "daemon.auth"), "utf8"), "canonical")
    assert.equal(existsSync(join(target, ".migration-archive")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("repairs both legacy archive namespaces and leaves no archive root", () => {
  const root = fixture()
  try {
    const home = join(root, "home")
    const target = join(home, ".rubato")
    write(join(target, ".migration-archive", "omo", "from-omo"), "omo\n")
    write(join(target, ".migration-archive", "rubato", "from-rubato"), "rubato\n")
    migrateRubatoState({ home, cwd: home })
    assert.equal(readFileSync(join(target, "from-omo"), "utf8"), "omo\n")
    assert.equal(readFileSync(join(target, "from-rubato"), "utf8"), "rubato\n")
    assert.equal(existsSync(join(target, ".migration-archive")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("does not inspect project ancestors when cwd is outside HOME", () => {
  const root = fixture()
  try {
    const home = join(root, "home")
    const outside = join(root, "outside", "repo")
    write(join(root, "outside", ".omo", "foreign"), "foreign\n")
    mkdirSync(outside, { recursive: true })
    migrateRubatoState({ home, cwd: outside })
    assert.equal(existsSync(join(root, "outside", ".omo", "foreign")), true)
    assert.equal(existsSync(join(root, "outside", ".rubato")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("merges an unrelated legacy memory git history while keeping canonical conflicts", () => {
  const root = fixture()
  const runGit = (repo, args) => {
    const result = spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    const source = join(root, ".omo")
    const target = join(root, ".rubato")
    const sourceRepo = join(source, "memory", "agents", "agent", "repo")
    const targetRepo = join(target, "memory", "agents", "agent", "repo")
    for (const repo of [sourceRepo, targetRepo]) {
      mkdirSync(repo, { recursive: true })
      runGit(repo, ["init", "-b", "main"])
    }
    write(join(sourceRepo, "system", "human.md"), "legacy\n")
    write(join(sourceRepo, "decisions", "legacy.md"), "legacy decision\n")
    write(join(sourceRepo, "decisions", "only-old.md"), "old-only decision\n")
    runGit(sourceRepo, ["add", "."])
    runGit(sourceRepo, ["commit", "-m", "legacy"])
    const legacyHead = runGit(sourceRepo, ["rev-parse", "HEAD"])
    write(join(sourceRepo, "decisions", "uncommitted.md"), "legacy crash recovery\n")
    runGit(sourceRepo, ["branch", "memory/reflection-1"])
    const legacyWorktree = join(source, "memory", "agents", "agent", "runtime", "worktrees", "run-1")
    runGit(sourceRepo, ["worktree", "add", legacyWorktree, "memory/reflection-1"])
    write(join(legacyWorktree, "decisions", "legacy.md"), "tracked reflection update\n")
    write(join(legacyWorktree, "decisions", "unfinished.md"), "unfinished reflection\n")
    write(join(targetRepo, "system", "human.md"), "canonical\n")
    runGit(targetRepo, ["add", "."])
    runGit(targetRepo, ["commit", "-m", "canonical"])
    write(join(targetRepo, "decisions", "legacy.md"), "canonical override\n")

    migrateRubatoState({ home: root, cwd: root })

    assert.equal(readFileSync(join(targetRepo, "system", "human.md"), "utf8"), "canonical\n")
    assert.equal(readFileSync(join(targetRepo, "decisions", "legacy.md"), "utf8"), "canonical override\n")
    assert.equal(readFileSync(join(targetRepo, "decisions", "only-old.md"), "utf8"), "old-only decision\n")
    assert.equal(readFileSync(join(targetRepo, "decisions", "uncommitted.md"), "utf8"), "legacy crash recovery\n")
    assert.equal(
      runGit(targetRepo, ["show", "rubato-migration/omo/memory/reflection-1:decisions/unfinished.md"]),
      "unfinished reflection",
    )
    assert.equal(
      runGit(targetRepo, ["show", "rubato-migration/omo/memory/reflection-1:decisions/legacy.md"]),
      "tracked reflection update",
    )
    const migratedWorktree = join(target, "memory", "agents", "agent", "runtime", "worktrees", "run-1")
    assert.equal(readFileSync(join(migratedWorktree, "decisions", "unfinished.md"), "utf8"), "unfinished reflection\n")
    assert.equal(readFileSync(join(migratedWorktree, "decisions", "legacy.md"), "utf8"), "tracked reflection update\n")
    assert.equal(runGit(migratedWorktree, ["status", "--porcelain"]), "")
    assert.equal(runGit(targetRepo, ["merge-base", "--is-ancestor", legacyHead, "HEAD"]), "")
    assert.equal(existsSync(source), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("launcher, updater, and installer all invoke state migration", () => {
  const launcher = readFileSync(join(repoRoot, "harness", "scripts", "rubato-pi.sh"), "utf8")
  const updater = readFileSync(join(repoRoot, "harness", "scripts", "rubato-update.sh"), "utf8")
  const installer = readFileSync(join(repoRoot, "install.sh"), "utf8")
  assert.match(launcher, /migrate-rubato-state\.mjs" --cwd "\$PWD"/)
  assert.match(launcher, /\.rubato\/\.migration-archive\/omo/)
  assert.match(launcher, /\.rubato\/\.migration-archive\/rubato/)
  assert.notEqual(lstatSync(join(repoRoot, "harness", "scripts", "rubato-pi.sh")).mode & 0o111, 0)
  assert.match(updater, /\[ "\$MODE" != check \].*migrate-rubato-state\.mjs/s)
  assert.match(installer, /migrate-rubato-state\.mjs" --cwd "\$PWD"/)
})

test("HOME and USERPROFILE override the operating-system account home", () => {
  assert.equal(resolveMigrationHome({ HOME: "/tmp/rubato-home" }), "/tmp/rubato-home")
  assert.equal(resolveMigrationHome({ USERPROFILE: "C:\\Users\\rubato" }), "C:\\Users\\rubato")
})
