// The prompts a new conversation can be opened with instead of Rubato's own (the new-thread
// screen's "시스템 프롬프트" chip). The chosen text becomes the session's whole system prompt:
// pi-server's create `systemPrompt`, the session-prompt engine patch's replacement entry.
//
// The library is the Markdown and text files in ~/.rubato/prompts, then ~/Documents/SOUL.md
// (rubato-soul's file) when it exists. An id names only a file this listing returns, so a
// request reaches nothing else on disk. Text written in the app for one conversation comes
// as text and is never stored here.
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PROMPT_FILE = /\.(md|markdown|txt)$/i;
/** pi-server refuses a larger replacement prompt (session-files.mjs SYSTEM_PROMPT_LIMIT). */
export const SESSION_PROMPT_LIMIT = 512 * 1024;
export const INLINE_PROMPT_LABEL = '직접 쓴 프롬프트';

export class SessionPromptError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function sessionPromptPlaces({ home = homedir() } = {}) {
  return { folder: path.join(home, '.rubato', 'prompts'), extras: [path.join(home, 'Documents', 'SOUL.md')] };
}

const labelOf = (file) => path.basename(file).replace(PROMPT_FILE, '');
const entryOf = (file) => ({ id: `file:${file}`, label: labelOf(file), source: file });

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

/** `[{ id, label, source }]`: the folder's files by name, then the extra files that exist. */
export async function listSessionPrompts(places = sessionPromptPlaces()) {
  let names = [];
  try { names = await readdir(places.folder); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = [];
  for (const name of names.filter((item) => !item.startsWith('.') && PROMPT_FILE.test(item))) {
    const file = path.join(places.folder, name);
    if (await isFile(file)) files.push(file);
  }
  files.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  for (const extra of places.extras ?? []) if (!files.includes(extra) && await isFile(extra)) files.push(extra);
  return files.map(entryOf);
}

// iCloud Optimize can leave Documents files as dataless stubs that fail to read until
// downloaded (rubato-pi system-prompt.mjs materializeLocalFile).
function materialize(file) {
  if (process.platform === 'darwin') spawnSync('chflags', ['nodataless', file], { stdio: 'ignore' });
}

async function readPromptFile(file) {
  try { return await readFile(file, 'utf8'); }
  catch {
    materialize(file);
    try { return await readFile(file, 'utf8'); }
    catch (error) { throw new SessionPromptError('unreadable', `Could not read ${file}: ${error.message}`); }
  }
}

function checked(text) {
  if (typeof text !== 'string' || !text.trim()) throw new SessionPromptError('empty', 'The prompt is empty.');
  if (text.length > SESSION_PROMPT_LIMIT)
    throw new SessionPromptError('too-large', `The prompt is longer than ${SESSION_PROMPT_LIMIT} characters.`);
  return text;
}

/**
 * The text a new session opens with. `{ id }` names a listed file and is read now, so later
 * edits to the file never reach the session; `{ text, label? }` is text written for one
 * conversation. Answers `{ text, label, source? }`, pi-server's create `systemPrompt`.
 */
export async function resolveSessionPrompt(choice, places = sessionPromptPlaces()) {
  if (typeof choice?.id === 'string') {
    const entry = (await listSessionPrompts(places)).find((item) => item.id === choice.id);
    if (!entry) throw new SessionPromptError('not-found', 'That prompt file is no longer in the prompt folder.');
    return { text: checked(await readPromptFile(entry.source)), label: entry.label, source: entry.source };
  }
  const text = checked(choice?.text);
  const label = typeof choice?.label === 'string' && choice.label.trim() ? choice.label.trim().slice(0, 200) : INLINE_PROMPT_LABEL;
  return { text, label };
}

/** Creates the prompt folder when missing and shows it in Finder. */
export async function openSessionPromptFolder(places = sessionPromptPlaces(), { open = (folder) => new Promise((resolve, reject) => {
  execFile('open', [folder], (error) => (error ? reject(error) : resolve()));
}) } = {}) {
  await mkdir(places.folder, { recursive: true });
  await open(places.folder);
  return { folder: places.folder };
}
