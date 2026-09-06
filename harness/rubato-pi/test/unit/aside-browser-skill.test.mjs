import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const bundled = join(import.meta.dirname, "../../../skills/aside-browser/SKILL.md");
const installed = join(homedir(), ".agents/skills/aside-browser/SKILL.md");

function assertAccountPolicy(skill, label) {
  assert.doesNotMatch(
    skill,
    /This file is only an entry point/,
    `${label} is the Aside CLI guide stub`,
  );
  assert.doesNotMatch(
    skill,
    /MUST run `aside guide`/,
    `${label} defers to aside guide, which examples -m openai/gpt-5.6-sol`,
  );
  assert.match(skill, /Omit `-m`/);
  assert.match(skill, /Never pass `openai\/gpt-5\.6-sol`/);
  assert.match(skill, /Grok 4\.6/);
  assert.match(skill, /Default, Fast, Standard, Deep, Visual/);
}

test("bundled aside-browser skill is account policy, not the Aside CLI stub", () => {
  assertAccountPolicy(readFileSync(bundled, "utf8"), "harness/skills/aside-browser");
});

test("installed aside-browser skill is not overwritten by the Aside CLI stub", () => {
  if (!existsSync(installed)) return;
  assertAccountPolicy(readFileSync(installed, "utf8"), "~/.agents/skills/aside-browser");
});
