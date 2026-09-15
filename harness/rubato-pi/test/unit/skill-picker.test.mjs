import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../scripts/skill-picker.py",
);
const SKILLS_SECTION = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../src/skills-section.mjs",
);

function writeSkill(root, name, description) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`,
	);
}

function runCheck(home) {
	return spawnSync("python3", [SCRIPT, "--check"], {
		encoding: "utf8",
		env: { ...process.env, HOME: home },
	});
}

function runtimeCatalog(home) {
	const moduleUrl = pathToFileURL(SKILLS_SECTION).href;
	return spawnSync(
		"node",
		[
			"--input-type=module",
			"-e",
			`import { loadSkillEntries, skillsSection } from ${JSON.stringify(moduleUrl)};
const entries = loadSkillEntries();
console.log(JSON.stringify({
  line: \`\${entries.length} skills, \${Buffer.byteLength(skillsSection())} prompt bytes\`,
  alphaDescription: entries.find((skill) => skill.name === "alpha")?.description,
}));`,
		],
		{
			encoding: "utf8",
			env: { ...process.env, HOME: home },
		},
	);
}

test("--check는 실제 세션의 스킬 안내문과 같은 결과를 낸다", () => {
	const home = mkdtempSync(join(tmpdir(), "skill-picker-"));
	const agents = join(home, ".agents/skills");
	const secondary = join(home, ".rubato-pi/agent/skills");
	writeSkill(agents, "alpha", "사용자 스킬");
	writeSkill(agents, "gamma", "사용자 전용 스킬");
	writeSkill(secondary, "alpha", "이름이 겹쳐 가려지는 두 번째 경로 스킬");
	writeSkill(secondary, "beta", "두 번째 경로 스킬");

	const result = runCheck(home);
	const runtime = runtimeCatalog(home);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(runtime.status, 0, runtime.stderr);
	const expected = JSON.parse(runtime.stdout);
	assert.match(result.stdout, /^3 skills, \d+ prompt bytes$/m);
	assert.equal(result.stdout, `${expected.line}\n`);
	assert.equal(expected.alphaDescription, "사용자 스킬");
	assert.equal(result.stderr, "");
});
