import { homedir } from "node:os";
import { join } from "node:path";
import { senpiSkillsModule } from "./engine-paths.mjs";

// Senpi's package exports map does not publish `dist/core/skills.js`, so we
// resolve it by path. engine-paths.mjs owns where the engine lives.
const senpiSkills = senpiSkillsModule;
const { formatSkillsForPrompt, loadSkillsFromDir } = await import(senpiSkills);

// We build the skill listing ourselves instead of letting Senpi append it.
//
// launch.mjs hands Senpi a finished `--system-prompt`, which is what keeps the
// stock Senpi prompt from ever standing up. The cost is that Senpi never gets
// the chance to add its own skill section, so a session could not see which
// skills exist — only the two named in the contract-skills message. Dropping
// the `--system-prompt` flag would hand that job back to Senpi and let the
// stock prompt through, so we read the same directories through Senpi's own
// loader and format the section with Senpi's own formatter.
export const SKILL_DIRS = Object.freeze([
  { dir: join(homedir(), ".agents", "skills"), source: "agents" },
  { dir: join(homedir(), ".rubato-pi", "agent", "skills"), source: "pi" },
]);

export function loadSkillEntries(dirs = SKILL_DIRS, { load = loadSkillsFromDir } = {}) {
  const byName = new Map();
  for (const { dir, source } of dirs) {
    let result;
    try {
      result = load({ dir, source });
    } catch {
      continue;
    }
    for (const skill of result?.skills ?? []) {
      // First directory wins, so a project skill never shadows a user one by
      // accident; SKILL_DIRS order is the precedence.
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsSection(dirs = SKILL_DIRS, hooks = {}) {
  const skills = loadSkillEntries(dirs, hooks);
  if (skills.length === 0) return "";
  const format = hooks.format ?? formatSkillsForPrompt;
  return format(skills).trim();
}
