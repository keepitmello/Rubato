export function inlineSlashTokenAt(textBeforeCursor) {
  const match = textBeforeCursor.match(/(?:^|\s)(\/[^\s/]*)$/);
  return match?.[1] ?? null;
}

export function isInlineDollarToken(textBeforeCursor) {
  return /(?:^|\s)\$[a-zA-Z0-9:_-]*$/.test(textBeforeCursor);
}

const SKILL_COMMAND_PREFIX = "skill:";
const LEADING_DOLLAR_RUN_PATTERN = /^((?:\$[a-zA-Z][a-zA-Z0-9:_-]*\s+)*)\$([a-zA-Z0-9:_-]*)$/;
const INLINE_DOLLAR_PATTERN = /(?:^|\s)\$([a-zA-Z0-9:_-]*)$/;

function commandName(command) {
  return "name" in command ? command.name : command.value;
}

function skillName(name) {
  if (!name.startsWith(SKILL_COMMAND_PREFIX)) return null;
  const value = name.slice(SKILL_COMMAND_PREFIX.length);
  return value || null;
}

function commandDescription(command) {
  const hint = "argumentHint" in command && command.argumentHint ? command.argumentHint : undefined;
  const description = command.description ?? "";
  if (hint) return description ? `${hint} — ${description}` : hint;
  return description || undefined;
}

export function getDollarInvocationContext(textBeforeCursor, cursorLine, commands) {
  const match = cursorLine === 0 ? textBeforeCursor.match(LEADING_DOLLAR_RUN_PATTERN) : null;
  if (!match) {
    const inline = textBeforeCursor.match(INLINE_DOLLAR_PATTERN);
    if (!inline) return null;
    const raw = inline[1];
    const explicit = raw.startsWith(SKILL_COMMAND_PREFIX);
    return {
      prefix: `$${raw}`,
      query: explicit ? raw.slice(SKILL_COMMAND_PREFIX.length) : raw,
      skillsOnly: true,
    };
  }
  const knownSkills = new Set(commands.flatMap((command) => {
    const name = skillName(commandName(command));
    return name ? [name] : [];
  }));
  const precedingSkills = match[1]
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.slice(1))
    .map((name) => (name.startsWith(SKILL_COMMAND_PREFIX) ? name.slice(SKILL_COMMAND_PREFIX.length) : name));
  if (precedingSkills.some((name) => !knownSkills.has(name))) return null;
  const rawQuery = match[2];
  const explicitSkillNamespace = rawQuery.startsWith(SKILL_COMMAND_PREFIX);
  return {
    prefix: `$${rawQuery}`,
    query: explicitSkillNamespace ? rawQuery.slice(SKILL_COMMAND_PREFIX.length) : rawQuery,
    skillsOnly: precedingSkills.length > 0 || explicitSkillNamespace,
  };
}

export function getDollarInvocationSuggestions(commands, query, skillsOnly, fuzzyFilter) {
  const items = commands.flatMap((command) => {
    const name = commandName(command);
    const skill = skillName(name);
    if (skill) {
      return [{
        kind: "skill",
        value: `$${skill}`,
        label: `$${skill}`,
        searchText: skill,
        description: commandDescription(command),
      }];
    }
    if (skillsOnly) return [];
    return [{
      kind: "command",
      value: `/${name}`,
      label: `/${name}`,
      searchText: name,
      description: commandDescription(command),
    }];
  });
  return fuzzyFilter(items, query, (item) => item.searchText)
    .map((item, index) => ({ ...item, index }))
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "command" ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ index: _index, kind: _kind, searchText: _searchText, ...item }) => item);
}

export function getInlineSkillSuggestions(commands, query, fuzzyFilter) {
  const skillCommands = commands.filter((command) => commandName(command).startsWith(SKILL_COMMAND_PREFIX));
  const commandItems = skillCommands.map((cmd) => {
    const name = commandName(cmd);
    const desc = commandDescription(cmd);
    return { name, label: name, description: desc, searchText: name };
  });
  return fuzzyFilter(commandItems, query, (item) => item.searchText).map((item) => ({
    value: item.name,
    label: item.label,
    ...(item.description && { description: item.description }),
  }));
}
