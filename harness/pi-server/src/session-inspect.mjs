import { createReadStream, existsSync } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Read-only lookups over what other conversations left on disk: their transcripts, the
// subagents and team members they started, their context notes and their team boards.
// Nothing here writes, opens a SessionManager or starts a runtime. The places it reads:
//   conversations   <agentDir>/sessions/**/<time>_<uuid>.jsonl
//   subagents       <project>/.rubato/{task,senpi-task}/tasks/st_X.json             (record)
//                   <project>/.rubato/{task,senpi-task}/children/st_X/sessions/st_X/*.jsonl
//   team runs       <project>/.rubato/{task,senpi-task}/teams/runtime/<runId>/{state,task-members}.json,
//                   tasks/<n>.json (the shared board) and inboxes/** (team messages)
//   context notes   <agentDir>/context-notes/<sha256(session uuid)>.sqlite
// A team member is a subagent, so it is addressed by its st_ id like any other.

export const INSPECT_LIMITS = Object.freeze({ searchDefault: 8, searchMax: 30, hitsPerTarget: 3, snippetChars: 240,
  agentsMax: 40, boardMessages: 20, boardChars: 400, noteListChars: 600, searchBudgetMs: 15000, linesPerFile: 200 });

const STATE_DIR_NAMES = Object.freeze(['task', 'senpi-task']);
const AGENT_ID = /^st_[0-9a-z]+$/i;
const SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export const isAgentId = (id) => typeof id === 'string' && AGENT_ID.test(id);
const ms = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value
  : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
/** A record's model as team_create prints it: `provider/model[:effort]`. */
const modelName = (record) => {
  const resolved = record.resolved_model;
  const name = typeof resolved?.display === 'string' ? resolved.display : typeof record.model === 'string' ? record.model : null;
  const effort = resolved?.reasoning_effort;
  return name && typeof effort === 'string' && effort ? `${name}:${effort}` : name;
};
const clip = (text, max) => text.length > max ? text.slice(0, max) + '…' : text;
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n') : '';
const timeOf = (entry) => typeof entry?.message?.timestamp === 'number' ? entry.message.timestamp
  : Number.isFinite(Date.parse(entry?.timestamp)) ? Date.parse(entry.timestamp) : null;

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
}
async function list(dir) {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** The task state dirs a project can hold: `.rubato/task`, or the legacy `.rubato/senpi-task`. */
export function taskStateDirs(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return [];
  return STATE_DIR_NAMES.map((name) => path.join(cwd, '.rubato', name)).filter((dir) => existsSync(path.join(dir, 'tasks')) || existsSync(path.join(dir, 'teams')));
}

export const agentSessionDir = (stateDir, agentId) => path.join(stateDir, 'children', agentId, 'sessions', agentId);
export const notesDatabasePath = (agentDir, sessionUuid) =>
  path.join(agentDir, 'context-notes', `${createHash('sha256').update(sessionUuid).digest('hex')}.sqlite`);

async function jsonlFiles(dir) {
  return (await list(dir)).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => path.join(dir, entry.name)).sort();
}

/**
 * When a subagent last did something: its transcript grows with every message, tool result and
 * notification. Its record only changes when its status does, so a run that died or hangs keeps
 * an old updatedAt next to "running" and looks the same as one that is working.
 */
async function lastActivity(files) {
  const file = files.at(-1);
  return file ? ms((await stat(file).catch(() => undefined))?.mtimeMs) : null;
}

/** First line of a transcript: its header (`id`, `cwd`), read without loading the file. */
export async function readHeader(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    const header = JSON.parse(line);
    return header?.type === 'session' ? header : undefined;
  } catch { return undefined; } finally { await handle?.close(); }
}

/** Every whole entry of a transcript, in file order. */
export async function readEntries(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const entry = JSON.parse(line); if (entry && typeof entry === 'object') entries.push(entry); } catch {}
  }
  return entries;
}

// The app wraps attachment metadata into the user's message; it is not what the user wrote.
const withoutAppContext = (text) => text.replace(/<t3_context\b[\s\S]*?<\/t3_context>/g, '').replace(/\[Image: [^\]]*\]/g, '').trim();

/**
 * What a person or the model wrote in one entry, and who: user, assistant, a tool result, or a
 * message from another conversation. Thinking, compaction summaries and bookkeeping have none.
 * Tool calls and tool output only count when `tools` asks for them.
 */
export function entryText(entry, { tools = false } = {}) {
  if (entry?.type === 'custom_message' && entry.customType === 'rubato-session-message') {
    return { role: 'session-message', text: typeof entry.details?.text === 'string' ? entry.details.text : textOf(entry.content) };
  }
  if (entry?.type !== 'message') return undefined;
  const { role, content } = entry.message ?? {};
  if (role === 'user') return { role, text: withoutAppContext(textOf(content)) };
  if (role === 'assistant') {
    const calls = Array.isArray(content) ? content.filter((part) => part?.type === 'toolCall') : [];
    const said = textOf(content);
    const called = tools ? calls.map((call) => `${call.name} ${JSON.stringify(call.arguments ?? {})}`).join('\n') : '';
    return { role, text: [said, called].filter(Boolean).join('\n'), toolCalls: calls };
  }
  if (!tools) return undefined;
  if (role === 'toolResult') return { role: 'tool', name: entry.message.toolName, text: textOf(content), isError: Boolean(entry.message.isError) };
  if (role === 'bashExecution') return { role: 'tool', name: 'bash', text: `${entry.message.command ?? ''}\n${entry.message.output ?? ''}` };
  return undefined;
}

const startsTurn = (entry) => {
  const found = entryText(entry);
  return found?.role === 'user' || found?.role === 'session-message';
};

/**
 * The turn that holds `entryId`: from the input that started it to the entry before the next
 * input, following the newest continuation forward. Works off the live branch too, so a hit on
 * a rewound branch still reads in its own context.
 */
export function turnAround(entries, entryId) {
  const body = entries.filter((entry) => entry.type !== 'session' && typeof entry.id === 'string');
  const byId = new Map(body.map((entry) => [entry.id, entry]));
  const target = byId.get(entryId);
  if (!target) return undefined;
  const before = [];
  const seen = new Set();
  let entry = target;
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id);
    before.unshift(entry);
    if (startsTurn(entry)) break;
    entry = byId.get(entry.parentId);
  }
  const children = new Map();
  for (const item of body) {
    if (!children.has(item.parentId)) children.set(item.parentId, []);
    children.get(item.parentId).push(item);
  }
  const after = [];
  entry = children.get(target.id)?.at(-1);
  while (entry && !seen.has(entry.id) && !startsTurn(entry)) {
    seen.add(entry.id);
    after.push(entry);
    entry = children.get(entry.id)?.at(-1);
  }
  return { entries: [...before, ...after], targetIndex: before.length - 1 };
}

/** Keeps the turn's opening input, a window around the target and the closing answer. */
export function windowTurn(summaries, targetIndex, count) {
  if (summaries.length <= count) return { messages: summaries, truncated: false };
  const keep = new Set([0, summaries.length - 1]);
  let low = targetIndex, high = targetIndex;
  keep.add(targetIndex);
  while (keep.size < count && (low > 0 || high < summaries.length - 1)) {
    if (high < summaries.length - 1) keep.add(++high);
    if (keep.size < count && low > 0) keep.add(--low);
  }
  return { messages: [...keep].sort((a, b) => a - b).map((index) => summaries[index]), truncated: true };
}

function snippet(text, needle) {
  const flat = oneLine(text);
  const at = flat.toLowerCase().indexOf(needle);
  const max = INSPECT_LIMITS.snippetChars;
  if (at < 0) return clip(flat, max);
  const start = Math.max(0, at - Math.floor(max / 3));
  const piece = flat.slice(start, start + max);
  return (start > 0 ? '…' : '') + piece + (start + max < flat.length ? '…' : '');
}

/** Search terms: whitespace-separated, all of them must appear in one entry, case-insensitive. */
export function searchTerms(query) {
  if (typeof query !== 'string') return [];
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

/** The entry's hit for `terms`, or undefined. */
export function matchEntry(entry, terms, { tools = false } = {}) {
  const found = entryText(entry, { tools });
  if (!found?.text) return undefined;
  const lower = found.text.toLowerCase();
  if (!terms.every((term) => lower.includes(term))) return undefined;
  const longest = terms.reduce((a, b) => b.length > a.length ? b : a, '');
  return { entryId: entry.id, role: found.role, ...(found.name ? { name: found.name } : {}), at: ms(timeOf(entry)), snippet: snippet(found.text, longest) };
}

/** ripgrep from PATH or the runtime's own tool folder (<agentDir>/bin); null when neither has it. */
export function findRipgrep(agentDir) {
  const candidates = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'rg')),
    ...(agentDir ? [path.join(agentDir, 'bin', 'rg')] : [])];
  return candidates.find((file) => existsSync(file)) ?? null;
}

/**
 * `file -> (line number -> byte offset)` of the lines holding `term`, from ripgrep; undefined when
 * ripgrep is missing or fails. The offset lets a reader fetch just that line of a large transcript.
 */
async function candidateLines(rg, term, roots) {
  if (!rg || !roots.length) return undefined;
  const args = ['--null', '--no-heading', '--line-number', '--byte-offset', '--only-matching', '--ignore-case', '--fixed-strings',
    '--no-ignore', '--hidden', '--max-count', String(INSPECT_LIMITS.linesPerFile), '--glob', '*.jsonl', '--regexp', term, '--', ...roots];
  const output = await new Promise((resolve) => {
    execFile(rg, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
      // 1 = no match, which is an answer; anything else without output is a failure.
      if (error && error.code !== 1 && !stdout?.length) resolve(undefined);
      else resolve(stdout ?? Buffer.alloc(0));
    });
  });
  if (output === undefined) return undefined;
  const found = new Map();
  for (const record of output.toString('utf8').split('\n')) {
    const cut = record.indexOf('\0');
    if (cut < 0) continue;
    const file = record.slice(0, cut);
    const [line, offset] = record.slice(cut + 1).split(':', 2).map((value) => Number.parseInt(value, 10));
    if (!Number.isFinite(line) || !Number.isFinite(offset)) continue;
    if (!found.has(file)) found.set(file, new Map());
    const lines = found.get(file);
    if (!lines.has(line) || lines.get(line) > offset) lines.set(line, offset);
  }
  return found;
}

const CHUNK = 64 * 1024;

/** The whole line that holds byte `offset`, read around it without reading the rest of the file. */
async function lineAt(handle, size, offset) {
  let start = offset;
  while (start > 0) {
    const from = Math.max(0, start - CHUNK);
    const buffer = Buffer.alloc(start - from);
    await handle.read(buffer, 0, buffer.length, from);
    const newline = buffer.lastIndexOf(10);
    if (newline >= 0) { start = from + newline + 1; break; }
    start = from;
  }
  let end = offset;
  while (end < size) {
    const buffer = Buffer.alloc(Math.min(CHUNK, size - end));
    await handle.read(buffer, 0, buffer.length, end);
    const newline = buffer.indexOf(10);
    if (newline >= 0) { end += newline; break; }
    end += buffer.length;
  }
  const line = Buffer.alloc(end - start);
  await handle.read(line, 0, line.length, start);
  return line;
}

/** Parses the wanted lines of a file (`line -> offset`), or every line when `wanted` is undefined. */
async function scanLines(file, wanted, visit) {
  const parse = (buffer) => {
    let entry;
    try { entry = JSON.parse(buffer.toString('utf8')); } catch { return; }
    if (entry && typeof entry === 'object') visit(entry);
  };
  if (wanted) {
    let handle;
    try {
      handle = await open(file, 'r');
      const { size } = await handle.stat();
      for (const offset of [...wanted.values()].sort((a, b) => a - b)) parse(await lineAt(handle, size, offset));
    } catch {} finally { await handle?.close(); }
    return;
  }
  const stream = createReadStream(file);
  let rest = Buffer.alloc(0);
  for await (const chunk of stream) {
    const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let start = 0;
    for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
      parse(data.subarray(start, end));
      start = end + 1;
    }
    rest = data.subarray(start);
  }
  if (rest.length) parse(rest);
}

/**
 * The read-only inspector. `cwds()` lists the folders conversations ran in (their task state dirs
 * hold subagents and teams); `titleOf(id)` names a conversation; `locate(id)` finds its transcript.
 * `ripgrepPath` overrides where ripgrep is (null: search without it, every line of every file).
 */
export function createInspector({ agentDir, sessionsDir, cwds, titleOf = () => undefined, locate, now = Date.now, ripgrepPath }) {
  let ripgrep = ripgrepPath;
  // A folder reached through a symlink holds the same state dir; it is read once, by its real path.
  async function stateDirs() {
    const dirs = new Set();
    for (const cwd of new Set(await cwds())) for (const dir of taskStateDirs(cwd)) dirs.add(await realpath(dir).catch(() => dir));
    return [...dirs];
  }
  async function recordsIn(stateDir) {
    const records = [];
    for (const entry of await list(path.join(stateDir, 'tasks'))) {
      if (!entry.isFile() || !/^st_.+\.json$/.test(entry.name)) continue;
      const record = await readJson(path.join(stateDir, 'tasks', entry.name));
      if (record?.task_id) records.push(record);
    }
    return records;
  }
  async function teamsIn(stateDir) {
    const root = path.join(stateDir, 'teams', 'runtime');
    const teams = [];
    for (const entry of await list(root)) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const state = await readJson(path.join(dir, 'state.json'));
      if (!state?.teamRunId) continue;
      teams.push({ dir, state, members: (await readJson(path.join(dir, 'task-members.json'))) ?? {} });
    }
    return teams;
  }
  const memberOf = (teams, agentId) => {
    for (const team of teams) for (const [name, id] of Object.entries(team.members)) if (id === agentId) return { team, name };
  };
  function agentRow(record, teams, { from, lastActivityAt } = {}) {
    const member = memberOf(teams, record.task_id);
    return {
      agentId: record.task_id,
      name: record.task_summary || record.name || record.task_id,
      status: record.status ?? null,
      model: modelName(record),
      ...(from && record.parent_session_id && record.parent_session_id !== from ? { parentSessionId: record.parent_session_id } : {}),
      ...(member ? { team: { teamRunId: member.team.state.teamRunId, teamName: member.team.state.teamName ?? null, member: member.name } } : {}),
      createdAt: ms(record.created_at),
      updatedAt: ms(record.updated_at),
      lastActivityAt: lastActivityAt ?? null,
    };
  }
  function teamRow(team, records) {
    const byId = new Map(records.map((record) => [record.task_id, record]));
    const kinds = new Map((team.state.members ?? []).map((member) => [member.name, member]));
    const names = new Set([...Object.keys(team.members), ...kinds.keys()]);
    return {
      teamRunId: team.state.teamRunId,
      teamName: team.state.teamName ?? null,
      status: team.state.status ?? null,
      leadSessionId: team.state.leadSessionId ?? null,
      createdAt: ms(team.state.createdAt),
      members: [...names].map((name) => ({ name, kind: kinds.get(name)?.kind ?? null,
        status: byId.get(team.members[name])?.status ?? kinds.get(name)?.status ?? null, agentId: team.members[name] ?? null })),
    };
  }

  /** Where a subagent lives, from its st_ id alone. */
  async function findAgent(agentId) {
    for (const stateDir of await stateDirs()) {
      const record = await readJson(path.join(stateDir, 'tasks', `${agentId}.json`));
      if (record?.task_id === agentId) return { stateDir, record, project: path.dirname(path.dirname(stateDir)) };
    }
    return undefined;
  }

  /** The subagents and team runs a conversation started (subagents of its subagents included). */
  async function related(sessionId, cwd) {
    const agents = [];
    const teams = [];
    for (const stateDir of taskStateDirs(cwd)) {
      const records = await recordsIn(stateDir);
      const runs = await teamsIn(stateDir);
      const mine = records.filter((record) => record.parent_session_id === sessionId || record.root_session_id === sessionId)
        .sort((a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0));
      for (const record of mine) {
        const lastActivityAt = await lastActivity(await jsonlFiles(agentSessionDir(stateDir, record.task_id)));
        agents.push(agentRow(record, runs, { from: sessionId, lastActivityAt }));
      }
      teams.push(...runs.filter((team) => team.state.leadSessionId === sessionId).map((team) => teamRow(team, records)));
    }
    const max = INSPECT_LIMITS.agentsMax;
    return { agents: agents.slice(-max), agentsTruncated: agents.length > max, teams };
  }

  /** A subagent as a target: what it is, where it came from, and its transcript files. */
  async function agent(agentId) {
    const found = await findAgent(agentId);
    if (!found) return undefined;
    const runs = await teamsIn(found.stateDir);
    const files = await jsonlFiles(agentSessionDir(found.stateDir, agentId));
    const resultDir = path.join(found.stateDir, 'completion-results', agentId);
    const results = (await list(resultDir)).filter((entry) => entry.isFile()).map((entry) => path.join(resultDir, entry.name)).sort();
    const header = files.length ? await readHeader(files.at(-1)) : undefined;
    return {
      ...found,
      files,
      sessionUuid: header?.id ?? null,
      member: memberOf(runs, agentId),
      runs,
      info: {
        ...agentRow(found.record, runs, { lastActivityAt: await lastActivity(files) }),
        parentSessionId: found.record.parent_session_id ?? null,
        rootSessionId: found.record.root_session_id ?? null,
        cwd: found.project,
        ...(results.length ? { resultFile: results.at(-1) } : {}),
      },
    };
  }

  /** The current version of each context note a conversation (by its session uuid) kept. */
  async function notes(sessionUuid, { chars, notePath }) {
    const file = notesDatabasePath(agentDir, sessionUuid);
    if (!existsSync(file)) return { notes: [], available: false };
    const { DatabaseSync } = await import('node:sqlite');
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db.prepare(`SELECT n.path, n.text, n.window_id FROM notes n
        JOIN (SELECT path, MAX(ordinal) AS latest FROM notes GROUP BY path) m ON m.path = n.path AND m.latest = n.ordinal
        ORDER BY n.path`).all();
      if (notePath !== undefined) {
        const row = rows.find((item) => item.path === notePath);
        return { available: true, notes: row ? [{ path: row.path, windowId: row.window_id, text: clip(row.text, chars), chars: row.text.length }] : [],
          paths: rows.map((item) => item.path) };
      }
      const each = Math.max(INSPECT_LIMITS.noteListChars, Math.floor(chars / Math.max(1, rows.length)));
      return { available: true, notes: rows.map((row) => ({ path: row.path, windowId: row.window_id, text: clip(row.text, each), chars: row.text.length })) };
    } catch (error) {
      return { available: false, notes: [], error: `context notes could not be read: ${error?.message ?? error}` };
    } finally { try { db?.close(); } catch {} }
  }

  /** A team run's shared board (its work items) and its latest team messages. */
  async function board(team, records) {
    const items = [];
    for (const entry of await list(path.join(team.dir, 'tasks'))) {
      if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
      const item = await readJson(path.join(team.dir, 'tasks', entry.name));
      if (!item?.id) continue;
      items.push({ id: String(item.id), subject: item.subject ?? '', status: item.status ?? null, owner: item.owner ?? null,
        ...(item.blockedBy?.length ? { blockedBy: item.blockedBy } : {}),
        description: clip(oneLine(item.description ?? ''), INSPECT_LIMITS.boardChars), updatedAt: ms(item.updatedAt) });
    }
    items.sort((a, b) => Number(a.id) - Number(b.id));
    const messages = new Map();
    const walk = async (dir) => {
      for (const entry of await list(dir)) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.name.endsWith('.json')) {
          const message = await readJson(file);
          if (message?.messageId && !messages.has(message.messageId)) messages.set(message.messageId, message);
        }
      }
    };
    await walk(path.join(team.dir, 'inboxes'));
    const latest = [...messages.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).slice(-INSPECT_LIMITS.boardMessages);
    return { ...teamRow(team, records), tasks: items,
      messages: latest.map((message) => ({ from: message.from ?? null, to: message.to ?? null, at: ms(message.timestamp),
        ...(message.summary ? { summary: message.summary } : {}), text: clip(oneLine(String(message.body ?? '')), INSPECT_LIMITS.boardChars) })),
      messagesTruncated: messages.size > latest.length };
  }

  /** Boards of the team runs a conversation led, or of the team a subagent belongs to. */
  async function boards({ sessionId, cwd, agentId }) {
    if (agentId) {
      const found = await agent(agentId);
      if (!found?.member) return [];
      return [await board(found.member.team, await recordsIn(found.stateDir))];
    }
    const result = [];
    for (const stateDir of taskStateDirs(cwd)) {
      const records = await recordsIn(stateDir);
      for (const team of await teamsIn(stateDir)) if (team.state.leadSessionId === sessionId) result.push(await board(team, records));
    }
    return result;
  }

  /**
   * Full-text search over conversations and their subagents' transcripts. Hits are entries where
   * every term appears in what was said (tool calls and output only with `tools`), grouped by
   * conversation or subagent, newest first, a few per target with short snippets.
   */
  async function search({ query, cwd, sessionId, tools = false, limit, exclude }) {
    const terms = searchTerms(query);
    const max = limit;
    const started = now();
    const dirs = await stateDirs();
    const recordsByDir = new Map();
    const teamsByDir = new Map();
    const identify = async (file) => {
      const relative = path.relative(sessionsDir, file);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        const header = await readHeader(file);
        const id = header?.id ?? SESSION_FILE.exec(file)?.[1];
        return id ? { kind: 'conversation', sessionId: id, cwd: header?.cwd ?? null } : undefined;
      }
      const match = /[\\/]children[\\/](st_[^\\/]+)[\\/]sessions[\\/]\1[\\/]/.exec(file);
      if (!match) return undefined;
      const stateDir = file.slice(0, match.index);
      if (!recordsByDir.has(stateDir)) { recordsByDir.set(stateDir, await recordsIn(stateDir)); teamsByDir.set(stateDir, await teamsIn(stateDir)); }
      const record = recordsByDir.get(stateDir).find((item) => item.task_id === match[1]);
      return { kind: 'subagent', agentId: match[1], cwd: path.dirname(path.dirname(stateDir)), record, teams: teamsByDir.get(stateDir) };
    };

    // Which files to look in.
    let roots;
    let only;
    if (sessionId !== undefined) {
      only = new Set();
      if (isAgentId(sessionId)) {
        const found = await findAgent(sessionId);
        if (!found) return { results: [], truncated: false, unknown: true };
        roots = [agentSessionDir(found.stateDir, sessionId)];
      } else {
        const file = await locate(sessionId);
        const header = await readHeader(file);
        roots = [file];
        for (const stateDir of taskStateDirs(header?.cwd)) {
          for (const record of await recordsIn(stateDir)) {
            if (record.root_session_id === sessionId || record.parent_session_id === sessionId) roots.push(agentSessionDir(stateDir, record.task_id));
          }
        }
      }
      roots = roots.filter((root) => existsSync(root));
    } else {
      roots = [sessionsDir, ...dirs.map((dir) => path.join(dir, 'children'))].filter((root) => existsSync(root));
    }

    // ripgrep pre-filters on the raw JSON line, where `"` and `\` are escaped: it looks for the
    // longest term that reads the same there, and a query made only of such terms reads every line.
    const plain = terms.filter((term) => !/["\\\u0000-\u001f]/.test(term)).sort((a, b) => b.length - a.length)[0];
    if (ripgrep === undefined) ripgrep = findRipgrep(agentDir);
    let candidates = plain === undefined ? undefined : await candidateLines(ripgrep, plain, roots);
    // One entry is one line, so a line missing any other plain term cannot hold a hit.
    for (const term of terms) {
      if (!candidates?.size || term === plain || /["\\\u0000-\u001f]/.test(term)) continue;
      const also = await candidateLines(ripgrep, term, [...candidates.keys()]);
      if (!also) break;
      for (const [file, lines] of candidates) {
        const kept = new Map([...lines].filter(([line]) => also.get(file)?.has(line)));
        if (kept.size) candidates.set(file, kept); else candidates.delete(file);
      }
    }
    const exhaustive = candidates === undefined;
    if (exhaustive) {
      // No ripgrep: every transcript under the roots, every line.
      candidates = new Map();
      const collect = async (root) => {
        const info = await stat(root).catch(() => undefined);
        if (info?.isFile()) { candidates.set(root, undefined); return; }
        for (const entry of await list(root)) {
          const file = path.join(root, entry.name);
          if (entry.isDirectory()) await collect(file);
          else if (entry.name.endsWith('.jsonl')) candidates.set(file, undefined);
        }
      };
      for (const root of roots) await collect(root);
    }

    const ordered = [];
    for (const file of candidates.keys()) ordered.push({ file, mtime: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0 });
    ordered.sort((a, b) => b.mtime - a.mtime);

    const results = [];
    let truncated = false;
    let budgetHit = false;
    for (const { file, mtime } of ordered) {
      if (results.length >= max) { truncated = true; break; }
      if (now() - started > INSPECT_LIMITS.searchBudgetMs) { truncated = true; budgetHit = true; break; }
      const who = await identify(file);
      if (!who) continue;
      const id = who.sessionId ?? who.agentId;
      if (exclude && id === exclude) continue;
      if (cwd && who.cwd !== cwd) continue;
      const hits = [];
      await scanLines(file, candidates.get(file), (entry) => {
        const hit = matchEntry(entry, terms, { tools });
        if (hit) hits.push(hit);
      });
      if (!hits.length) continue;
      hits.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      // A subagent's later transcript file repeats the history it continued from.
      const existing = results.find((item) => (item.sessionId ?? item.agentId) === id);
      const seenIds = new Set(existing?.seen ?? []);
      const fresh = hits.filter((hit) => !seenIds.has(hit.entryId) && seenIds.add(hit.entryId));
      if (existing) {
        existing.seen = [...seenIds];
        existing.matches += fresh.length;
        existing.hits.push(...fresh.slice(0, Math.max(0, INSPECT_LIMITS.hitsPerTarget - existing.hits.length)));
        continue;
      }
      if (!fresh.length) continue;
      const shown = fresh.slice(0, INSPECT_LIMITS.hitsPerTarget);
      const hitCount = fresh.length;
      if (who.kind === 'conversation') {
        results.push({ kind: 'conversation', sessionId: id, title: titleOf(id) ?? null, cwd: who.cwd, updatedAt: ms(Math.round(mtime)), matches: hitCount, hits: shown, seen: [...seenIds] });
      } else {
        const row = who.record ? agentRow(who.record, who.teams) : { agentId: id, name: id };
        results.push({ kind: who.record && memberOf(who.teams, id) ? 'team-member' : 'subagent', agentId: id, name: row.name,
          parentSessionId: who.record?.parent_session_id ?? null, ...(row.team ? { team: row.team } : {}), cwd: who.cwd,
          updatedAt: ms(Math.round(mtime)), matches: hitCount, hits: shown, seen: [...seenIds] });
      }
    }
    for (const item of results) delete item.seen;
    return { results, truncated, ...(budgetHit ? { stoppedEarly: 'time budget reached; narrow with cwd or sessionId' } : {}) };
  }

  return { stateDirs, findAgent, related, agent, notes, boards, search };
}
