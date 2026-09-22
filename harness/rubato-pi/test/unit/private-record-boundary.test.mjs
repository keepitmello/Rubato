import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
