// The status board (현황판): every team and standalone subagent the app's projects hold,
// read off disk each time it is asked, so a member that died or was evicted shows as it is
// and never as the "running" its record still says. Nothing here writes.
//
// Where it reads, per project (the same places session_read reads, session-inspect.mjs):
//   <state>/teams/runtime/<run>/state.json, task-members.json, tasks/<n>.json   a team and its board
//   <state>/tasks/st_X.json                                                    a subagent's record
//   <state>/children/st_X/sessions/st_X/*.jsonl                                its transcript
//   <state>/logs/st_X.jsonl                                                    its tool and message counts
//   <agentDir>/sessions/[<cwd dir>/]<time>_<uuid>.jsonl                          a lead's transcript
//
// What it answers are facts, not verdicts. The time rule (working until it has been quiet for
// the stall threshold) is the web's (rubatoLiveness.ts), because the page ticks between asks:
//   lifecycle   live | ended | failed | stopped | lost
//   turnOpen    its transcript ends inside a turn (a tool or the model is still to answer)
//   lastActivityAt  when its transcript last grew: session_read's clock (lastActivity)
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { agentSessionDir, jsonlFiles, lastActivity, taskStateDirs } from '../../../pi-server/src/session-inspect.mjs';
import { taskStateDir } from '../agents/transcript.mjs';

export const BOARD_LIMITS = Object.freeze({
  /** Bytes read from a transcript's end: enough for the last steps, never the whole file. */
  tailBytes: 192 * 1024,
  steps: 6,
  log: 40,
  boardItems: 40,
  text: 220,
  /** A finished standalone subagent stays on the board this long. */
  recentAgentMs: 60 * 60_000,
  standaloneMax: 16,
  /** A team that ended stays this long. */
  endedTeamMs: 30 * 60_000,
});

const LIVE_TEAM = new Set(['creating', 'active', 'shutdown_requested']);
const SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const TEAM_NAME = /^team:([^:]+):(.+)$/;

const ms = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value
  : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const clip = (text, max = BOARD_LIMITS.text) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const nonempty = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
}
async function names(dir) {
  try { return await readdir(dir); } catch { return []; }
}

/** Whether a process id is running. EPERM is a process we may not signal: it exists. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** The first line a person would read of what the model said: markdown marks and blank lines dropped. */
export function sayLine(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, '').replace(/[*_`]/g, '').trim();
    if (line && !/^\|?[-:| ]+\|?$/.test(line)) return clip(line);
  }
  return null;
}

const relativeTo = (cwd, target) => {
  if (typeof target !== 'string') return null;
  if (cwd && target.startsWith(`${cwd}/`)) return target.slice(cwd.length + 1);
  return target;
};

/** One tool call as a step line: the tool and what it touched, never its whole input. */
export function toolLine(name, args, cwd) {
  const input = args && typeof args === 'object' ? args : {};
  const tool = typeof name === 'string' && name ? name : 'tool';
  const first = (value) => nonempty(typeof value === 'string' ? value.split('\n')[0] : null);
  const detail = tool === 'bash' ? first(input.command)
    : first(relativeTo(cwd, input.path ?? input.file_path ?? input.filePath))
      ?? first(input.summary) ?? first(input.subject) ?? first(input.description) ?? first(input.query)
      ?? first(input.pattern) ?? first(input.url) ?? (typeof input.to === 'string' ? `→ ${input.to}` : null);
  return clip(detail ? `${tool} ${detail}` : tool, 120);
}

const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n') : '';

/**
 * What a transcript's last bytes say. A turn is open when the last message is not the model
 * ending its turn: a tool call still waiting on its result, a result the model has not answered,
 * or a message it has not answered yet. Bookkeeping entries do not count either way.
 */
export function transcriptFacts(text, { cwd } = {}) {
  const steps = [];
  let last = null;
  let model = null;
  let pendingTool = null;
  let narration = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const at = ms(entry?.timestamp) ?? ms(entry?.message?.timestamp);
    if (entry?.type === 'custom_message') { last = { role: 'message' }; continue; }
    if (entry?.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    if (message.role === 'assistant') {
      if (typeof message.model === 'string' && message.model) model = message.provider ? `${message.provider}/${message.model}` : message.model;
      const parts = Array.isArray(message.content) ? message.content : [];
      const said = sayLine(textOf(parts));
      if (said) { steps.push({ at, kind: 'say', text: said }); narration = { at, text: said }; }
      const calls = parts.filter((part) => part?.type === 'toolCall');
      for (const call of calls) steps.push({ at, kind: 'tool', text: toolLine(call.name, call.arguments, cwd) });
      pendingTool = calls.length > 0 ? String(calls.at(-1).name ?? 'tool') : null;
      last = { role: 'assistant', stopReason: message.stopReason ?? null, calls: calls.length };
    } else if (message.role === 'toolResult') {
      last = { role: 'toolResult' };
      pendingTool = null;
    } else if (message.role === 'user') {
      last = { role: 'user' };
      pendingTool = null;
    }
  }
  const turnOpen = last !== null && !(last.role === 'assistant' && last.calls === 0);
  return { steps: steps.slice(-BOARD_LIMITS.steps), allSays: steps.filter((step) => step.kind === 'say'),
    narration, model, turnOpen, pendingTool: turnOpen ? pendingTool : null };
}

// Parsed tails and counts by file and version, so an unchanged transcript is not read again.
const tails = new Map();
const counts = new Map();

async function tailFacts(file, cwd) {
  const info = await stat(file).catch(() => undefined);
  if (!info) return null;
  const version = `${info.size}:${Math.trunc(info.mtimeMs)}`;
  const held = tails.get(file);
  if (held?.version === version) return held.facts;
  let text = '';
  let handle;
  try {
    handle = await open(file, 'r');
    const length = Math.min(info.size, BOARD_LIMITS.tailBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    text = buffer.toString('utf8');
    // A cut first line is not an entry.
    if (length < info.size) text = text.slice(text.indexOf('\n') + 1);
  } catch { return null; } finally { await handle?.close(); }
  const facts = transcriptFacts(text, { cwd });
  tails.set(file, { version, facts });
  return facts;
}

/** Tool calls and messages a child made, counted from its runner's event log as it grows. */
async function logCounts(file) {
  const info = await stat(file).catch(() => undefined);
  if (!info) return null;
  let held = counts.get(file);
  if (!held || info.size < held.offset) held = { offset: 0, tools: 0, messages: 0, rest: '' };
  if (info.size > held.offset) {
    let handle;
    try {
      handle = await open(file, 'r');
      const buffer = Buffer.alloc(info.size - held.offset);
      await handle.read(buffer, 0, buffer.length, held.offset);
      const lines = (held.rest + buffer.toString('utf8')).split('\n');
      const rest = lines.pop() ?? '';
      let { tools, messages } = held;
      for (const line of lines) {
        if (line.includes('"type":"tool_execution"')) tools += 1;
        else if (line.includes('"type":"assistant_message"')) messages += 1;
      }
      held = { offset: info.size, tools, messages, rest };
    } catch { return null; } finally { await handle?.close(); }
    counts.set(file, held);
  }
  return { toolCalls: held.tools, messages: held.messages };
}

/** A record's model as the engine resolved it, `provider/model`, and its effort. */
const modelOf = (record) => {
  const resolved = record?.resolved_model;
  const name = nonempty(resolved?.display) ?? nonempty(record?.model);
  const effort = nonempty(resolved?.reasoning) ?? nonempty(resolved?.reasoning_effort);
  return { model: name, effort };
};

/**
 * Where a child stands, from its record and whether the process that runs it is alive. A record
 * keeps "running" after its process died or its member was evicted; those read as lost.
 */
export function lifecycleOf(record, { alive } = {}) {
  if (!record) return 'lost';
  const status = record.status;
  if (status === 'error') return 'failed';
  if (status === 'cancelled' || status === 'interrupted') return 'stopped';
  if (status === 'lost') return 'lost';
  const resident = record.residency_state === 'resident';
  if (status === 'completed' && !resident) return 'ended';
  if (!resident && record.residency_state !== undefined && status !== 'pending') return 'lost';
  if (alive === false) return 'lost';
  return 'live';
}

function runnerPid(record) {
  return record?.execution_mode === 'process' && Number.isInteger(record.pid) ? record.pid : record?.host_pid;
}

async function childNode(stateDir, taskId, record, { cwd, alive = processAlive }) {
  const files = await jsonlFiles(agentSessionDir(stateDir, taskId));
  const transcript = files.at(-1);
  const [facts, tally, lastAt] = await Promise.all([
    transcript ? tailFacts(transcript, cwd) : null,
    logCounts(path.join(stateDir, 'logs', `${taskId}.jsonl`)),
    lastActivity(files),
  ]);
  const { model, effort } = modelOf(record);
  const pid = runnerPid(record);
  const lifecycle = lifecycleOf(record, { alive: pid === undefined ? null : alive(pid) });
  const sessionId = transcript ? (path.basename(transcript).match(SESSION_FILE)?.[1] ?? null) : null;
  return {
    id: taskId,
    sessionId,
    task: nonempty(record?.task_summary),
    model: model ?? facts?.model ?? null,
    effort,
    status: record?.status ?? null,
    lifecycle,
    // A child that has not written its first message yet is starting, which is a turn.
    turnOpen: facts ? facts.turnOpen : record?.status === 'pending' || record?.status === 'running',
    pendingTool: facts?.pendingTool ?? null,
    lastActivityAt: lastAt ?? ms(record?.updated_at) ?? ms(record?.created_at),
    startedAt: ms(record?.created_at),
    // A lost run's record never heard it end: it ran until it last moved.
    endedAt: lifecycle === 'live' ? null : lifecycle === 'lost' ? (lastAt ?? ms(record?.updated_at)) : ms(record?.updated_at),
    narration: facts?.narration?.text ?? null,
    steps: facts?.steps ?? [],
    says: facts?.allSays ?? [],
    toolCalls: tally?.toolCalls ?? null,
    messages: tally?.messages ?? null,
    parentSessionId: nonempty(record?.parent_session_id),
  };
}

// Lead transcripts by session uuid. A miss is asked again after a minute, not on every poll.
const leadFiles = new Map();
const MISS_RETRY_MS = 60_000;

export const piAgentDir = (env = process.env) =>
  nonempty(env.RUBATO_PI_CODING_AGENT_DIR) ?? nonempty(env.PI_CODING_AGENT_DIR) ?? path.join(homedir(), '.rubato-pi', 'agent');
/** Pi's folder name for a cwd's CLI sessions: `/a/b` → `--a-b--`. */
const cwdFolder = (cwd) => `--${cwd.replace(/^\/+/, '').replace(/[/\\:]/g, '-')}--`;

async function leadFile(agentDir, sessionId, cwd, now) {
  const held = leadFiles.get(sessionId);
  if (held?.file) return held.file;
  if (held && now - held.missedAt < MISS_RETRY_MS) return null;
  const sessions = path.join(agentDir, 'sessions');
  const suffix = `_${sessionId}.jsonl`;
  for (const dir of [sessions, ...(cwd ? [path.join(sessions, cwdFolder(cwd))] : [])]) {
    const hit = (await names(dir)).find((name) => name.endsWith(suffix));
    if (hit) {
      const file = path.join(dir, hit);
      leadFiles.set(sessionId, { file });
      return file;
    }
  }
  leadFiles.set(sessionId, { missedAt: now });
  return null;
}

async function leadNode(sessionId, { agentDir, cwd, now }) {
  const file = sessionId ? await leadFile(agentDir, sessionId, cwd, now) : null;
  const [facts, lastAt] = file ? await Promise.all([tailFacts(file, cwd), lastActivity([file])]) : [null, null];
  return {
    id: sessionId ?? 'lead',
    sessionId: sessionId ?? null,
    name: 'lead',
    role: 'lead',
    task: null,
    model: facts?.model ?? null,
    effort: null,
    status: null,
    // A lead is the person's own conversation: the engine keeps it, so it is never lost here.
    lifecycle: 'live',
    turnOpen: facts?.turnOpen ?? false,
    pendingTool: facts?.pendingTool ?? null,
    lastActivityAt: lastAt,
    startedAt: null,
    endedAt: null,
    narration: facts?.narration?.text ?? null,
    steps: facts?.steps ?? [],
    says: facts?.allSays ?? [],
    toolCalls: null,
    messages: null,
    parentSessionId: null,
  };
}

const BOARD_STATUS = new Set(['pending', 'claimed', 'in_progress', 'completed']);

async function boardOf(runDir) {
  const dir = path.join(runDir, 'tasks');
  const files = (await names(dir)).filter((name) => /^\d+\.json$/.test(name));
  const items = (await Promise.all(files.map((name) => readJson(path.join(dir, name)))))
    .filter((item) => item && BOARD_STATUS.has(item.status))
    .map((item) => ({
      id: String(item.id),
      subject: clip(String(item.subject ?? ''), 160),
      status: item.status,
      owner: nonempty(item.owner),
      blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.map(String) : [],
      updatedAt: ms(item.updatedAt),
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  return items.slice(-BOARD_LIMITS.boardItems);
}

/** What every node said, newest last, each line with who said it. */
function logOf(nodes, since) {
  return nodes
    .flatMap((node) => node.says.filter((say) => say.at !== null && (since === null || say.at >= since))
      .map((say) => ({ at: say.at, who: node.name ?? node.id, role: node.role, text: say.text })))
    .sort((a, b) => a.at - b.at)
    .slice(-BOARD_LIMITS.log);
}

const publicNode = ({ says: _says, ...node }) => node;

async function readTeam(stateDir, runId, records, options) {
  const runDir = path.join(stateDir, 'teams', 'runtime', runId);
  const [state, roster] = await Promise.all([readJson(path.join(runDir, 'state.json')), readJson(path.join(runDir, 'task-members.json'))]);
  if (!state || typeof state !== 'object') return null;
  const updated = (await stat(path.join(runDir, 'state.json')).catch(() => undefined))?.mtimeMs ?? 0;
  const live = LIVE_TEAM.has(state.status);
  if (!live && options.now - updated > BOARD_LIMITS.endedTeamMs) return null;
  const ids = roster && typeof roster === 'object' ? roster : {};
  const members = await Promise.all((Array.isArray(state.members) ? state.members : []).map(async (member) => {
    const taskId = typeof ids[member.name] === 'string' ? ids[member.name] : null;
    const record = taskId ? records.get(taskId) : undefined;
    const node = taskId
      ? await childNode(stateDir, taskId, record, options)
      : { ...EMPTY_NODE, id: `${runId}:${member.name}` };
    // A member the lead let go is stopped, not lost, once its record is gone.
    const shutDown = member.status === 'shutdown_approved' || member.status === 'completed';
    if (shutDown && node.lifecycle !== 'live') node.lifecycle = node.lifecycle === 'ended' ? 'ended' : 'stopped';
    if (shutDown && node.lifecycle === 'live' && !record) node.lifecycle = 'stopped';
    const declared = member.model && typeof member.model === 'object' ? `${member.model.providerID}/${member.model.modelID}` : null;
    return { ...node, name: member.name, role: member.kind ?? 'member', model: node.model ?? declared };
  }));
  const lead = await leadNode(nonempty(state.leadSessionId), { ...options, cwd: options.cwd });
  const startedAt = ms(state.createdAt);
  return {
    kind: 'team',
    id: runId,
    name: nonempty(state.teamName) ?? runId.slice(0, 8),
    status: state.status ?? null,
    cwd: options.cwd,
    startedAt,
    lead: publicNode(lead),
    members: members.map(publicNode),
    board: await boardOf(runDir),
    log: logOf([lead, ...members], startedAt),
  };
}

const EMPTY_NODE = Object.freeze({
  id: '', sessionId: null, task: null, model: null, effort: null, status: null, lifecycle: 'lost', turnOpen: false,
  pendingTool: null, lastActivityAt: null, startedAt: null, endedAt: null, narration: null, steps: [], says: [],
  toolCalls: null, messages: null, parentSessionId: null,
});

/** Every record in a state dir by task id; unreadable ones are skipped. */
async function recordsOf(stateDir) {
  const dir = path.join(stateDir, 'tasks');
  const files = (await names(dir)).filter((name) => /^st_[0-9a-z]+\.json$/i.test(name));
  const records = new Map();
  await Promise.all(files.map(async (name) => {
    const record = await readJson(path.join(dir, name));
    if (record && typeof record.task_id === 'string') records.set(record.task_id, record);
  }));
  return records;
}

async function readProject(cwd, options) {
  const dirs = [...new Set([await taskStateDir(cwd).catch(() => null), ...taskStateDirs(cwd)].filter(Boolean))];
  const groups = [];
  for (const stateDir of dirs) {
    const records = await recordsOf(stateDir);
    const teams = (await Promise.all((await names(path.join(stateDir, 'teams', 'runtime')))
      .map((runId) => readTeam(stateDir, runId, records, { ...options, cwd })))).filter(Boolean);
    groups.push(...teams);
    // Standalone subagents: live ones, and ones that ended a short while ago, by the session that started them.
    const memberIds = new Set([...records.values()].filter((record) => TEAM_NAME.test(record.name ?? '')).map((record) => record.task_id));
    const standalone = [...records.values()]
      .filter((record) => !memberIds.has(record.task_id))
      .filter((record) => {
        const quietFor = options.now - (ms(record.updated_at) ?? 0);
        return record.status === 'running' || record.status === 'pending' || quietFor <= BOARD_LIMITS.recentAgentMs;
      })
      .sort((a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0))
      .slice(-BOARD_LIMITS.standaloneMax);
    if (standalone.length === 0) continue;
    const nodes = await Promise.all(standalone.map((record) => childNode(stateDir, record.task_id, record, { ...options, cwd })));
    // A subagent a team member started sits under that member's name.
    const memberBySession = new Map(teams.flatMap((team) => team.members.filter((member) => member.sessionId)
      .map((member) => [member.sessionId, { team: team.name, member: member.name }])));
    const byParent = new Map();
    for (const node of nodes) {
      const key = node.parentSessionId ?? 'unknown';
      byParent.set(key, [...(byParent.get(key) ?? []), node]);
    }
    for (const [parent, children] of byParent) {
      const owner = memberBySession.get(parent);
      const lead = owner
        ? { ...EMPTY_NODE, id: parent, sessionId: parent, name: owner.member, role: 'member', lifecycle: 'live' }
        : await leadNode(parent === 'unknown' ? null : parent, { ...options, cwd });
      const named = children.map((node) => ({ ...node, name: node.task ?? node.id, role: 'subagent' }));
      const startedAt = Math.min(...named.map((node) => node.startedAt ?? Infinity));
      groups.push({
        kind: 'agents',
        id: `agents:${parent}`,
        name: owner ? `${owner.team} · ${owner.member}` : null,
        status: null,
        cwd,
        startedAt: Number.isFinite(startedAt) ? startedAt : null,
        lead: publicNode(lead),
        members: named.map(publicNode),
        board: null,
        log: logOf(named, null),
      });
    }
  }
  return groups;
}

/**
 * The board for these project folders. `alive` and `agentDir` are seams for tests; `now` is
 * the server's clock, sent along so the page can count from it.
 */
export async function readStatusBoard({ cwds = [], now = Date.now(), agentDir = piAgentDir(), alive = processAlive } = {}) {
  const folders = [...new Set(cwds.filter((cwd) => typeof cwd === 'string' && path.isAbsolute(cwd)).map((cwd) => path.resolve(cwd)))];
  const groups = (await Promise.all(folders.map((cwd) => readProject(cwd, { now, agentDir, alive }).catch(() => [])))).flat();
  // Teams first, oldest first: an update never reshuffles what stays on screen.
  groups.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'team' ? -1 : 1) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return { now, groups };
}
