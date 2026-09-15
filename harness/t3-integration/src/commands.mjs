// T3's composer menu reads ServerProvider.slashCommands / .skills.
// Pi's catalogue already returns get_commands (extensions, prompt templates,
// skills). Terminal-layer commands are not in that list; we add the ones we
// can both execute and report back to T3.

/** TUI / session-lifecycle names we will not put in the composer menu. */
const HIDDEN = new Set([
  'model', 'thinking', 'fork', 'clone', 'new', 'resume', 'session', 'tree',
  'settings', 'login', 'logout', 'quit', 'hotkeys', 'changelog', 'copy',
  'share', 'export', 'import', 'trust', 'scoped-models', 'debug',
]);

/** Control commands the bridge intercepts instead of prompting. */
export const CONTROL = {
  compact: {
    description: 'Summarize the conversation and reduce context',
    input: { hint: 'optional instructions' },
    command: (args) => ({ type: 'compact', ...(args ? { customInstructions: args } : {}) }),
  },
  name: {
    description: "Set this conversation's display name",
    input: { hint: 'new name' },
    command: (args) => ({ type: 'set_session_name', name: args }),
  },
  reload: {
    description: 'Reload extensions, skills, prompts, and context files',
    command: () => ({ type: 'reload' }),
  },
};

// Same token shape T3 chips and ClaudeSkillDispatch recognise, so a listed
// skill and a dispatched skill stay the same set. Pi expands `/skill:name`,
// not T3's `$name`.
const SKILL_MENTION = /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;

const nonempty = (value) => {
  if (typeof value !== 'string') return;
  const text = value.trim();
  return text ? text : undefined;
};

export function surfaceFromPiCommands(commands = []) {
  const slashCommands = Object.entries(CONTROL).map(([name, spec]) => ({
    name, description: spec.description, ...(spec.input ? { input: spec.input } : {}),
  }));
  const seen = new Set(slashCommands.map((item) => item.name));
  const skills = [];
  const skillNames = new Set();
  for (const command of commands) {
    const raw = nonempty(command?.name);
    if (!raw) continue;
    if (command.source === 'skill') {
      const name = raw.startsWith('skill:') ? raw.slice('skill:'.length) : raw;
      const path = nonempty(command.sourceInfo?.path) || nonempty(command.path);
      if (!name || !path || skillNames.has(name)) continue;
      skillNames.add(name);
      skills.push({
        name, path, enabled: true,
        ...(nonempty(command.description) ? { description: command.description, shortDescription: command.description } : {}),
        ...(nonempty(command.sourceInfo?.scope) ? { scope: command.sourceInfo.scope } : {}),
        displayName: name,
      });
      continue;
    }
    if (seen.has(raw) || HIDDEN.has(raw)) continue;
    seen.add(raw);
    slashCommands.push({
      name: raw,
      ...(nonempty(command.description) ? { description: command.description } : {}),
    });
  }
  return { slashCommands, skills, skillNames };
}

export function parseLeadingSlash(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed.startsWith('/')) return;
  const space = trimmed.indexOf(' ');
  const name = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
  if (!name) return;
  const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
  return { name, args };
}

export function controlCommandFor(text) {
  const parsed = parseLeadingSlash(text);
  const spec = parsed && CONTROL[parsed.name];
  if (!spec) return;
  if (parsed.name === 'name' && !parsed.args) throw new Error('Session name cannot be empty');
  return { name: parsed.name, args: parsed.args, rpc: spec.command(parsed.args) };
}

export function rewriteSkillMentions(text, skillNames) {
  if (typeof text !== 'string' || text.length === 0 || !skillNames?.size) return text;
  SKILL_MENTION.lastIndex = 0;
  return text.replace(SKILL_MENTION, (whole, lead, name) => skillNames.has(name) ? `${lead}/skill:${name}` : whole);
}
