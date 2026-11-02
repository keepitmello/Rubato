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

test("aside tasks are handed off in the background and collected on completion", () => {
  const skill = readFileSync(bundled, "utf8");
  assert.match(skill, /run_in_background: true/);
  assert.match(skill, /Do not poll in between/);
  assert.doesNotMatch(skill, /status update around every 60 seconds/);
});

test("aside handles logins and security checks itself", () => {
  const skill = readFileSync(bundled, "utf8");
  assert.match(skill, /clears security checks and CAPTCHAs itself/);
});
