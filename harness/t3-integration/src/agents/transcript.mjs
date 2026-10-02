// A child agent's whole conversation, read from the session file its runner keeps, for
// the Agents panel. Reading the file (instead of asking the live session) is what lets a
// finished agent of a thread that is not attached still be read.
//
// Where the file is mirrors the task package: packages/task/src/store/state-dir.ts picks
// the state dir and runners/rpc/spawn.ts nests children/<id>/sessions/<id>/ under it.
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const jsonc = createRequire(path.join(repoRoot, 'packages', 'rubato-config-core', 'package.json'))('jsonc-parser');

/** Task ids are `st_…`; anything that could leave the children dir is refused. */
export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LIMITS = { text: 40_000, thinking: 12_000, toolInput: 2_000, toolOutput: 4_000 };

async function configuredStateDir(file) {
  try {
    const value = jsonc.parse(await readFile(file, 'utf8'))?.task?.state_dir;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch { return undefined; }
}

/** The project's task state dir: `task.state_dir` (project, then user), else `.rubato/task`, else the legacy `.rubato/senpi-task`. */
export async function taskStateDir(cwd, { home = homedir() } = {}) {
  const configured = await configuredStateDir(path.join(cwd, '.rubato', 'rubato.jsonc'))
    ?? await configuredStateDir(path.join(home, '.rubato', 'rubato.jsonc'));
  if (configured) return path.resolve(cwd, configured.replace(/^~(?=$|\/)/, home));
  const next = path.join(cwd, '.rubato', 'task');
  const legacy = path.join(cwd, '.rubato', 'senpi-task');
  return existsSync(legacy) && !existsSync(next) ? legacy : next;
}

function bounded(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
}

function inputOf(args) {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

// A child's first message is the runner's envelope around the brief (packages/task/src/
// runners/in-process/subagent-prompt.ts): identity lines, maybe the preset's instructions,
// then `Task:` and the brief itself. The panel shows the brief.
const ENVELOPE = 'You are running as a Rubato task child';
export function briefOf(text) {
  if (!text.startsWith(ENVELOPE)) return text;
  const at = text.indexOf('\n\nTask:\n');
  return at === -1 ? text : text.slice(at + '\n\nTask:\n'.length);
}

const timeOf = (entry) => {
  const at = Date.parse(entry?.timestamp ?? '');
  return Number.isFinite(at) ? at : undefined;
};

/**
 * The conversation as the panel draws it, in file order: what the child was told (`user`:
 * the brief, then any follow-up), its words (`assistant`), its reasoning (`thinking`), each
 * tool call with its result once it lands (`tool`), and where its context was compacted.
 * System prompts, injected notices and bookkeeping entries are not part of the conversation.
 */
export function transcriptItems(text) {
  const items = [];
  const tools = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const at = timeOf(entry);
    if (entry?.type === 'compaction') {
      items.push({ kind: 'compaction', text: bounded(String(entry.summary ?? ''), LIMITS.thinking), ...(at ? { at } : {}) });
      continue;
    }
    if (entry?.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    if (message.role === 'user') {
      const body = briefOf(textOf(message.content));
      if (body.trim()) items.push({ kind: 'user', text: bounded(body, LIMITS.text), ...(at ? { at } : {}) });
    } else if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === 'text' && part.text?.trim()) items.push({ kind: 'assistant', text: bounded(part.text, LIMITS.text), ...(at ? { at } : {}) });
        else if (part?.type === 'thinking' && part.thinking?.trim()) items.push({ kind: 'thinking', text: bounded(part.thinking, LIMITS.thinking) });
        else if (part?.type === 'toolCall') {
          const tool = { kind: 'tool', id: String(part.id ?? ''), name: String(part.name ?? 'tool'),
            input: bounded(inputOf(part.arguments), LIMITS.toolInput), ...(at ? { at } : {}) };
          items.push(tool);
          if (tool.id) tools.set(tool.id, tool);
        }
      }
      if (message.stopReason === 'error' && message.errorMessage)
        items.push({ kind: 'error', text: bounded(String(message.errorMessage), LIMITS.toolOutput) });
    } else if (message.role === 'toolResult') {
      const tool = tools.get(String(message.toolCallId ?? ''));
      const output = bounded(textOf(message.content), LIMITS.toolOutput);
      if (tool) { tool.output = output; if (message.isError) tool.isError = true; }
    }
  }
  return items;
}

/**
 * One child's transcript. `version` names the files' sizes and times; when the caller
 * already holds that version the items are not read or sent again.
 */
export async function readChildTranscript({ cwd, taskId, version, home } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw Object.assign(new Error('cwd must be an absolute path'), { status: 400 });
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw Object.assign(new Error('Unknown agent id'), { status: 400 });
  const dir = path.join(await taskStateDir(cwd, { home }), 'children', taskId, 'sessions', taskId);
  let names;
  try { names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort(); }
  catch { return { found: false, version: '', items: [] }; }
  const files = await Promise.all(names.map(async (name) => ({ name, info: await stat(path.join(dir, name)) })));
  const current = files.map(({ name, info }) => `${name}:${info.size}:${Math.trunc(info.mtimeMs)}`).join('|');
  if (version && version === current) return { found: true, version: current, unchanged: true };
  const items = [];
  for (const { name } of files) items.push(...transcriptItems(await readFile(path.join(dir, name), 'utf8')));
  return { found: names.length > 0, version: current, items };
}
