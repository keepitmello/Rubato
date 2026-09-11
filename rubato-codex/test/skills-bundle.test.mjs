import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, "..");
const skillsRoot = path.join(packageDir, "skills");
const manifest = JSON.parse(await readFile(path.join(packageDir, "skill-bundle.json"), "utf8"));
const outputName = (sourceName) => manifest.renames[sourceName] ?? sourceName;
const sourceRoot = path.resolve(packageDir, manifest.source);
const excluded = manifest.excludedPatterns.map((pattern) => new RegExp(pattern));

async function walk(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `bundle contains symlink: ${child}`);
    if (entry.isDirectory()) files.push(...await walk(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

test("manifest-driven bundle is deterministic and current", () => {
  const output = execFileSync(process.execPath, [
    path.join(packageDir, "scripts/build-skills.mjs"),
    "--check",
  ], { encoding: "utf8" });
  assert.match(output, /25 source skills accounted for/);
});

test("rebuilding common skills cannot overwrite Codex-owned operating skills or references", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "codex-skill-ownership-"));
  try {
    await mkdir(path.join(fixture, "scripts"));
    await copyFile(path.join(packageDir, "scripts/build-skills.mjs"), path.join(fixture, "scripts/build-skills.mjs"));
    await writeFile(path.join(fixture, "skill-bundle.json"), JSON.stringify({ ...manifest, source: sourceRoot }));
    const expected = new Map();
    for (const name of manifest.preserved) {
      for (const relative of ["SKILL.md", "references/01-operating-model.md"]) {
        const file = path.join(fixture, "skills", name, relative);
        await mkdir(path.dirname(file), { recursive: true });
        const content = `Codex-owned ${name}/${relative}: must survive regeneration\n`;
        await writeFile(file, content);
        expected.set(file, content);
      }
    }
    execFileSync(process.execPath, [path.join(fixture, "scripts/build-skills.mjs")], { encoding: "utf8" });
    for (const [file, content] of expected) assert.equal(await readFile(file, "utf8"), content);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("every installed skill is a real directory with valid frontmatter", async () => {
  const expected = [
    ...manifest.managed.map(outputName),
    ...manifest.conditional.map(outputName),
    ...manifest.preserved.map(outputName),
    ...manifest.nativeOnly,
  ].sort();
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const actual = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(actual, expected);

  for (const name of actual) {
    const text = await readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8");
    assert.match(text, /^---\n[\s\S]*?\n---\n/, `${name}: missing YAML frontmatter`);
    assert.match(text, new RegExp(`^name: ["']?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?$`, "m"));
    assert.match(text, /^description:/m, `${name}: missing description`);
  }
});

test("bundle omits local residue, private absolute paths, and credential material", async () => {
  const files = await walk(skillsRoot);
  for (const relative of files) {
    assert.doesNotMatch(relative, /(^|\/)(__pycache__|observations)(\/|$)|\.pyc$|\.DS_Store$|\.bak-|\.log$|~$/);
    const data = await readFile(path.join(skillsRoot, relative));
    if (data.includes(0)) continue;
    const text = data.toString("utf8");
    assert.doesNotMatch(text, /\/Users\/wy(?:\/|\b)/, `${relative}: private absolute path`);
    assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, `${relative}: private key`);
  }
});

test("Codex adaptations remove Claude setup and preserve native runtime boundaries", async () => {
  const insane = await readFile(path.join(skillsRoot, "insane-search/SKILL.md"), "utf8");
  assert.doesNotMatch(insane, /CLAUDE_PLUGIN_ROOT|STAR_ASK|AskUserQuestion/);
  assert.match(insane, /런타임이 실제로 제공하는 브라우저 도구/);

  for (const name of manifest.conditional) {
    const text = await readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8");
    assert.match(text, /Codex/, `${name}: missing Codex native-runtime boundary`);
  }
});

test("generated Markdown avoids conflict-marker lookalikes", async () => {
  const journey = await readFile(path.join(
    skillsRoot,
    "frontend-ux-router/references/software-ux-research/references/customer-journey-mapping.md",
  ), "utf8");
  assert.doesNotMatch(journey, /^={7}(?: |$)/m);
  assert.match(journey, /^------- LINE OF INTERACTION -------$/m);
});

test("all bundled Markdown references resolve inside each package", async () => {
  for (const sourceName of [...manifest.managed, ...manifest.conditional]) {
    const name = outputName(sourceName);
    const packageRoot = path.join(skillsRoot, name);
    for (const relative of (await walk(packageRoot)).filter((file) => file.endsWith(".md"))) {
      const markdownPath = path.join(packageRoot, relative);
      const text = await readFile(markdownPath, "utf8");
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1].split("#", 1)[0];
        if (!target || /^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
        const resolved = path.resolve(path.dirname(markdownPath), decodeURIComponent(target));
        assert.ok(resolved.startsWith(`${packageRoot}${path.sep}`), `${name}: link escapes package: ${target}`);
        await readFile(resolved);
      }
    }
  }
});

test("safe source scripts retain executable permission", async () => {
  for (const sourceName of [...manifest.managed, ...manifest.conditional]) {
    const sourcePackage = path.join(sourceRoot, sourceName);
    const destinationPackage = path.join(skillsRoot, outputName(sourceName));
    for (const relative of await walk(sourcePackage)) {
      const normalized = relative.split(path.sep).join("/");
      if (excluded.some((pattern) => pattern.test(normalized))) continue;
      const sourceMode = (await stat(path.join(sourcePackage, relative))).mode & 0o111;
      if (sourceMode === 0) continue;
      const destinationMode = (await stat(path.join(destinationPackage, relative))).mode & 0o111;
      assert.equal(destinationMode, sourceMode, `${sourceName}/${relative}: executable mode drifted`);
    }
  }
});
