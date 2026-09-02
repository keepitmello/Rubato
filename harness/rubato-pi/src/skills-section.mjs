import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// The wrapper process used to `await import` senpi's skills.js just to list
// names for `--system-prompt`. That pulled the engine graph into the parent
// (~500ms) before senpi even spawned. Senpi still loads the same directories
// via `--skill` for the TUI; this file only needs name/description/location.

export const SKILL_DIRS = Object.freeze([
  { dir: join(homedir(), ".agents", "skills"), source: "agents" },
  { dir: join(homedir(), ".rubato-pi", "agent", "skills"), source: "pi" },
]);

function unescapeQuoted(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseSkillFrontmatter(raw) {
  const text = String(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n") && text !== "---") return {};
  const end = text.indexOf("\n---", 4);
  if (end < 0) return {};
  const fields = {};
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^(name|description|disable-model-invocation):\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = unescapeQuoted(match[2].trim());
    fields[match[1]] = match[1] === "disable-model-invocation" ? value === "true" : value;
  }
  return fields;
}

function walkSkillFiles(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSkillFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") files.push(fullPath);
  }
  return files;
}

export function loadSkillFromPath(filePath, source = "agents") {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  const fields = parseSkillFrontmatter(raw);
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!description) return undefined;
  const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : basename(dirname(filePath));
  return {
    name,
    description,
    filePath,
    source,
    disableModelInvocation: fields["disable-model-invocation"] === true,
  };
}

export function loadSkillEntries(dirs = SKILL_DIRS, { load } = {}) {
  if (load) {
    const byName = new Map();
    for (const { dir, source } of dirs) {
      let result;
      try {
        result = load({ dir, source });
      } catch {
        continue;
      }
      for (const skill of result?.skills ?? []) {
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  const byName = new Map();
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const filePath of walkSkillFiles(dir)) {
      const skill = loadSkillFromPath(filePath, source);
      if (skill && !byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function formatSkillsForPrompt(skills) {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file whenever its description even loosely matches the task - loading an irrelevant skill costs little; missing a relevant one degrades the work.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function skillsSection(dirs = SKILL_DIRS, hooks = {}) {
  const skills = loadSkillEntries(dirs, hooks);
  if (skills.length === 0) return "";
  const format = hooks.format ?? formatSkillsForPrompt;
  return format(skills).trim();
}
