// What `/rubato/session-state?threadId=` answers on T3's V2 orchestrator: the session's Speed
// Index, its agents and teams for the Agents panel and the chat's spawn rows, and the prompt
// cache behind the context ring. Upstream's Pi adapter has no place for these (it maps only
// a tool named `subagent`), so the panel reads them here.
//
// The agent rules are V1's (events.mjs EventProjection): a resident team member that ends its
// turn rests (`idle`: the panel reads it as Waiting, and as not working), not done; an agent revived by AgentSend works again; a team follows its
// members; boards ride on the team. Rather than restate them, a headless projection is fed
// the same engine records and its task events are folded into rows.
import { EventProjection, cacheFrom } from './events.mjs';

// T3's `waiting` is work that needs the person, so the panel draws it as working; a member
// resting until its mail is `idle`.
const STATUS_OF_PROGRESS = { idle: 'idle', running: 'running', pending: 'running' };
const nonempty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** One session's state, fed every engine record a V2 connection receives (rpc-connection.mjs). */
export class SessionStateFold {
  // `changed()` runs after anything a GUI restart must find again (the bridge saves the fold).
  constructor({ threadId, sessionId, instanceId = 'rubato', changed = () => {} }) {
    this.threadId = threadId;
    this.changed = changed;
    this.agents = new Map();
    this.speedIndex = null;
    this.cache = null;
    this.projection = new EventProjection({ threadId, sessionId, instanceId, emit: (event) => this.fold(event) });
  }
  get sessionId() { return this.projection.sessionId; }
  /** A fold saved by `saved()`, for the session it was saved for. */
  static restore(saved, options) {
    const fold = new SessionStateFold({ ...options, sessionId: saved.sessionId });
    // A fold saved before resting became `idle` named it `waiting`; nothing else did.
    for (const row of Array.isArray(saved.agents) ? saved.agents : [])
      if (row && typeof row.taskId === 'string') fold.agents.set(row.taskId, row.status === 'waiting' ? { ...row, status: 'idle' } : row);
    fold.speedIndex = Number.isInteger(saved.speedIndex) ? saved.speedIndex : null;
    // The links behind the rows too: a resident member's next tick, its team's end and a new
    // board need them, not only the rows they made.
    fold.projection.restoreTasks(saved.projection);
    return fold;
  }
  /** What a GUI restart restores: the cache is asked again on attach, so it stays out. */
  saved() {
    return { sessionId: this.sessionId, speedIndex: this.speedIndex, agents: [...this.agents.values()],
      projection: this.projection.savedTasks() };
  }
  rebind(sessionId) {
    if (this.projection.sessionId === sessionId) return;
    // Another conversation now: nothing of the previous one's agents, speed or cache applies.
    this.projection.reset(sessionId);
    this.agents.clear();
    this.speedIndex = null;
    this.cache = null;
    this.changed();
  }
  feed(event) {
    try { this.projection.project(event); } catch { /* a record the panel cannot read changes nothing */ }
  }
  fold(event) {
    const payload = event.payload ?? {};
    if (event.type === 'thread.metadata.updated' && payload.metadata && 'speedIndex' in payload.metadata) {
      const speed = payload.metadata.speedIndex;
      this.speedIndex = Number.isInteger(speed) ? speed : null;
      this.changed();
      return;
    }
    if (!['task.started', 'task.updated', 'task.progress', 'task.completed'].includes(event.type)) return;
    const taskId = nonempty(payload.taskId);
    if (!taskId) return;
    const row = this.agents.get(taskId) ?? { taskId, startedAt: event.createdAt };
    for (const key of ['label', 'title', 'modelLabel', 'model', 'effort', 'role', 'memberName', 'parentAgentId', 'workflowName'])
      if (payload[key] !== undefined) row[key] = payload[key];
    if (payload.taskType) row.taskType = payload.taskType;
    if (payload.toolUseId) row.spawnToolCallId = payload.toolUseId;
    if (payload.lastToolName) row.lastToolName = payload.lastToolName;
    const usage = payload.typedUsage;
    if (usage) {
      for (const key of ['totalTokens', 'toolUses', 'turns', 'speedIndex']) if (Number.isInteger(usage[key])) row[key] = usage[key];
    }
    if (payload.board) row.board = payload.board;
    if (event.type === 'task.started') { row.status = 'running'; delete row.completedAt; delete row.result; delete row.error; }
    if (event.type === 'task.progress') {
      if (payload.description && payload.description !== 'Board updated') row.activity = payload.description;
      if (payload.status) row.status = STATUS_OF_PROGRESS[payload.status] ?? row.status ?? 'running';
      if (payload.error) row.error = payload.error;
      if (payload.summary) row.summary = payload.summary;
    }
    if (event.type === 'task.completed') {
      row.status = ['completed', 'failed', 'stopped'].includes(payload.status) ? payload.status : 'completed';
      row.completedAt = event.createdAt;
      const report = payload.summary ?? row.summary;
      if (row.status === 'failed') row.error = report ?? row.error; else if (report) row.result = report;
    }
    row.status ??= 'running';
    row.updatedAt = event.createdAt;
    this.agents.set(taskId, row);
    this.changed();
  }
  setCache(value) { this.cache = value ?? null; }
  snapshot() {
    const rows = [...this.agents.values()];
    const teams = rows.filter((row) => row.taskType === 'local_workflow');
    const teamIds = new Set(teams.map((team) => team.taskId));
    const agentOf = ({ taskType: _type, workflowName: _workflow, board: _board, summary: _summary, ...row }) =>
      ({ ...row, ...(teamIds.has(row.parentAgentId) ? { teamRunId: row.parentAgentId } : {}) });
    return {
      speedIndex: this.speedIndex,
      agents: rows.filter((row) => row.taskType !== 'local_workflow').map(agentOf),
      teams: teams.map((team) => ({
        teamRunId: team.taskId, name: team.workflowName ?? team.label ?? 'Team', status: team.status,
        ...(team.spawnToolCallId ? { spawnToolCallId: team.spawnToolCallId } : {}),
        members: rows.filter((row) => row.parentAgentId === team.taskId).map((row) => row.taskId),
        board: team.board ?? { tasks: [] }, startedAt: team.startedAt, updatedAt: team.updatedAt,
        ...(team.completedAt ? { completedAt: team.completedAt } : {}),
      })),
      cache: this.cache,
    };
  }
}

/** Records after which the cache facts move (a reply, a settle, a warmer refresh). */
export const cacheMoved = (event) => event?.type === 'agent_settled'
  || (event?.type === 'message_end' && event.message?.role === 'assistant')
  || (event?.type === 'entry_appended' && event.entry?.kind === 'cache_warm');
export { cacheFrom };

/** GET /rubato/session-state?threadId=… (RubatoServiceRoute.ts hands authenticated requests here). */
export function createSessionStateService({ bridge, readAccount }) {
  return {
    async read(threadId) {
      const live = bridge();
      if (!live) return null;
      const state = live.sessionState(threadId);
      if (!readAccount) return state;
      const sessionId = live.knownState(threadId)?.sessionId;
      let account = null;
      try { if (sessionId) account = await readAccount(sessionId); } catch { /* Unknown is not a guessed account. */ }
      if (live.knownState(threadId)?.sessionId !== sessionId) {
        return { ...live.sessionState(threadId), account: null };
      }
      return { ...state, account };
    },
  };
}
export async function handleSessionStateRequest(service, request) {
  if (request.method !== 'GET') return Response.json({ error: { code: 'method', message: 'Use GET.' } }, { status: 405 });
  const threadId = new URL(request.url).searchParams.get('threadId');
  if (!threadId) return Response.json({ error: { code: 'invalid', message: 'threadId is required' } }, { status: 400 });
  return Response.json(await service.read(threadId) ?? { speedIndex: null, agents: [], teams: [], cache: null });
}
