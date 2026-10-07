// How the thread should read a turn's work, decided where the facts live: the Pi
// message and tool call. The T3 timeline turns these into one live line while a
// group of calls runs ("Reading events.mjs", "Running npm test"), a summary once
// it is done ("Read files and ran commands"), and folds everything but the final
// answer when the turn ends. Only plain JSON leaves this file.

/** Pi's stopReason says how an assistant message ended. */
const COMMENTARY_STOPS = new Set(['toolUse']);
const FINAL_STOPS = new Set(['stop', 'length']);

const parseSignaturePhase = (signature) => {
  if (typeof signature !== 'string' || !signature.startsWith('{')) return;
  try {
    const parsed = JSON.parse(signature);
    return parsed?.phase === 'commentary' || parsed?.phase === 'final_answer' ? parsed.phase : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether an assistant message is a progress note between tool calls ("commentary")
 * or the answer the turn ends on ("final_answer"). OpenAI models say so themselves,
 * and Pi keeps it on the text block's signature; for every other model the way the
 * message ended decides: one that hands off to tools is commentary, one that just
 * stops is the answer. A message still streaming, failed or cut short has no phase.
 */
export function assistantPhaseOf(message) {
  if (message?.role !== 'assistant') return;
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block?.type !== 'text') continue;
    const phase = parseSignaturePhase(block.textSignature);
    if (phase) return phase;
  }
  if (COMMENTARY_STOPS.has(message.stopReason)) return 'commentary';
  if (FINAL_STOPS.has(message.stopReason)) return 'final_answer';
}

const string = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

// --- Shell commands -------------------------------------------------------
// Most reading and searching happens through bash (`sed -n`, `rg`, `ls`), so a
// command is split into its steps and each step classified, in the spirit of
// Codex's command parser (openai/codex, Apache-2.0). A command whose every step
// only reads, searches or lists is exploration; anything else runs.

/** Split on whitespace, honoring quotes and backslashes. Undefined when quoting is unbalanced. */
export function shellWords(text) {
  const words = [];
  let word = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < text.length) word += text[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === '\\' && index + 1 < text.length) { word += text[++index]; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) words.push(word);
      word = ''; started = false;
      continue;
    }
    word += char; started = true;
  }
  if (quote) return;
  if (started) words.push(word);
  return words;
}

/** Top-level steps joined by `&&`, `||`, `;` or newlines, each split into its pipeline. */
// Silencing or merging error output (`2>/dev/null`, `2>&1`) writes no file.
const QUIET_REDIRECT = /^(?:[012]?>>?|&>)\s*(?:\/dev\/null\b|&[12]\b)/;
function shellSteps(command) {
  const steps = [];
  let current = '';
  let quote = null;
  const pipeline = [];
  const endStage = () => { pipeline.push(current); current = ''; };
  const endStep = () => {
    endStage();
    const stages = pipeline.splice(0).map((stage) => stage.trim());
    if (stages.some(Boolean)) steps.push(stages);
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && next !== undefined) current += command[++index];
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === '\\' && next !== undefined) { current += char + command[++index]; continue; }
    if (char === '>' || (char === '&' && next === '>')) {
      const fd = /(?:^|\s)[012]$/.test(current) ? 1 : 0;
      const quiet = QUIET_REDIRECT.exec(command.slice(index - fd));
      if (quiet) {
        current = current.slice(0, current.length - fd);
        index += quiet[0].length - fd - 1;
        continue;
      }
    }
    if ((char === '&' && next === '&') || (char === '|' && next === '|')) { index++; endStep(); continue; }
    if (char === ';' || char === '\n') { endStep(); continue; }
    if (char === '|') { endStage(); continue; }
    // Substitution, redirection into files, backgrounding and heredocs do more
    // than look; such a command is just a command.
    if (char === '`' || (char === '$' && next === '(') || char === '>' || char === '<' || char === '&') return;
    current += char;
  }
  if (quote) return;
  endStep();
  return steps;
}

const READERS = new Set(['cat', 'head', 'tail', 'nl', 'less', 'more', 'bat', 'batcat', 'wc', 'file', 'stat']);
const SEARCHERS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'ast-grep', 'sg']);
const LISTERS = new Set(['ls', 'tree', 'exa', 'eza']);
// Stages after the first that only narrow or format what it printed.
const FILTERS = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'less', 'more', 'cat',
  'grep', 'rg', 'egrep', 'fgrep', 'sed', 'awk', 'jq']);
// Steps that set up the real one and do not change what the command is.
const NEUTRAL = new Set(['cd', 'pushd', 'popd', 'true', 'echo', 'printf', 'set', 'export', 'clear', 'pwd']);

const optionsAndOperands = (words) => {
  const operands = [];
  let afterDashes = false;
  for (const word of words) {
    if (!afterDashes && word === '--') { afterDashes = true; continue; }
    if (!afterDashes && word.startsWith('-') && word !== '-') continue;
    operands.push(word);
  }
  return operands;
};

// Options of the searchers that consume the next word, so it is not the pattern.
const SEARCH_VALUE_OPTIONS = new Set(['-e', '-f', '-g', '--glob', '-t', '--type', '-T', '--type-not', '-m',
  '--max-count', '-A', '-B', '-C', '--context', '--after-context', '--before-context', '--max-depth', '-d',
  '--include', '--exclude', '--exclude-dir', '-l', '--lang', '-p', '--pattern', '--color', '--colors', '--sort',
  '-M', '--max-columns', '-j', '--threads']);

function searchStep(words) {
  const [name, ...rest] = words;
  let pattern;
  const paths = [];
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index];
    if ((word === '-e' || word === '-p' || word === '--pattern' || word === '--regexp') && pattern === undefined) {
      pattern = rest[++index]; continue;
    }
    if (word.startsWith('--') && word.includes('=')) continue;
    if (SEARCH_VALUE_OPTIONS.has(word)) { index++; continue; }
    if (word.startsWith('-') && word !== '-') continue;
    if (pattern === undefined) pattern = word; else paths.push(word);
  }
  // `rg --files` lists rather than searches.
  if (name === 'rg' && rest.includes('--files')) return { kind: 'list', target: paths[0] ?? pattern };
  return { kind: 'search', ...(pattern ? { target: pattern } : {}), ...(paths[0] ? { path: paths[0] } : {}) };
}

function findStep(words) {
  const rest = words.slice(1);
  const root = rest.find((word) => !word.startsWith('-'));
  // find acts when told to; listing names only looks.
  if (rest.some((word) => ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fls'].includes(word))) return;
  const nameIndex = rest.findIndex((word) => ['-name', '-iname', '-path', '-ipath', '-regex', '-iregex'].includes(word));
  if (nameIndex >= 0 && rest[nameIndex + 1]) return { kind: 'search', target: rest[nameIndex + 1], ...(root ? { path: root } : {}) };
  return { kind: 'list', ...(root ? { target: root } : {}) };
}

function readStep(words) {
  const [name] = words;
  if (name === 'sed') {
    // Only `sed -n <range>p file`: printing lines is reading, any other script edits.
    if (!words.includes('-n') || words.some((word) => word === '-i' || word.startsWith('-i'))) return;
    const operands = optionsAndOperands(words.slice(1));
    const [script, ...files] = operands;
    if (!script || !/^[\d,$\s]*p$/.test(script.replace(/;/g, '')) || files.length === 0) return;
    return { kind: 'read', target: files.at(-1) };
  }
  if (READERS.has(name)) {
    const operands = optionsAndOperands(words.slice(1)).filter((word) => !/^\+?\d+$/.test(word));
    if (operands.length === 0) return;
    return { kind: 'read', target: operands.at(-1) };
  }
  if (LISTERS.has(name)) {
    const operands = optionsAndOperands(words.slice(1));
    return { kind: 'list', ...(operands[0] ? { target: operands[0] } : {}) };
  }
  if (SEARCHERS.has(name)) return searchStep(words);
  if (name === 'find' || name === 'fd' || name === 'fdfind') {
    if (name === 'find') return findStep(words);
    const operands = optionsAndOperands(words.slice(1));
    return operands[0] ? { kind: 'search', target: operands[0], ...(operands[1] ? { path: operands[1] } : {}) }
      : { kind: 'list' };
  }
  if (name === 'git' && words[1] === 'grep') return searchStep(['grep', ...words.slice(2)]);
  if (name === 'git' && words[1] === 'ls-files') return { kind: 'list' };
}

const commandName = (word) => word.replace(/^.*\//, '');

/** Drop leading `VAR=value` assignments and wrappers that do not change what runs. */
function withoutWrappers(words) {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
  while (index < words.length && ['time', 'nice', 'command', 'builtin', 'noglob'].includes(words[index])) index++;
  const rest = words.slice(index);
  if (rest.length > 0) rest[0] = commandName(rest[0]);
  return rest;
}

/**
 * What a shell command does, for the thread: `read` (with the file), `search`
 * (with the pattern), `list` (with the folder) or `command`. A command made of
 * several reading steps is classified by its first one.
 */
export function classifyShellCommand(command) {
  const text = string(command);
  if (!text) return { kind: 'command' };
  const runs = { kind: 'command', target: text };
  const steps = shellSteps(text);
  if (!steps) return runs;
  let first;
  for (const stages of steps) {
    const words = stages.map(shellWords);
    if (words.some((stage) => !stage)) return runs;
    const [head, ...filters] = words.map(withoutWrappers);
    if (!head || head.length === 0) continue;
    if (NEUTRAL.has(head[0]) && filters.length === 0) continue;
    if (filters.some((stage) => stage.length === 0 || !FILTERS.has(stage[0])
      || (stage[0] === 'sed' && !readStep(['sed', ...stage.slice(1), '/dev/stdin']))
      || stage.some((word) => word === '-i' || word.startsWith('--in-place')))) return runs;
    const step = readStep(head);
    if (!step) return runs;
    first ??= step;
  }
  return first ?? runs;
}

// --- Tool calls ------------------------------------------------------------

const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'multiedit', 'notebook_edit']);
const SEARCH_TOOLS = new Set(['grep', 'find', 'glob', 'ast_grep', 'mcp__ast_grep_search', 'ast_grep_search']);
const WEB_TOOLS = new Set(['webfetch', 'web_fetch', 'websearch', 'web_search']);

const patchedFiles = (input) => {
  if (typeof input !== 'string') return [];
  return [...input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
};

/**
 * What a tool call does, for the thread: `{ kind, target? }`, where kind is one of
 * `read`, `search`, `list`, `command`, `edit`, `web` or `other`. Target is the file,
 * pattern, folder, command or URL the live line names; `path` is where a search looks.
 */
export function toolActivityOf(toolName, args) {
  const input = record(args);
  const name = typeof toolName === 'string' ? toolName : '';
  if (name === 'bash') return classifyShellCommand(input.command);
  if (name === 'read') {
    const target = string(input.path) ?? string(input.file_path);
    return { kind: 'read', ...(target ? { target } : {}) };
  }
  if (name === 'ls') {
    const target = string(input.path);
    return { kind: 'list', ...(target ? { target } : {}) };
  }
  if (SEARCH_TOOLS.has(name)) {
    const target = string(input.pattern) ?? string(input.query) ?? string(input.rule);
    const path = string(input.path) ?? string(input.paths?.[0]);
    return { kind: 'search', ...(target ? { target } : {}), ...(path ? { path } : {}) };
  }
  if (EDIT_TOOLS.has(name)) {
    const files = name === 'apply_patch' ? patchedFiles(input.input ?? input.patch) : [];
    const target = string(input.path) ?? string(input.file_path) ?? files[0];
    return { kind: 'edit', ...(target ? { target } : {}), ...(files.length > 1 ? { count: files.length } : {}) };
  }
  if (WEB_TOOLS.has(name)) {
    const target = string(input.query) ?? string(input.url);
    return { kind: 'web', ...(target ? { target } : {}) };
  }
  return { kind: 'other' };
}

// A wait the agent ended its run on is named by its description, which is a monitor's
// sentence or a background command's first line; a bare session id names nothing a
// reader knows.
const BARE_SESSION_ID = /^(?:bash|mon|monitor|task|terminal)_[A-Za-z0-9]+$/;

/** What an idle agent waits on, for the live line ("Waiting on the test run"). */
export function waitActivityOf(labels) {
  const named = (Array.isArray(labels) ? labels : []).map(string).filter((label) => label && !BARE_SESSION_ID.test(label));
  return { kind: 'wait', ...(named.length > 0 ? { target: named.join(' · ') } : {}) };
}
