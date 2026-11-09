// Two things the memory page shows that no file holds, each written by one cheap model call and kept
// until what it was written from changes:
//
//   overlaps   which of a companion's lines about the person say the same as, or the opposite of, a
//              line in the shared user memory (agents/user.shared): the person decides whether to
//              share, merge or keep both; nothing changes on its own.
//   projects   one plain line per project about what changed in its memory this week, in the
//              person's language (the records themselves stay English).
//
// The call is the one Stats stories make (stats/stories.mjs): the stock engine in print mode on the
// session-title ladder, no tools. Nothing here writes memory; the answers live in
// ~/.rubato/cache/memory-page/insights.json and are a view, never an authority.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const OVERLAP_SYSTEM_PROMPT = `You compare two lists of things an assistant remembers about one person.

List A is shared memory that every agent reads. List B is what one companion agent noticed on its own and only it reads.

Find the pairs where a line in B covers the same point as a line in A ("same"), adds detail to it ("overlap"), or says something that cannot both hold ("conflict"). A pair needs a real shared subject; two lines that merely sound alike are not a pair. Most lines have no pair; an empty list is a fine answer.

Reply with one JSON object and nothing else:
{"pairs": [{"b": "<id from list B>", "a": "<id from list A>", "relation": "same" | "overlap" | "conflict", "note": "<one short sentence for the person>"}]}

- note: in the language you are told to write in, plain and short. Say what the two have in common or how they disagree. In Korean, use 반말 like a friend.
- Use only ids that appear in the lists. At most one pair per line of B: the closest one.`;

export const PROJECTS_SYSTEM_PROMPT = `You tell a person, in one plain line per project, what changed in their coding agents' project memory recently.

For each project you get the questions (files) that were created, rewritten or deleted, and sometimes the reason a nightly "dream" gave.

Reply with one JSON object and nothing else:
{"lines": {"<project>": "<one line>"}}

- One line per project, at most about 90 characters, in the language you are told to write in.
- Name the topics in everyday words, the way the person would say them; join two or three with " · ". No file names, no counts (the page shows counts), no "the dream".
- Use only what the material says.`;

const KEEP_FAILED_MS = 10 * 60_000;

export const hashOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

/** The JSON object in a reply, even when a model wraps it in a fence or a sentence. */
export function parseReply(reply) {
  const text = String(reply ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function overlapPrompt({ language, shared, companion }) {
  return [
    `Write notes in: ${language}`,
    '',
    'List A (shared, every agent reads):',
    ...shared.map((item) => `- [${item.id}] ${item.text}`),
    '',
    `List B (only ${companion.title} reads):`,
    ...companion.lines.map((item) => `- [${item.id}] ${item.text}`),
  ].join('\n');
}

export function projectsPrompt({ language, projects }) {
  const lines = [`Write in: ${language}`, ''];
  for (const project of projects) {
    lines.push(`## ${project.store}`);
    for (const file of project.files.slice(0, 20)) lines.push(`- ${file.change}: ${file.title ?? file.path}`);
    for (const reason of project.reasons.slice(0, 4)) lines.push(`  reason: ${reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Pairs a reply names that exist in both lists, one per line of B. */
export function cleanPairs(parsed, { shared, lines }) {
  const sharedIds = new Set(shared.map((item) => item.id));
  const lineIds = new Set(lines.map((item) => item.id));
  const seen = new Set();
  const pairs = [];
  for (const pair of Array.isArray(parsed?.pairs) ? parsed.pairs : []) {
    if (!pair || !lineIds.has(pair.b) || !sharedIds.has(pair.a) || seen.has(pair.b)) continue;
    if (!['same', 'overlap', 'conflict'].includes(pair.relation)) continue;
    seen.add(pair.b);
    pairs.push({ line: pair.b, shared: pair.a, relation: pair.relation, note: typeof pair.note === 'string' ? pair.note.trim().slice(0, 300) : '' });
  }
  return pairs;
}

/**
 * @param {{ cacheDir: string, complete: (request: {systemPrompt: string, prompt: string}) => Promise<{text: string, model: string}>,
 *   now?: () => number, onError?: (error: unknown) => void }} options
 */
export function createInsights({ cacheDir, complete, now = Date.now, onError = () => {} }) {
  const file = path.join(cacheDir, 'insights.json');
  const running = new Map();
  let writing = Promise.resolve();

  async function read() {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
  }
  function save(kind, entry) {
    writing = writing.then(async () => {
      const current = await read();
      await mkdir(cacheDir, { recursive: true });
      const temporary = `${file}.${process.pid}.${now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ ...current, [kind]: entry }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    }).catch(onError);
    return writing;
  }

  /**
   * The cached answer for `key`, or the last one with `stale: true` while a new one is written. A
   * failure is kept for a while so a page that polls does not start a call on every look.
   */
  async function get(kind, key, work, { start = true } = {}) {
    const cached = (await read())[kind];
    if (cached?.key === key && cached.status === 'ready') return { status: 'ready', at: cached.at, model: cached.model ?? null, value: cached.value };
    const previous = cached?.status === 'ready' ? cached.value : null;
    if (running.has(kind)) return { status: 'working', value: previous, stale: previous !== null };
    if (cached?.key === key && cached.status === 'failed' && now() - Date.parse(cached.at) < KEEP_FAILED_MS)
      return { status: 'failed', error: cached.error, value: previous, stale: previous !== null };
    if (!start) return { status: 'idle', value: previous, stale: previous !== null };
    const job = (async () => {
      try {
        const { value, model } = await work();
        await save(kind, { key, status: 'ready', at: new Date(now()).toISOString(), model, value });
      } catch (error) {
        onError(error);
        await save(kind, { key, status: 'failed', at: new Date(now()).toISOString(), error: error instanceof Error ? error.message : String(error), ...(previous ? { value: previous } : {}) });
      } finally {
        running.delete(kind);
      }
    })();
    running.set(kind, job);
    return { status: 'working', value: previous, stale: previous !== null };
  }

  /** Overlaps between the shared user memory and one companion's lines about the person. */
  function overlaps({ language, shared, companion }, options) {
    if (shared.length === 0 || companion.lines.length === 0) return Promise.resolve({ status: 'ready', value: { pairs: [] } });
    const key = hashOf({ language, shared, companion: companion.id, lines: companion.lines });
    return get(`overlaps:${companion.id}`, key, async () => {
      const reply = await complete({ systemPrompt: OVERLAP_SYSTEM_PROMPT, prompt: overlapPrompt({ language, shared, companion }) });
      const parsed = parseReply(reply.text);
      if (!parsed) throw new Error(`${reply.model}: no JSON in the reply`);
      return { model: reply.model, value: { pairs: cleanPairs(parsed, { shared, lines: companion.lines }) } };
    }, options);
  }

  /** One line per project in `projects` ({store, key, files, reasons}). */
  function projects({ language, projects: list }, options) {
    if (list.length === 0) return Promise.resolve({ status: 'ready', value: { lines: {} } });
    const key = hashOf({ language, projects: list.map((project) => [project.store, project.key]) });
    return get('projects', key, async () => {
      const reply = await complete({ systemPrompt: PROJECTS_SYSTEM_PROMPT, prompt: projectsPrompt({ language, projects: list }) });
      const parsed = parseReply(reply.text);
      if (!parsed || typeof parsed.lines !== 'object' || parsed.lines === null) throw new Error(`${reply.model}: no JSON in the reply`);
      const stores = new Set(list.map((project) => project.store));
      const lines = Object.fromEntries(Object.entries(parsed.lines)
        .filter(([store, line]) => stores.has(store) && typeof line === 'string' && line.trim() !== '')
        .map(([store, line]) => [store, line.trim().slice(0, 200)]));
      return { model: reply.model, value: { lines } };
    }, options);
  }

  /** Waits for whatever is being written (tests). */
  async function settled() {
    await Promise.all(running.values());
    await writing;
  }

  return { overlaps, projects, settled };
}
