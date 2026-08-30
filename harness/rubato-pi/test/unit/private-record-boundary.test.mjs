import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

test("세션 기록과 연구 문서는 public Rubato에 두지 않는다", () => {
  for (const path of [
    "cycles",
    "docs/rubato/rubato-independence-study.md",
    "docs/rubato/openai-invalid-prompt-incident.md",
  ]) {
    assert.equal(
      existsSync(join(repoRoot, path)),
      false,
      `${path}는 private Rubato-lab case-studies에 있어야 한다`,
    );
  }
});

test("wrapping skill은 Rubato 기록을 private lab에 쓴다", () => {
  const skill = readFileSync(
    join(repoRoot, "harness", "skills", "wrapping-sessions", "SKILL.md"),
    "utf8",
  );

  assert.match(skill, /case-studies\/cycles\/YYYY-MM\/wkN/);
  assert.match(skill, /--show-superproject-working-tree/);
  assert.match(skill, /public Rubato에 `cycles\/`를 만들지 말고/);
});
