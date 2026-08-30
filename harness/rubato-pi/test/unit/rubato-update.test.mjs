import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/rubato-update.sh");

test("updater entrypoint stays executable", () => {
  assert.notEqual(statSync(SCRIPT_SRC).mode & 0o111, 0);
});

function git(cwd, args, opts = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_OK: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const INSTALL_SKILLS_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/install-skills.sh");

function setupFixture({ dirty = false, conflict = false, evidence = false, decoyStash = false, rebuildFailure = "", skillUpdate = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rubato-update-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const local = join(root, "local");
  const home = join(root, "home");
  mkdirSync(home);

  git(root, ["init", "--bare", "-b", "rubato/base", bare]);
  git(root, ["clone", bare, seed]);
  git(seed, ["config", "user.email", "upd@example.com"]);
  git(seed, ["config", "user.name", "upd"]);
  git(seed, ["config", "commit.gpgsign", "false"]);
  write(join(seed, "note.txt"), "v1\n");
  write(join(seed, "keep.txt"), "keep\n");
  write(join(seed, ".rubato/evidence/log.txt"), "evidence-v1\n");
  const scriptDest = join(seed, "harness/scripts/rubato-update.sh");
  mkdirSync(dirname(scriptDest), { recursive: true });
  cpSync(SCRIPT_SRC, scriptDest);
  chmodSync(scriptDest, 0o755);
  write(join(seed, "harness/prompts/base.pi.md"), "base\n");
  write(join(seed, "harness/prompts/build.sh"), "#!/bin/sh\nmkdir -p \"$(dirname \"$0\")/.build\"\nprintf built > \"$(dirname \"$0\")/.build/lead.pi.md\"\nprintf built > \"$(dirname \"$0\")/.build/teammate.pi.md\"\nprintf built > \"$(dirname \"$0\")/.build/agent.pi.md\"\n");
  chmodSync(join(seed, "harness/prompts/build.sh"), 0o755);
  write(join(seed, "install.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(seed, "install.sh"), 0o755);
  cpSync(INSTALL_SKILLS_SRC, join(seed, "harness/scripts/install-skills.sh"));
  chmodSync(join(seed, "harness/scripts/install-skills.sh"), 0o755);
  if (skillUpdate) {
    write(join(seed, "harness/skills/demo/SKILL.md"), "v1\n");
  }
  git(seed, ["add", "note.txt", "keep.txt", ".rubato/evidence/log.txt", "install.sh", "harness/prompts", "harness/scripts"]);
  if (skillUpdate) git(seed, ["add", "harness/skills"]);
  git(seed, ["commit", "-m", "base"]);
  git(seed, ["branch", "-M", "rubato/base"]);
  git(seed, ["push", "-u", "origin", "rubato/base"]);

  git(root, ["clone", "-b", "rubato/base", bare, local]);
  git(local, ["config", "user.email", "upd@example.com"]);
  git(local, ["config", "user.name", "upd"]);
  git(local, ["config", "commit.gpgsign", "false"]);

  write(join(seed, "note.txt"), "remote\n");
  if (skillUpdate) {
    write(join(seed, "harness/skills/demo/SKILL.md"), "v2\n");
    write(join(home, ".agents/skills/demo/SKILL.md"), "v1\n");
  }
  if (rebuildFailure === "deps") {
    write(join(seed, "package.json"), "{}\n");
  } else if (rebuildFailure === "prompts") {
    write(join(seed, "harness/prompts/build.sh"), "#!/bin/sh\nprintf 'prompts\\n' >> \"$RUBATO_TEST_TRACE\"\nexit 42\n");
    chmodSync(join(seed, "harness/prompts/build.sh"), 0o755);
  } else if (rebuildFailure === "engine") {
    write(join(seed, "packages/component.txt"), "changed\n");
  } else if (rebuildFailure === "shell") {
    write(join(seed, "install.sh"), "#!/bin/sh\nprintf 'shell\\n' >> \"$RUBATO_TEST_TRACE\"\necho shell-failed >&2\nexit 42\n");
    chmodSync(join(seed, "install.sh"), 0o755);
  } else if (rebuildFailure === "skills") {
    write(join(seed, "harness/skills/demo/SKILL.md"), "v2\n");
    write(join(seed, "harness/scripts/install-skills.sh"), "#!/bin/sh\nprintf 'skills\\n' >> \"$RUBATO_TEST_TRACE\"\nexit 42\n");
    chmodSync(join(seed, "harness/scripts/install-skills.sh"), 0o755);
  }
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "remote"]);
  git(seed, ["push", "origin", "rubato/base"]);

  write(join(local, "extra.txt"), "local-only\n");
  git(local, ["add", "extra.txt"]);
  git(local, ["commit", "-m", "local-only"]);
  const localOnly = git(local, ["rev-parse", "HEAD"]).stdout.trim();

  let decoySha = "";
  if (decoyStash) {
    write(join(local, "decoy.txt"), "decoy\n");
    git(local, ["add", "decoy.txt"]);
    git(local, ["stash", "push", "--include-untracked", "--message", "rubato-update 1"]);
    decoySha = git(local, ["rev-parse", "refs/stash"]).stdout.trim();
  }
  if (dirty) {
    write(join(local, "keep.txt"), "keep dirty\n");
    write(join(local, "scratch.txt"), "scratch\n");
  }
  if (conflict) {
    write(join(local, "note.txt"), "local-wip\n");
  }
  if (evidence) {
    write(join(local, ".rubato/evidence/log.txt"), "evidence-dirty\n");
  }

  const dest = join(local, "harness/scripts/rubato-update.sh");
  const trace = join(root, "rebuild.trace");
  return { root, local, home, dest, localOnly, decoySha, trace };
}

function runUpdate(fixture, { path = process.env.PATH } = {}) {
  return spawnSync("sh", [fixture.dest, "--yes"], {
    cwd: fixture.local,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      GIT_OK: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      PATH: path,
      RUBATO_TEST_TRACE: fixture.trace,
    },
  });
}

function fakePath(fixture, commands) {
  const bin = join(fixture.root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(commands)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return `${bin}:${process.env.PATH}`;
}

function backupBranch(local) {
  const listed = git(local, ["for-each-ref", "--format=%(refname:short)", "refs/heads/rubato/update-backup-*"]).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(listed.length, 1, `expected one backup branch, got ${listed.join(",") || "(none)"}`);
  return listed[0];
}

test("unattended update refreshes bundled skills that still match the previous bundle", () => {
  const fixture = setupFixture({ skillUpdate: true });
  const result = runUpdate(fixture);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, out);
  assert.equal(readFileSync(join(fixture.home, ".agents/skills/demo/SKILL.md"), "utf8"), "v2\n");
  assert.match(out, /번들 스킬/);
});

test("unattended update keeps a locally edited bundled skill", () => {
  const fixture = setupFixture({ skillUpdate: true });
  write(join(fixture.home, ".agents/skills/demo/SKILL.md"), "hand-edited\n");
  const result = runUpdate(fixture);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, out);
  assert.equal(readFileSync(join(fixture.home, ".agents/skills/demo/SKILL.md"), "utf8"), "hand-edited\n");
});

test("unattended update hard-resets a diverged rubato/base and keeps local commits on a backup branch", () => {
  const fixture = setupFixture();
  const result = runUpdate(fixture);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, out);

  const head = git(fixture.local, ["rev-parse", "HEAD"]).stdout.trim();
  const remote = git(fixture.local, ["rev-parse", "origin/rubato/base"]).stdout.trim();
  const branch = git(fixture.local, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  assert.equal(branch, "rubato/base");
  assert.equal(head, remote);

  const backup = backupBranch(fixture.local);
  assert.match(backup, /^rubato\/update-backup-\d{14}-\d+$/);
  git(fixture.local, ["merge-base", "--is-ancestor", fixture.localOnly, backup]);
  assert.equal(git(fixture.local, ["status", "--porcelain"]).stdout, "");
  assert.equal(git(fixture.local, ["stash", "list"]).stdout, "");
  assert.match(out, new RegExp(`git log --oneline origin/rubato/base\\.\\.${backup.replaceAll("/", "\\/")}`));
  assert.match(out, new RegExp(`git cherry-pick origin/rubato/base\\.\\.${backup.replaceAll("/", "\\/")}`));
});

test("unattended update restores non-conflicting dirty and untracked work after divergence", () => {
  const fixture = setupFixture({ dirty: true });
  const result = runUpdate(fixture);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, out);

  const head = git(fixture.local, ["rev-parse", "HEAD"]).stdout.trim();
  const remote = git(fixture.local, ["rev-parse", "origin/rubato/base"]).stdout.trim();
  assert.equal(head, remote);
  assert.equal(readFileSync(join(fixture.local, "note.txt"), "utf8"), "remote\n");
  assert.equal(readFileSync(join(fixture.local, "keep.txt"), "utf8"), "keep dirty\n");
  assert.equal(readFileSync(join(fixture.local, "scratch.txt"), "utf8"), "scratch\n");

  const backup = backupBranch(fixture.local);
  git(fixture.local, ["merge-base", "--is-ancestor", fixture.localOnly, backup]);
});

test("restoration conflict is nonzero, skips rebuild, and prints drop from the unmerged tree", () => {
  const fixture = setupFixture({ dirty: true, conflict: true });
  const result = runUpdate(fixture);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /재빌드는 하지 않습니다/);
  assert.doesNotMatch(out, /업데이트를 마쳤습니다/);
  assert.doesNotMatch(out, /git stash pop/);

  const head = git(fixture.local, ["rev-parse", "HEAD"]).stdout.trim();
  const remote = git(fixture.local, ["rev-parse", "origin/rubato/base"]).stdout.trim();
  assert.equal(head, remote);
  assert.ok(backupBranch(fixture.local));

  assert.match(out, /git status/);
  assert.match(out, /git add -u/);
  const drop = out.match(/git stash drop (stash@\{\d+\})/);
  assert.ok(drop, `missing stash drop command in:\n${out}`);
  assert.match(out, /[0-9a-f]{40}/);

  const stashes = git(fixture.local, ["stash", "list"]).stdout;
  assert.match(stashes, /rubato-update /);
  assert.match(stashes, new RegExp(drop[1].replace(/[{}]/g, "\\$&")));
  const unmerged = git(fixture.local, ["ls-files", "-u"]).stdout;
  assert.match(unmerged, /note\.txt/);
});

test("tracked dirty .rubato/evidence survives a diverged hard reset", () => {
  const fixture = setupFixture({ evidence: true });
  const result = runUpdate(fixture);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, out);

  const head = git(fixture.local, ["rev-parse", "HEAD"]).stdout.trim();
  const remote = git(fixture.local, ["rev-parse", "origin/rubato/base"]).stdout.trim();
  assert.equal(head, remote);
  assert.equal(readFileSync(join(fixture.local, ".rubato/evidence/log.txt"), "utf8"), "evidence-dirty\n");
  assert.ok(backupBranch(fixture.local));
  git(fixture.local, ["merge-base", "--is-ancestor", fixture.localOnly, backupBranch(fixture.local)]);
});

test("updater pops only the stash it created when a substring decoy is already on the stack", () => {
  const fixture = setupFixture({ dirty: true, decoyStash: true });
  const result = runUpdate(fixture);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, out);

  assert.equal(readFileSync(join(fixture.local, "keep.txt"), "utf8"), "keep dirty\n");
  assert.equal(readFileSync(join(fixture.local, "scratch.txt"), "utf8"), "scratch\n");
  assert.equal(existsSync(join(fixture.local, "decoy.txt")), false);

  const stashes = git(fixture.local, ["stash", "list", "--format=%H %gs"]).stdout;
  assert.match(stashes, new RegExp(`^${fixture.decoySha} `, "m"));
  assert.equal(stashes.trim().split("\n").length, 1);
});

for (const failure of [
  { kind: "deps", commands: { bun: "printf 'deps\\n' >> \"$RUBATO_TEST_TRACE\"\nexit 42", npm: "exit 0" }, message: /bun install 에 실패/ },
  { kind: "engine", commands: { bun: "exit 0", node: "printf 'engine\\n' >> \"$RUBATO_TEST_TRACE\"\nexit 42" }, message: /엔진 빌드에 실패/ },
  { kind: "prompts", commands: {}, message: /시스템 프롬프트 합성에 실패/ },
  { kind: "shell", commands: {}, message: /셸 설정 갱신에 실패/ },
  { kind: "skills", commands: {}, message: /번들 스킬 설치에 실패/ },
]) {
  test(`update fails closed when ${failure.kind} regeneration fails`, () => {
    const fixture = setupFixture({ rebuildFailure: failure.kind });
    const result = runUpdate(fixture, { path: fakePath(fixture, failure.commands) });
    const out = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, out);
    assert.match(out, failure.message);
    assert.equal(readFileSync(fixture.trace, "utf8"), `${failure.kind}\n`, `fixture did not intercept ${failure.kind}`);
    assert.doesNotMatch(out, /업데이트를 마쳤습니다/);
    assert.equal(git(fixture.local, ["rev-parse", "HEAD"]).stdout, git(fixture.local, ["rev-parse", "origin/rubato/base"]).stdout);
  });
}
