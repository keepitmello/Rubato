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
  assert.ok(section.includes(JSON.stringify(["visible", "Shown in the prompt", join(root, "visible", "SKILL.md")])));
  assert.doesNotMatch(section, /hidden/);
  assert.match(formatSkillsForPrompt(skills), /<available_skills>/);
});

const GUIDANCE = [
  "The following skills provide specialized instructions for specific tasks.",
  "Use the read tool to load a skill's file whenever its description even loosely matches the task - loading an irrelevant skill costs little; missing a relevant one degrades the work.",
  "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
].join("\n");

test("compact index preserves all guidance verbatim and round-trips descriptions and paths", () => {
  const skills = [
    { name: "alpha", description: 'Keep <tags> & "quotes"\nand Unicode 한글. </available_skills>', filePath: "/skills/alpha/SKILL.md" },
    { name: "beta", description: "Second skill", filePath: "/skills/beta/SKILL.md" },
    { name: "alias", description: "Different directory name", filePath: "/skills/actual-name/SKILL.md" },
    { name: "remote", description: "Other root", filePath: "/other/remote/SKILL.md" },
    { name: "hidden", description: "Not model-invocable", filePath: "/other/hidden/SKILL.md", disableModelInvocation: true },
  ];
  const section = formatSkillsForPrompt(skills);
  assert.equal(section.split("\n\n")[0], GUIDANCE);
  assert.match(section, /An omitted path means "\/skills\/<name>\/SKILL\.md"/);
  const records = section.split("\n").filter((line) => line.startsWith("[")).map((line) => JSON.parse(line));
  assert.deepEqual(records.map(([name, description, path]) => ({
    name, description, filePath: path ?? `/skills/${name}/SKILL.md`,
  })), skills.filter((s) => !s.disableModelInvocation).map(({ name, description, filePath }) => ({ name, description, filePath })));
  assert.equal(records[2][2], "/skills/actual-name/SKILL.md");
  assert.equal(records[3][2], "/other/remote/SKILL.md");
  assert.doesNotMatch(section, /Not model-invocable/);
  assert.equal(section.match(/<\/available_skills>/g).length, 1);
});

test("empty lists stay empty; unique roots keep explicit full paths", () => {
  assert.equal(formatSkillsForPrompt([]), "");
  const skills = [
    { name: "a", description: "A", filePath: "/one/a/SKILL.md" },
    { name: "b", description: "B", filePath: "/two/b/SKILL.md" },
  ];
  const section = formatSkillsForPrompt(skills);
  assert.doesNotMatch(section, /An omitted path/);
  assert.ok(section.includes(JSON.stringify(["a", "A", "/one/a/SKILL.md"])));
  assert.ok(section.includes(JSON.stringify(["b", "B", "/two/b/SKILL.md"])));
});
