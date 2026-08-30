import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/install-skills.sh");

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function run(repo, dest, args = [], stamp) {
  return spawnSync("bash", [join(repo, "harness/scripts/install-skills.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTS_SKILLS_DIR: dest,
      HOME: dest,
      ...(stamp ? { RUBATO_SKILLS_STAMP: stamp } : {}),
    },
  });
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "install-skills-"));
  const repo = join(root, "repo");
  const dest = join(root, "agents");
  mkdirSync(repo);
  git(repo, ["init", "-b", "rubato/base"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  write(join(repo, "harness/scripts/install-skills.sh"), readFileSync(SCRIPT, "utf8"));
  chmodSync(join(repo, "harness/scripts/install-skills.sh"), 0o755);
  write(join(repo, "harness/skills/demo/SKILL.md"), "v1\n");
  write(join(repo, "harness/skills/other/SKILL.md"), "other-v1\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "v1"]);
  const oldRev = git(repo, ["rev-parse", "HEAD"]);
  write(join(repo, "harness/skills/demo/SKILL.md"), "v2\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "v2"]);
  return { root, repo, dest, oldRev };
}

test("첫 설치는 없는 스킬만 넣는다", () => {
  const { repo, dest } = setupRepo();
  write(join(dest, "demo/SKILL.md"), "local\n");
  const result = run(repo, dest);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dest, "demo/SKILL.md"), "utf8"), "local\n");
  assert.equal(readFileSync(join(dest, "other/SKILL.md"), "utf8"), "other-v1\n");
  assert.match(result.stdout, /새로 1/);
  assert.match(result.stdout, /로컬 유지 1/);
});

test("업데이트는 이전 번들과 같은 설치본만 갱신한다", () => {
  const { repo, dest, oldRev, root } = setupRepo();
  const stamp = join(root, "skills-head");
  write(join(dest, "demo/SKILL.md"), "v1\n");
  write(join(dest, "other/SKILL.md"), "hand-edited\n");
  const result = run(repo, dest, ["--sync-from", oldRev], stamp);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dest, "demo/SKILL.md"), "utf8"), "v2\n");
  assert.equal(readFileSync(join(dest, "other/SKILL.md"), "utf8"), "hand-edited\n");
  assert.match(result.stdout, /갱신 1/);
  assert.match(result.stdout, /로컬 유지 1/);
  assert.equal(readFileSync(stamp, "utf8").trim(), git(repo, ["rev-parse", "HEAD"]));
});

test("이미 새 번들과 같으면 그대로 둔다", () => {
  const { repo, dest, oldRev } = setupRepo();
  write(join(dest, "demo/SKILL.md"), "v2\n");
  write(join(dest, "other/SKILL.md"), "other-v1\n");
  const result = run(repo, dest, ["--sync-from", oldRev]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dest, "demo/SKILL.md"), "utf8"), "v2\n");
  assert.match(result.stdout, /이미 최신 2/);
});

test("--force 는 로컬 수정도 덮는다", () => {
  const { repo, dest } = setupRepo();
  write(join(dest, "demo/SKILL.md"), "local\n");
  const result = run(repo, dest, ["--force"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dest, "demo/SKILL.md"), "utf8"), "v2\n");
  assert.match(result.stdout, /갱신 1/);
});
