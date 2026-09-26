import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Aside CLI rewrites every `aside-browser/SKILL.md` it finds with its own
// guide stub, so the bundle ships the account policy under `aside` instead.
const bundled = join(import.meta.dirname, "../../../skills/aside/SKILL.md");

test("bundled aside skill is account policy, not the Aside CLI stub", () => {
  const skill = readFileSync(bundled, "utf8");
  assert.match(skill, /^name: "aside"$/m);
  assert.doesNotMatch(skill, /This file is only an entry point/);
  assert.doesNotMatch(skill, /MUST run `aside guide`/);
});
