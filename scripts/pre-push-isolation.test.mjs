import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url).pathname;

test("pre-push removes the caller repository binding before running tests", () => {
  const root = mkdtempSync(join(tmpdir(), "rubato-pre-push-isolation-"));
  mkdirSync(join(root, ".githooks"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(repoRoot, ".githooks", "pre-push"), join(root, ".githooks", "pre-push"));
  chmodSync(join(root, ".githooks", "pre-push"), 0o755);
  writeFileSync(
    join(root, "scripts", "ci-local.sh"),
    `#!/bin/sh
if env | grep -Eq '^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR)='; then
  env | grep -E '^GIT_' >&2
  exit 41
fi
`,
  );
  chmodSync(join(root, "scripts", "ci-local.sh"), 0o755);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);

  const result = spawnSync(join(root, ".githooks", "pre-push"), {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_DIR: join(root, ".git"),
      GIT_WORK_TREE: root,
    },
  });

  assert.equal(result.status, 0, result.stderr);
});
