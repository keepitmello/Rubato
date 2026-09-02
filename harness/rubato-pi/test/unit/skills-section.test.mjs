import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSkillsForPrompt, loadSkillEntries, parseSkillFrontmatter, skillsSection } from "../../src/skills-section.mjs";

test("frontmatter parser keeps name, description, and invocation flag", () => {
  const fields = parseSkillFrontmatter(`---
name: demo
description: "Does a thing"
disable-model-invocation: true
---
# body
`);
  assert.deepEqual(fields, {
    name: "demo",
    description: "Does a thing",
    "disable-model-invocation": true,
  });
});

test("skillsSection lists SKILL.md files without importing senpi", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-section-"));
  mkdirSync(join(root, "visible"), { recursive: true });
  mkdirSync(join(root, "hidden"), { recursive: true });
  writeFileSync(join(root, "visible", "SKILL.md"), `---
name: visible
description: Shown in the prompt
---
`);
  writeFileSync(join(root, "hidden", "SKILL.md"), `---
name: hidden
description: Command only
disable-model-invocation: true
---
`);
  const skills = loadSkillEntries([{ dir: root, source: "agents" }]);
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ["hidden", "visible"]);
  const section = skillsSection([{ dir: root, source: "agents" }]);
  assert.match(section, /<name>visible<\/name>/);
  assert.match(section, /<location>/);
  assert.doesNotMatch(section, /hidden/);
  assert.match(formatSkillsForPrompt(skills), /<available_skills>/);
});
