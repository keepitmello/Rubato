import { createHash, randomUUID } from 'node:crypto';
import { modelDisplayLabel } from './model-catalog-order.mjs';

export const textOf = (message, type = 'text') => typeof message?.content === 'string'
  ? type === 'text' ? message.content : ''
  : (message?.content ?? []).filter((part) => part.type === type).map((part) => part[type] ?? '').join('');
export const messageKey = (sessionId, message) => `pi:${sessionId}:${createHash('sha256')
  .update(JSON.stringify([message.role, message.timestamp, message.model ?? null])).digest('hex').slice(0, 24)}`;
export const importedId = (instanceId, sessionId, message) => `import:${instanceId}:${messageKey(sessionId, message)}`;

// A message another conversation sent into this one (Pi custom message
// `rubato-session-message`). Its `content` is the envelope the model reads; the
// thread shows `details.text` under the sender's title instead. T3 has no message
// role for it, so it travels as a user message with one context record of an
// open kind; the web timeline draws that record as its own bubble, and T3's
// contract keeps unknown record kinds intact. Every other custom message
// (wakes, notes) stays out of the thread.
export const SESSION_MESSAGE_TYPE = 'rubato-session-message';
export const SESSION_MESSAGE_CONTEXT_KIND = 'rubato-session';
export const SESSION_MESSAGE_ID_PREFIX = 'rubato-session:';
const CONTEXT_LABEL_MAX = 200;
export const isSessionMessage = (message) => message?.role === 'custom'
  && message.customType === SESSION_MESSAGE_TYPE && message.display !== false;
const isoFrom = (timestamp) => {
  const date = new Date(typeof timestamp === 'number' || typeof timestamp === 'string' ? timestamp : Number.NaN);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};
// The T3 message id of a session message. T3 keeps every thread's messages in one
// table keyed by message id alone (SQLite `projection_thread_messages.message_id`,
// whose upsert moves a row to the thread that wrote it last), so the id names the
// thread as well as the sender's message: a fork of the conversation carries the
// same messageId into another thread and must not take this thread's row, while a
// rewind rebinds this same thread to a new Pi session and must find the bubble it
// already shows. Hashed, because both parts may contain any character.
export const sessionMessageId = (threadId, messageId) => `${SESSION_MESSAGE_ID_PREFIX}${createHash('sha256')
  .update(JSON.stringify([threadId, messageId])).digest('hex').slice(0, 24)}`;
export function sessionMessageFrom(message, threadId) {
  if (!isSessionMessage(message)) return;
  if (typeof threadId !== 'string' || !threadId) throw new TypeError('A session message needs the T3 thread it goes to');
  const details = message.details && typeof message.details === 'object' ? message.details : {};
  const messageId = typeof details.messageId === 'string' ? details.messageId.trim() : '';
  if (!messageId || typeof details.text !== 'string') return;
  const from = details.from && typeof details.from === 'object' ? details.from : {};
  const title = (typeof from.title === 'string' ? from.title.trim() : '').slice(0, CONTEXT_LABEL_MAX);
  return {
    id: sessionMessageId(threadId, messageId),
    role: 'user',
    text: details.text,
    createdAt: isoFrom(message.timestamp),
    context: { version: 1, records: [{
      version: 1, contextId: SESSION_MESSAGE_CONTEXT_KIND, kind: SESSION_MESSAGE_CONTEXT_KIND, label: title,
      payload: { v: 1, kind: details.kind === 'create' ? 'create' : 'message', messageId,
        from: {
          ...(typeof from.sessionId === 'string' ? { sessionId: from.sessionId } : {}),
          title,
          ...(typeof from.cwd === 'string' ? { cwd: from.cwd } : {}),
        } },
    }] },
  };
}

// Spawn opens a child. Peek/steer/board tools are ordinary calls even when the
// name contains "agent". Do not copy Claude's includes("agent") heuristic.
const SPAWN_TOOLS = new Set(['Agent', 'task', 'team_create']);
const CANCEL_TOOLS = new Set(['AgentCancel']);
const nonempty = (value) => {
  if (typeof value !== 'string') return;
  const text = value.trim();
  return text ? text : undefined;
};
const firstLine = (value) => nonempty(typeof value === 'string' ? value.trim().split('\n')[0] : undefined);
// Provider errors arrive as `errorMessage`, often wrapping a JSON body. T3 paints
// `item.completed.detail` and `turn.completed.errorMessage`; empty failed items
// look like a hang because the spinner has nothing to replace.
export const errorDetail = (message) => {
  const raw = nonempty(message?.errorMessage);
  if (!raw) return;
  const start = raw.indexOf('{');
  if (start === -1) return raw;
  try {
    const parsed = JSON.parse(raw.slice(start));
    const inner = nonempty(parsed?.error?.message) || nonempty(parsed?.message);
    return inner ?? raw;
  } catch {
    return raw;
  }
};
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const hasTaskIdentity = (value) => Boolean(nonempty(value.agentId) || nonempty(value.childId) || nonempty(value.task_id));
const hasTaskBody = (value) => hasTaskIdentity(value) || nonempty(value.status) || value.progress || value.members
  || value.live_progress;
// Agent spawn is { content, details: { agentId, status, … } }. Walk one or two
// `.details` wraps so a nested payload still yields agentId — the previous
// one-liner returned the outer wrap whenever `.details.details` was truthy.
const detailsOf = (value) => {
  const body = record(value);
  const nested = record(body.details);
  const inner = record(nested.details);
  if (hasTaskBody(inner)) return inner;
  if (hasTaskBody(nested)) return nested;
  if (hasTaskBody(body)) return body;
  return nested;
};
const teamNameOf = (args, details = {}) => {
  if (nonempty(details.team_name)) return nonempty(details.team_name);
  if (args.inline_spec === undefined) return nonempty(args.team_name);
  let spec = args.inline_spec;
  if (typeof spec === 'string') {
    try { spec = JSON.parse(spec); } catch { return; }
  }
  return nonempty(record(spec).name);
};
const spawnLabel = (args, result) => nonempty(args.summary) || nonempty(detailsOf(result).task_summary)
  || nonempty(args.description) || nonempty(detailsOf(result).name)
  || teamNameOf(args, detailsOf(result)) || (nonempty(args.prompt) ? nonempty(args.prompt).slice(0, 200) : undefined);
const effortOf = (args, details, item = {}) => nonempty(item.effort) || nonempty(args.effort) || nonempty(details.effort)
  || nonempty(record(details.resolved_model).reasoning) || nonempty(record(details.resolved_model).reasoning_effort)
  || nonempty(args.thinking);
// Mobile paints title at text-sm, one line, after a 24px sparkles icon and 11px
// chevron. On a 390pt phone that is ~287px ≈ 37 Latin glyphs at 14px.
const PHONE_SPAWN_TITLE_GLYPHS = 37;
const compactModelTag = (model, effort) => {
  if (!model) return;
  let id = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  id = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-latest$/, '')
    .replace(/-contributor-free$/, '');
  if (!id) return;
  return effort ? `${id} · ${effort}` : id;
};
const glyphs = (value) => [...value];
export const displaySpawnTitle = (label, model, effort) => {
  const tag = compactModelTag(model, effort);
  const head = tag ? `${tag} · ` : '';
  if (!label) return tag;
  const text = glyphs(label);
  if (head.length + text.length <= PHONE_SPAWN_TITLE_GLYPHS) return head + label;
  const room = Math.max(1, PHONE_SPAWN_TITLE_GLYPHS - head.length - 1);
  return head + text.slice(0, room).join('').trimEnd() + '…';
};
const childIdOf = (details, fallback = {}) => nonempty(details.agentId) || nonempty(details.childId)
  || nonempty(record(details.progress).childId) || nonempty(record(fallback).childId);
// live_progress.activity is Rubato's CLI status line (title · model · turn N · $0 · Speed).
// T3 already has title/model/status/lastToolName; do not forward that packed string.
// The numeric Speed Index travels as typedUsage.speedIndex / rubato.speed.updated.
const liveFacts = (item) => {
  const live = record(item.live_progress);
  return {
    currentTool: nonempty(live.current_tool) || nonempty(live.currentTool),
    lastAssistantLine: nonempty(live.last_assistant_line) || nonempty(live.lastAssistantLine),
    totalTokens: live.total_tokens ?? live.totalTokens,
    outputTokens: live.output_tokens ?? live.outputTokens,
    toolCalls: live.tool_calls ?? live.toolCalls,
    turns: live.turns,
  };
};
const taskUsageOf = (item, live) => {
  const stats = record(item.run_stats);
  const total = asInt(live.totalTokens) ?? asInt(stats.total_tokens);
  if (total === undefined) return;
  const output = asInt(live.outputTokens) ?? asInt(stats.output_tokens);
  const tools = asInt(live.toolCalls) ?? asInt(stats.tool_calls);
  const turns = asInt(live.turns) ?? asInt(stats.turns);
  const duration = asInt(stats.runtime_ms);
  const speed = asInt(stats.speed_index);
  return {
    totalTokens: total,
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(tools !== undefined ? { toolUses: tools } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
    ...(speed !== undefined ? { speedIndex: speed } : {}),
  };
};
// The shared board of a taskforce, as the lead's runtime reports it
// (rubato.team.board.updated). Only fields the Agents panel paints travel.
const BOARD_STATUSES = new Set(['pending', 'claimed', 'in_progress', 'completed']);
const boardOf = (team) => {
  const tasks = [];
  for (const raw of Array.isArray(team.tasks) ? team.tasks : []) {
    const item = record(raw);
    const id = nonempty(item.id);
    const subject = nonempty(item.subject);
    if (!id || !subject || !BOARD_STATUSES.has(item.status)) continue;
    tasks.push({
      id, subject, status: item.status,
      description: typeof item.description === 'string' ? item.description : '',
      ...(item.description_truncated === true ? { descriptionTruncated: true } : {}),
      ...(nonempty(item.owner) ? { owner: nonempty(item.owner) } : {}),
      blockedBy: Array.isArray(item.blocked_by) ? item.blocked_by.filter((value) => nonempty(value)) : [],
      ...(nonempty(item.updated_at) ? { updatedAt: nonempty(item.updated_at) } : {}),
    });
  }
  return { tasks };
};
const FAILED_STATUS = new Set(['failed', 'error', 'denied', 'lost']);
const STOPPED_STATUS = new Set(['cancelled', 'aborted', 'interrupted']);
const LIVE_STATUS = new Set(['pending', 'running', 'waiting', 'idle']);
export const toolType = (name) => SPAWN_TOOLS.has(name) ? 'collab_agent_tool_call'
  : name === 'bash' ? 'command_execution' : ['write', 'edit'].includes(name) ? 'file_change' : 'dynamic_tool_call';
/** How a tool call reads in the thread: its item type, row title and, for a spawn, the task it was given. */
export const toolPresentation = (toolName, args, result) => {
  const spawn = SPAWN_TOOLS.has(toolName);
  const title = spawn ? (toolName === 'team_create' ? 'Team' : 'Subagent task') : (toolName || 'Tool');
  const rawLabel = spawn ? spawnLabel(record(args), result ?? {}) : undefined;
  const detail = rawLabel ? displaySpawnTitle(rawLabel) : undefined;
  return { itemType: toolType(toolName), title, ...(detail ? { detail } : {}) };
};

// Meter usedTokens is last-assistant context size, not a chars/4 estimate and not
// billed-session totals. maxTokens is the model's contextWindow when we have it.
const asInt = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
export const contextTokensOf = (usage) => {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return;
  const total = asInt(usage.totalTokens);
  if (total > 0) return total;
  const sum = (asInt(usage.input) ?? 0) + (asInt(usage.output) ?? 0)
    + (asInt(usage.cacheRead) ?? 0) + (asInt(usage.cacheWrite) ?? 0);
  return sum > 0 ? sum : undefined;
};
// The context ring's cache facts, from the engine's `get_cache_warming`. `warming.mode` is the
// global setting and `warming.enabled` this session's own switch. Times are epoch ms;
// `warming.until` is when the engine stops warming this session (its one answer, read
// as is), `warming.from` the latest input. `expiresAt` already counts the refreshes a
// scheduled warmer will still send, because T3 detaches an idle session and hears
// nothing from it after that.
const CACHE_STATES = new Set(['warm', 'cold', 'unknown']);
const WARMING_MODES = new Set(['off', 'idle', 'streaming']);
export const cacheFrom = (value) => {
  const cache = record(record(value).cache);
  const status = record(record(value).status);
  const { mode, sessionEnabled, sessionId } = record(value);
  const from = asInt(record(value).lastInputAt);
  if (!CACHE_STATES.has(cache.state) || !WARMING_MODES.has(mode)) return;
  const hitPercent = asInt(cache.hitPercent);
  const expiresAt = asInt(cache.expiresAt);
  const until = asInt(record(value).sessionUntil) ?? asInt(status.until);
  return {
    state: cache.state,
    ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
    ...(hitPercent !== undefined ? { hitPercent } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    warming: {
      mode,
      enabled: sessionEnabled !== false,
      ...(from !== undefined ? { from } : {}),
      active: status.state === 'scheduled' || status.state === 'refreshing',
      ...(until !== undefined ? { until } : {}),
    },
  };
};
export const tokenUsageFrom = (usage, extras = {}) => {
  const usedTokens = contextTokensOf(usage);
  if (usedTokens === undefined) return;
  const maxTokens = asInt(extras.maxTokens);
  const inputTokens = asInt(usage.input);
  const cachedInputTokens = asInt(usage.cacheRead);
  const outputTokens = asInt(usage.output);
  const reasoningOutputTokens = asInt(usage.reasoning);
  return {
    usedTokens, lastUsedTokens: usedTokens,
    ...(maxTokens > 0 ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens } : {}),
    ...(typeof extras.compactsAutomatically === 'boolean' ? { compactsAutomatically: extras.compactsAutomatically } : {}),
    ...(asInt(extras.speedIndex) !== undefined ? { speedIndex: asInt(extras.speedIndex) } : {}),
    ...(extras.cache ? { cache: extras.cache } : {}),
  };
};

const modelIdentityOf = (model) => {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return;
  const id = typeof model.id === 'string' && model.id ? model.id : undefined;
  if (!id) return;
  const provider = typeof model.provider === 'string' && model.provider ? model.provider : undefined;
  return provider ? `${provider}/${id}` : id;
};
const messageModelIdentityOf = (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.model && typeof message.model === 'object') return modelIdentityOf(message.model);
  const id = typeof message.model === 'string' && message.model ? message.model : undefined;
  if (!id) return;
  if (id.includes('/')) return id;
  const provider = typeof message.provider === 'string' && message.provider ? message.provider : undefined;
  return provider ? `${provider}/${id}` : id;
};
export const lastAssistantOf = (messages) => {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'compactionSummary') return;
    if (message?.role === 'assistant') return message;
  }
};
// The session's model is last-assistant, then an explicit usageModel (set_model),
// then the stored session slug. get_state's row is not consulted: on reattach it
// can still be a default catalog family.
export const usageModelIdentity = ({ usageModel, sessionModel, messages } = {}) => {
  if (typeof usageModel === 'string' && usageModel.includes('/')) return usageModel;
  const assistant = messageModelIdentityOf(lastAssistantOf(messages));
  if (assistant) return assistant;
  if (typeof sessionModel === 'string' && sessionModel.includes('/')) return sessionModel;
};
export const windowFromModels = (identity, models) => {
  if (!identity || !Array.isArray(models)) return;
  const slash = identity.indexOf('/');
  if (slash < 1) return;
  const provider = identity.slice(0, slash);
  const id = identity.slice(slash + 1);
  const match = models.find((item) => item?.provider === provider && item?.id === id);
  const window = asInt(match?.contextWindow);
  return window > 0 ? window : undefined;
};

/** Only T3-normalized events leave this boundary; no Pi protocol types in UI. */
const retries = (count) => `${count} ${count === 1 ? 'retry' : 'retries'}`;

// An agent that hands a long command to the background (or sets a monitor) ends its run
// and is woken by the completion a little later. Announcing that settle as the end of the
// turn sent "Thread completed" with only "Waiting for the tests…" on screen, and the answer
// came a minute after the notification. While Pi names a wait that will wake the agent, the
// turn stays open with a row saying what it waits on; the wake continues the same turn.
export const AWAIT_POLL_MS = 2_000;
/** The wait that ended starts the agent's next run a moment later; the turn waits that long. */
export const AWAIT_GRACE_MS = 3_000;
export const AWAIT_TITLE = 'Waiting on background work';
const AWAIT_ITEM_TYPE = 'dynamic_tool_call';
const unref = (timer) => { timer?.unref?.(); return timer; };

export class EventProjection {
  /**
   * `awaitedWakes` asks Pi for the waits that will wake the idle agent (`{ items }`); without
   * it every settle ends the turn at once. `released` hears a turn the projection closed on
   * its own after such a wait, outside any event the bridge is applying.
   */
  constructor({ threadId, sessionId, instanceId, emit, sessionMessage = () => {}, awaitedWakes, released = () => {},
    awaitTimings = { pollMs: AWAIT_POLL_MS, graceMs: AWAIT_GRACE_MS } }) {
    Object.assign(this, { threadId, sessionId, instanceId, emit, sessionMessage, awaitedWakes, released, awaitTimings });
    this.text = new Map(); this.thinking = new Map(); this.completed = new Set(); this.questions = new Map();
    this.tasks = new Map(); this.children = new Map(); this.spawns = new Map();
    this.teams = new Map(); this.boards = new Map();
    // Session messages the thread already holds. Kept across reset(): a rewind
    // rebinds the session, not the thread, and the thread keeps what it showed.
    this.delivered = new Set();
  }
  event(type, payload, fields = {}) {
    this.emit({ eventId: randomUUID(), provider: 'rubato-pi', providerInstanceId: this.instanceId,
      threadId: this.threadId, createdAt: new Date().toISOString(),
      ...(this.turnId ? { turnId: this.turnId } : {}), ...fields, type, payload });
  }
  reset(sessionId = this.sessionId) {
    this.sessionId = sessionId;
    this.text.clear(); this.thinking.clear(); this.completed.clear(); this.questions.clear();
    this.tasks.clear(); this.children.clear(); this.spawns.clear();
    this.teams.clear(); this.boards.clear();
    this.turnId = undefined; this.failed = false; this.interrupted = false; this.lastUsage = undefined;
    this.lastError = undefined; this.pendingError = undefined; this.retry = undefined;
    this.maxTokens = undefined;
    this.speedIndex = undefined;
    this.cache = undefined; this.lastRawUsage = undefined;
    this.stopAwaiting();
  }
  configureUsage({ maxTokens, compactsAutomatically, replaceWindow } = {}) {
    const window = asInt(maxTokens);
    if (window > 0) this.maxTokens = window;
    else if (replaceWindow) this.maxTokens = undefined;
    if (typeof compactsAutomatically === 'boolean') this.compactsAutomatically = compactsAutomatically;
  }
  /** Cache facts ride on the usage snapshot, so a change re-sends the last usage. */
  configureCache(value) {
    const cache = cacheFrom(value);
    if (!cache) return;
    this.cache = cache;
    if (this.lastRawUsage) this.usage(this.lastRawUsage);
  }
  usage(raw, message) {
    if (message?.stopReason === 'error' || message?.stopReason === 'aborted') return;
    const snapshot = tokenUsageFrom(raw, {
      maxTokens: this.maxTokens,
      compactsAutomatically: this.compactsAutomatically,
      speedIndex: this.speedIndex,
      cache: this.cache,
    });
    if (!snapshot) return;
    this.lastRawUsage = raw;
    const key = JSON.stringify(snapshot);
    if (key === this.lastUsage) return;
    this.lastUsage = key;
    this.event('thread.token-usage.updated', { usage: snapshot });
  }
  begin(turnId = randomUUID()) {
    // A wake (or the person's own message) during a wait continues the turn that waited.
    this.endAwaiting();
    if (this.turnId) return this.turnId;
    this.turnId = turnId; this.failed = false; this.interrupted = false; this.lastError = undefined;
    this.pendingError = undefined; this.retry = undefined;
    this.event('turn.started', {}); return turnId;
  }
  settle() {
    this.endAwaiting();
    if (!this.turnId) return;
    this.flushError();
    this.retry = undefined;
    const state = this.interrupted ? 'interrupted' : this.failed ? 'failed' : 'completed';
    // `turn.completed.errorMessage` alone does not survive: T3 keeps the reason in
    // one `session.lastError` slot, so the next failure overwrites it and the
    // timeline is left with a half-written answer and no explanation. Claude's
    // adapter emits `runtime.error` next to its failed turn for the same reason;
    // that row sits at the turn and stays.
    if (state === 'failed' && this.lastError) {
      this.event('runtime.error', { message: this.lastError, class: 'provider_error' });
    }
    this.event('turn.completed', { state, ...(state === 'failed' && this.lastError ? { errorMessage: this.lastError } : {}) });
    this.turnId = undefined;
  }
  /** Pi's agent_settled: the turn ends, unless the agent ended its run on a wait that will wake it. */
  settled() {
    if (!this.turnId || this.awaiting) return;
    if (typeof this.awaitedWakes !== 'function' || this.interrupted || this.failed) { this.settle(); return; }
    const hold = { turnId: this.turnId };
    this.awaiting = hold;
    void this.checkAwaiting(hold);
  }
  async checkAwaiting(hold) {
    let labels = [];
    try {
      const answer = await this.awaitedWakes();
      const items = Array.isArray(answer?.items) ? answer.items : [];
      labels = [...new Set(items.map((item) => nonempty(item?.description) || nonempty(item?.id)).filter(Boolean))];
    } catch { /* A runtime that cannot answer has nothing the turn should wait for. */ }
    if (this.awaiting !== hold) return;
    if (labels.length > 0) {
      hold.emptySince = undefined;
      this.showAwaiting(hold, labels.join(' · '));
      hold.timer = unref(setTimeout(() => { void this.checkAwaiting(hold); }, this.awaitTimings.pollMs));
      return;
    }
    if (hold.itemId && hold.emptySince === undefined) {
      hold.emptySince = Date.now();
      hold.timer = unref(setTimeout(() => { void this.checkAwaiting(hold); }, this.awaitTimings.graceMs));
      return;
    }
    this.settle();
    this.released();
  }
  showAwaiting(hold, detail) {
    if (hold.detail === detail) return;
    const started = !hold.itemId;
    hold.itemId ??= `rubato-wait:${this.sessionId}:${randomUUID()}`;
    hold.detail = detail;
    this.event(started ? 'item.started' : 'item.updated',
      { itemType: AWAIT_ITEM_TYPE, title: AWAIT_TITLE, detail, status: 'inProgress' }, { itemId: hold.itemId });
  }
  /** Close the wait: its row is done and the turn carries on (a wake) or ends (a settle). */
  endAwaiting() {
    const hold = this.stopAwaiting();
    if (!hold?.itemId) return;
    this.event('item.completed', { itemType: AWAIT_ITEM_TYPE, title: AWAIT_TITLE, detail: hold.detail, status: 'completed' },
      { itemId: hold.itemId });
  }
  /** Forget the wait without a word (the presentation detached or the session changed). */
  stopAwaiting() {
    const hold = this.awaiting;
    if (!hold) return;
    clearTimeout(hold.timer);
    this.awaiting = undefined;
    return hold;
  }
  seed(projected) {
    for (const message of projected ?? []) {
      if (message.id?.startsWith(SESSION_MESSAGE_ID_PREFIX)) this.delivered.add(message.id);
      if (message.id?.startsWith('assistant:pi:')) {
        const key = message.id.slice('assistant:'.length);
        const delivered = this.text.get(key) ?? '';
        if (message.text.startsWith(delivered)) this.text.set(key, message.text);
        if (!message.streaming) this.completed.add(key);
      }
      if (message.id?.startsWith(`import:${this.instanceId}:pi:`)) {
        const id = message.id.slice(`import:${this.instanceId}:`.length);
        this.text.set(id, message.text); this.completed.add(id);
      }
    }
  }
  reasoningItemId(itemId) {
    return `${itemId}:reasoning`;
  }
  endReasoning(message) {
    if (message?.role !== 'assistant') return;
    const itemId = this.reasoningItemId(messageKey(this.sessionId, message));
    if (this.completed.has(itemId)) return;
    const detail = textOf(message, 'thinking');
    if (!detail) return;
    // This closes a reasoning stream, not an assistant answer. T3 uses an
    // assistant_message's detail as fallback prose and finalizes the active
    // answer segment, so mislabelling this both leaks thoughts and cuts answers.
    this.event('item.completed', { itemType: 'reasoning', status: 'completed',
      ...(detail ? { detail } : {}) }, { itemId });
    this.completed.add(itemId);
  }
  message(message, complete) {
    // A session message lands whole, so `complete` does not apply: an attach
    // snapshot taken while its turn streams has it last and "incomplete". It goes
    // to the thread once, through the sink the T3 server binds (it is a message,
    // not a provider runtime event).
    if (isSessionMessage(message)) {
      const item = sessionMessageFrom(message, this.threadId);
      if (item && !this.delivered.has(item.id)) { this.delivered.add(item.id); this.sessionMessage(item); }
      return;
    }
    if (message?.role !== 'assistant') return;
    const itemId = messageKey(this.sessionId, message);
    // Thinking goes out before text, as Pi orders the content. T3 stamps a row
    // when its first delta lands, and a message often reaches us whole (both
    // blocks in one update): sending text first stored the thought after its
    // answer, so the "Thought" row sat under the reply it led to.
    for (const [type, cache, streamKind, suffix] of [['thinking', this.thinking, 'reasoning_text', ':reasoning'], ['text', this.text, 'assistant_text', '']]) {
      const streamId = suffix ? itemId + suffix : itemId;
      const full = textOf(message, type);
      const previous = cache.get(streamId) ?? '';
      // Not every stored item text is text we streamed. An assistant message that
      // ended in a provider error has no text in Pi, so T3 keeps the error detail
      // as the item's text; seeding that back in made this comparison fail on
      // every attach to a thread that had ever failed, and `runtime.error` fails
      // the whole session — one old timeout made the thread unresumable. The
      // cache only decides which delta to send, so a mismatch means "send none",
      // not "the transcript is broken". Keep `previous`: it is what T3 holds.
      if (!full.startsWith(previous)) continue;
      const delta = full.slice(previous.length);
      if (delta) this.event('content.delta', { streamKind, delta }, { itemId: streamId });
      cache.set(streamId, full);
    }
    if (complete && !this.completed.has(itemId)) {
      this.endReasoning(message);
      // A later assistant message means the held error was retried, not final.
      this.pendingError = undefined;
      const text = textOf(message);
      const detail = text || (message.stopReason === 'error' ? errorDetail(message) : undefined);
      const payload = { itemType: 'assistant_message',
        status: message.stopReason === 'error' ? 'failed' : 'completed', ...(detail ? { detail } : {}) };
      // An empty errored message is only an answer if nothing retries it. Pi
      // stores every failed attempt, and painting each as its own assistant row
      // stacked "Connection error." lines under a turn that went on to succeed.
      // Hold it until the retry row replaces it or the turn settles on it.
      if (message.stopReason === 'error' && !text) this.pendingError = { itemId, payload };
      else this.event('item.completed', payload, { itemId });
      this.completed.add(itemId);
      // The turn's outcome is its last assistant message, not a sticky OR over
      // the whole turn. A provider retry inside one turn lands an errored empty
      // message first and the real answer after it; the sticky flag closed that
      // finished turn as `failed` and left a red row where nothing had failed.
      this.failed = message.stopReason === 'error';
      this.interrupted = message.stopReason === 'aborted';
      this.lastError = this.failed ? errorDetail(message) : undefined;
    }
  }
  flushError() {
    const held = this.pendingError;
    this.pendingError = undefined;
    if (held) this.event('item.completed', held.payload, { itemId: held.itemId });
  }
  // One retry chain is one work-log row. T3 upserts activities by id, so each
  // attempt rewrites the same row instead of stacking another beside it.
  retryRow(message) {
    this.event('runtime.warning', { message }, { eventId: this.retry.eventId });
  }
  retryStarted(event) {
    this.pendingError = undefined;
    this.retry ??= { eventId: randomUUID() };
    this.retry.error = errorDetail(event) ?? this.retry.error ?? 'Unknown error';
    this.retryRow(`Retrying (${event.attempt}/${event.maxAttempts}): ${this.retry.error}`);
  }
  retryEnded(event) {
    if (!this.retry) return;
    const error = this.retry.error;
    if (event.success) this.retryRow(`Recovered after ${retries(event.attempt)}: ${error}`);
    else if (event.finalError === 'Retry cancelled') {
      // The CLI's Escape cancels the backoff sleep. No message follows, so the
      // last errored attempt would otherwise close the turn as a failure.
      this.interrupted = true;
      this.retryRow(`Retry cancelled at attempt ${event.attempt}: ${error}`);
    } else this.retryRow(`Failed after ${retries(event.attempt)}: ${error}`);
    this.retry = undefined;
  }
  question(request) {
    if (request.method === 'notify') {
      // notifyType is info|warning|error. T3 has no runtime.info, and runtime.error
      // fails the session and relabels the row "Runtime error". All three become
      // runtime.warning so the message the command sent is what appears.
      const message = nonempty(request.message);
      if (message) this.event('runtime.warning', { message });
      return;
    }
    // setStatus is the TUI footer; T3 has no keyed status bar. A work-log row
    // would turn ephemeral chrome into a durable notice.
    if (request.method === 'setStatus') return;
    if (this.questions.has(request.id)) return;
    this.questions.set(request.id, request);
    const title = request.title || request.message || 'Rubato request';
    if (request.method === 'confirm') {
      this.event('request.opened', { requestType: 'mcp_elicitation_approval', detail: title,
        options: [{ decision: 'accept', label: 'Approve' }, { decision: 'decline', label: 'Decline' }] }, { requestId: request.id });
    } else if (['select', 'input', 'editor'].includes(request.method)) {
      this.event('user-input.requested', { questions: [{ id: request.id, header: title, question: title,
        options: (request.options ?? []).map((value) => ({ label: value, description: '', value })),
        allowCustomAnswer: request.method !== 'select', multiSelect: false }] }, { requestId: request.id });
    }
  }
  linkage(task, extra = {}) {
    const title = displaySpawnTitle(task.label, task.model, task.effort);
    // Mobile paints only `title`, so it keeps the model tag and a phone-sized cut.
    // Web paints `label` whole and `modelLabel` on its own line, named as the picker names it.
    const modelLabel = modelDisplayLabel(task.model, task.effort);
    const label = typeof task.label === 'string' ? nonempty(task.label.replace(/\s+/g, ' ')) : undefined;
    return { taskType: task.taskType, agentKind: 'agent', toolUseId: task.toolUseId,
      ...(title ? { title } : {}), ...(label ? { label } : {}),
      ...(modelLabel ? { modelLabel } : {}), ...(task.role ? { role: task.role } : {}),
      ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}),
      ...(task.workflowName ? { workflowName: task.workflowName } : {}),
      ...(task.memberName ? { memberName: task.memberName } : {}),
      ...(task.parentAgentId ? { parentAgentId: task.parentAgentId } : {}),
      ...extra };
  }
  indexTask(task, key) {
    if (!nonempty(key)) return;
    const held = this.tasks.get(key);
    if (held && held !== task) return;
    this.tasks.set(key, task);
  }
  startTask(key, { label, taskType, role, model, effort, workflowName, memberName, parentAgentId, taskId = key, toolUseId = key } = {}) {
    const id = nonempty(taskId) || nonempty(key);
    if (!id) return;
    const existing = this.tasks.get(key) || this.tasks.get(id);
    if (existing) {
      const previousLinkage = JSON.stringify(this.linkage(existing));
      this.indexTask(existing, key);
      this.indexTask(existing, id);
      if (nonempty(toolUseId) && toolUseId !== existing.taskId) {
        this.indexTask(existing, toolUseId);
        existing.toolUseId = toolUseId;
      }
      if (label && (!existing.label || taskType === 'local_workflow')) existing.label = label;
      if (role && !existing.role) existing.role = role;
      if (model && !existing.model) existing.model = model;
      if (effort && !existing.effort) existing.effort = effort;
      if (workflowName) existing.workflowName = workflowName;
      if (memberName) existing.memberName = memberName;
      if (parentAgentId) existing.parentAgentId = parentAgentId;
      if (!existing.turnId && this.turnId) existing.turnId = this.turnId;
      // A child snapshot can precede team_create's response. Persist late
      // membership/name metadata without restarting an already settled child.
      if (JSON.stringify(this.linkage(existing)) !== previousLinkage) {
        this.taskEvent('task.updated', { taskId: existing.taskId, ...this.linkage(existing) }, existing);
      }
      return existing;
    }
    const task = { taskId: id, toolUseId: nonempty(toolUseId) || id, taskType, label, role, model, workflowName, memberName, parentAgentId,
      effort, turnId: this.turnId };
    this.indexTask(task, key);
    this.indexTask(task, id);
    this.indexTask(task, task.toolUseId);
    // Title lives on linkage. Repeating it as description made every row say the
    // same sentence twice before anything had happened.
    this.taskEvent('task.started', { taskId: id, ...this.linkage(task) }, task);
    return task;
  }
  taskEvent(type, payload, task) {
    this.event(type, payload, (!this.turnId && task?.turnId) ? { turnId: task.turnId } : {});
  }
  progressTask(task, { description, summary, lastToolName, status, error, typedUsage }) {
    const note = nonempty(summary);
    const doing = nonempty(description) || note || 'running';
    task.lastProgress = { description, summary, lastToolName, status, error, typedUsage };
    this.taskEvent('task.progress', { taskId: task.taskId, description: doing,
      ...(note && note !== task.label ? { summary: note } : {}),
      ...(nonempty(lastToolName) ? { lastToolName } : {}),
      ...(status ? { status } : {}), ...(nonempty(error) ? { error } : {}),
      ...(typedUsage ? { typedUsage } : {}), ...this.linkage(task) }, task);
  }
  /**
   * A rewind drops the turns a task was started in, and T3 drops that task's rows with
   * them. A task still running is not part of the history that was taken back, so it
   * is announced again without a turn: its row, where it was, and its team's board.
   */
  reannounce(droppedTurnIds) {
    const live = [];
    for (const task of new Set(this.tasks.values())) {
      if (!droppedTurnIds.has(task.turnId)) continue;
      task.turnId = undefined;
      if (!task.done) live.push(task);
    }
    for (const task of live) {
      this.taskEvent('task.started', { taskId: task.taskId, ...this.linkage(task) }, task);
      if (task.lastProgress) this.progressTask(task, task.lastProgress);
    }
    for (const [teamRunId, held] of this.boards) {
      if (!held.sent || !live.includes(this.teams.get(teamRunId))) continue;
      held.sent = false;
      this.sendBoard(teamRunId, held.board);
    }
  }
  completeTask(task, status, summary, typedUsage) {
    if (task.done) return;
    task.done = true; task.terminal = status;
    this.taskEvent('task.completed', { taskId: task.taskId, status,
      ...(nonempty(summary) && summary !== task.label ? { summary } : {}),
      ...(typedUsage ? { typedUsage } : {}), ...this.linkage(task) }, task);
    this.syncTeam(task);
  }
  // Member ids map at children[st_…] → the team spawn key. Prefer a task stored
  // under the child id so a member tick cannot land on the team row.
  taskForChild(childId) {
    const id = nonempty(childId);
    if (!id) return;
    return this.tasks.get(id) || this.tasks.get(this.children.get(id));
  }
  // Members map to the team_create call id, which is also the team row's toolUseId.
  teamMembers(spawnKey, team) {
    return [...this.children.entries()].filter(([, key]) => key === spawnKey).map(([id]) => this.tasks.get(id))
      .filter((task) => task && task !== team);
  }
  // The team row follows its members. All settled: it settles. All settled or resting: it rests,
  // which T3 reads as no background work (a team waiting for mail runs nothing). Anyone awake: it works.
  syncTeam(member) {
    const spawnKey = this.children.get(member.taskId);
    const team = this.tasks.get(spawnKey);
    if (!team || team === member || team.taskType !== 'local_workflow' || team.done) return;
    const members = this.teamMembers(spawnKey, team);
    if (members.length === 0) return;
    if (members.every((task) => task.done)) {
      this.completeTask(team, members.some((task) => task.terminal === 'failed') ? 'failed' : 'completed');
      return;
    }
    const resting = members.every((task) => task.done || task.restingKey !== undefined);
    if (resting === Boolean(team.resting)) return;
    team.resting = resting;
    this.progressTask(team, resting ? { description: 'waiting', status: 'idle' } : { description: 'running', status: 'running' });
  }
  // team_delete cancels the members still working and lets the resting ones go.
  teamDeleted(event) {
    if (event.type !== 'tool_execution_end' || event.isError) return;
    const details = detailsOf(event.result ?? {});
    if (details.kind !== 'deleted') return;
    const team = this.teams.get(nonempty(details.team_run_id));
    if (!team) return;
    for (const member of this.teamMembers(team.toolUseId, team)) {
      if (!member.done) this.completeTask(member, member.restingKey !== undefined ? 'completed' : 'stopped');
    }
    if (!team.done) this.completeTask(team, 'completed');
  }
  rememberChild(childId, toolCallId) {
    const id = nonempty(childId);
    if (id && nonempty(toolCallId)) this.children.set(id, toolCallId);
  }
  spawnTool(event) {
    if (event.args) this.spawns.set(event.toolCallId, record(event.args));
    const args = { ...this.spawns.get(event.toolCallId), ...record(event.args) };
    const result = event.result ?? event.partialResult ?? {};
    const details = detailsOf(result);
    const progress = record(details.progress?.activity || details.progress?.currentTool ? details : record(result).progress ? result : result);
    const taskType = event.toolName === 'team_create' ? 'local_workflow' : 'subagent';
    const workflowName = teamNameOf(args, details);
    const label = taskType === 'local_workflow' ? workflowName || 'Team' : spawnLabel(args, result);
    const role = nonempty(details.subagent_type) || nonempty(args.preset);
    const model = nonempty(details.model) || nonempty(args.model);
    const effort = effortOf(args, details);
    const childId = childIdOf(details, result);
    // Do not announce a row on tool_execution_start: Agent has no agentId yet.
    // Using the tool-call id there, then the snapshot's st_ id, is the duplicate.
    // A team row waits for the run id too: a rejected team_create never had a team,
    // and a row announced at start stayed as a failed card and caught same-name boards.
    const created = taskType === 'local_workflow' && event.type === 'tool_execution_end' && !event.isError
      && nonempty(details.team_run_id);
    const taskKey = childId || (created ? event.toolCallId : undefined);
    if (childId) this.rememberChild(childId, taskType === 'local_workflow' ? event.toolCallId : childId);
    const task = taskKey ? this.startTask(taskKey, { label, taskType, role, model, effort, workflowName,
      taskId: childId || taskKey, toolUseId: event.toolCallId }) : undefined;
    if (task && taskType === 'local_workflow' && nonempty(details.team_run_id)) this.linkTeam(details.team_run_id, task);
    if (event.type === 'tool_execution_update' && task) {
      const lastToolName = nonempty(progress.currentTool) || nonempty(progress.current_tool);
      const lastLine = nonempty(progress.lastAssistantLine) || nonempty(progress.last_assistant_line);
      if (lastToolName || lastLine) this.progressTask(task, { description: lastLine || lastToolName, summary: lastLine,
        lastToolName, status: 'running' });
    }
    if (event.type === 'tool_execution_end' && task && !task.done) {
      const status = nonempty(details.status);
      // Agent spawn returns while the child is still running. Completing the
      // task here would tell mobile the subagent finished at ack time.
      if (event.isError || FAILED_STATUS.has(status)) this.completeTask(task, 'failed', nonempty(details.reason) || label);
      else if (STOPPED_STATUS.has(status)) this.completeTask(task, 'stopped', label);
      else if (status === 'completed') this.completeTask(task, 'completed', label);
      for (const member of details.members ?? []) {
        const memberId = nonempty(member.task_id);
        if (!memberId) continue;
        const memberLabel = nonempty(member.task_summary) || nonempty(member.name) || label;
        this.rememberChild(memberId, event.toolCallId);
        this.startTask(memberId, { taskId: memberId, label: memberLabel, taskType: 'subagent',
          role: nonempty(member.role), model: nonempty(member.model) || model, effort: effortOf(member, member) || effort,
          workflowName: workflowName || label, memberName: nonempty(member.name), parentAgentId: task.taskId, toolUseId: event.toolCallId });
      }
      // Completion may have arrived before the create response linked members.
      for (const member of details.members ?? []) {
        const child = this.tasks.get(nonempty(member.task_id));
        if (child) this.syncTeam(child);
      }
    }
  }
  cancelTool(event) {
    if (event.type !== 'tool_execution_end') return;
    const args = record(event.args);
    const details = detailsOf(event.result ?? event.partialResult ?? {});
    const childId = nonempty(args.agentId) || nonempty(details.agentId);
    const task = this.taskForChild(childId) || this.tasks.get(event.toolCallId);
    if (task) this.completeTask(task, 'stopped');
  }
  // A board snapshot can arrive before team_create returns the run id, so it waits here.
  linkTeam(teamRunId, task) {
    if (this.teams.get(teamRunId) === task) return;
    this.teams.set(teamRunId, task);
    const pending = this.boards.get(teamRunId);
    if (pending && !pending.sent) this.sendBoard(teamRunId, pending.board);
  }
  sendBoard(teamRunId, board) {
    const task = this.teams.get(teamRunId);
    const key = JSON.stringify(board);
    const held = this.boards.get(teamRunId);
    if (held?.sent && held.key === key) return;
    this.boards.set(teamRunId, { board, key, sent: Boolean(task) });
    if (!task) return;
    this.taskEvent('task.progress', { taskId: task.taskId, description: 'Board updated', board,
      ...this.linkage(task) }, task);
  }
  // pi.rpc.emit("rubato.team.board.updated"): every board of a team this lead owns.
  boardUpdated(event) {
    if (event.name !== 'rubato.team.board.updated') return;
    const teams = record(event.data).teams;
    if (!Array.isArray(teams)) return;
    for (const raw of teams) {
      const team = record(raw);
      const teamRunId = nonempty(team.team_run_id);
      if (!teamRunId) continue;
      if (!this.teams.has(teamRunId)) {
        // A reattached bridge never saw team_create; the team row carries the name.
        const name = nonempty(team.team_name);
        const known = name && [...new Set(this.tasks.values())]
          .find((task) => task.taskType === 'local_workflow' && (task.workflowName === name || task.label === name));
        if (known) this.teams.set(teamRunId, known);
      }
      this.sendBoard(teamRunId, boardOf(team));
    }
  }
  // pi.rpc.emit("rubato.task.updated") leaves the worker as {type:"extension_event",name,data}.
  // Live child ticks live on that snapshot, not on the Agent tool call (which ends at spawn-ack).
  // T3's CANON log drops task.progress (transient), so absence there is not evidence of a miss.
  taskUpdated(event) {
    if (event.name !== 'rubato.task.updated') return;
    const tasks = record(event.data).tasks;
    if (!Array.isArray(tasks)) return;
    for (const raw of tasks) {
      const item = record(raw);
      const childId = nonempty(item.task_id);
      if (!childId) continue;
      const live = liveFacts(item);
      const label = nonempty(item.task_summary) || nonempty(item.name);
      let task = this.taskForChild(childId);
      if (!task) {
        this.rememberChild(childId, childId);
        task = this.startTask(childId, { taskId: childId, label, taskType: 'subagent',
          role: nonempty(item.agent_type), model: nonempty(item.model), effort: effortOf({}, item, item),
          toolUseId: childId });
      } else if (label && !task.label) task.label = label;
      if (nonempty(item.model) && !task.model) task.model = item.model;
      if (effortOf({}, item, item) && !task.effort) task.effort = effortOf({}, item, item);
      if (!task) continue;
      const status = nonempty(item.status);
      // AgentSend revives a finished agent under the same id. Ignoring every
      // snapshot after the first completion left a working agent under Finished.
      const woke = task.done && (status === 'running' || status === 'pending');
      if (task.done && !woke) continue;
      if (woke) { task.done = false; task.terminal = undefined; }
      const typedUsage = taskUsageOf(item, live);
      // A team member that ends its turn stays resident and wakes on mail or a
      // notification. That is waiting, not done: settling it here froze a
      // "Waiting on the build" member under a green check for good.
      if (status === 'completed' && item.residency_state === 'resident' && task.parentAgentId) {
        const said = live.lastAssistantLine || firstLine(item.final_response);
        const key = `${said ?? ''}\n${JSON.stringify(typedUsage ?? null)}`;
        if (task.restingKey === key) continue;
        task.restingKey = key;
        this.progressTask(task, { description: said || 'waiting', summary: said, status: 'idle', typedUsage });
        this.syncTeam(task);
        continue;
      }
      const wasResting = task.restingKey !== undefined;
      task.restingKey = undefined;
      if (FAILED_STATUS.has(status)) this.completeTask(task, 'failed', label, typedUsage);
      else if (STOPPED_STATUS.has(status)) this.completeTask(task, 'stopped', label);
      else if (status === 'completed') this.completeTask(task, 'completed', nonempty(item.final_response) || label, typedUsage);
      else {
        const doing = live.lastAssistantLine || live.currentTool;
        const mapped = LIVE_STATUS.has(status) ? status : 'running';
        if (!doing && !typedUsage && mapped === 'running' && !wasResting && !woke) continue;
        this.progressTask(task, { description: doing || 'running', summary: live.lastAssistantLine,
          lastToolName: live.currentTool, status: mapped, typedUsage });
        this.syncTeam(task);
      }
    }
  }
  // Lead Speed is a number, not the packed footer string. null means no comparable sample yet.
  speedUpdated(event) {
    if (event.name !== 'rubato.speed.updated') return;
    const data = record(event.data);
    if (!('speed' in data)) return;
    const speed = data.speed === null ? null : asInt(data.speed);
    if (data.speed !== null && speed === undefined) return;
    this.speedIndex = speed === null ? undefined : speed;
    this.event('thread.metadata.updated', { metadata: { speedIndex: speed } });
  }
  project(event) {
    switch (event.type) {
      case 'agent_start': this.begin(); break;
      case 'agent_settled': this.settled(); break;
      // Pi 세션은 첫 턴이 끝날 때 제목 확장이 주제를 보고 스스로 이름을 짓는다.
      // 그 이름이 CLI 탭과 세션 목록에 뜨는 값이고, 앱 스레드 제목도 같은 것을
      // 써야 두 화면이 갈라지지 않는다. /name 도 이 이벤트로 돌아온다.
      case 'session_info_changed':
        if (typeof event.name === 'string' && event.name.trim())
          this.event('thread.metadata.updated', { name: event.name });
        break;
      case 'message_start': case 'message_update':
        this.message(event.message, false);
        if (event.assistantMessageEvent?.type === 'thinking_end') this.endReasoning(event.message);
        this.usage(event.usage ?? event.message?.usage, event.message);
        break;
      case 'message_end':
        this.message(event.message, true);
        this.usage(event.message?.usage ?? event.usage, event.message);
        break;
      case 'auto_retry_start': this.retryStarted(event); break;
      case 'auto_retry_end': this.retryEnded(event); break;
      case 'extension_ui_request': this.question(event); break;
      case 'extension_event': this.speedUpdated(event); this.taskUpdated(event); this.boardUpdated(event); break;
      case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': {
        const spawn = SPAWN_TOOLS.has(event.toolName);
        const presentation = toolPresentation(event.toolName, event.args, event.result ?? event.partialResult);
        const type = event.type === 'tool_execution_start' ? 'item.started' : event.type === 'tool_execution_end' ? 'item.completed' : 'item.updated';
        const data = { ...record(event.result ?? event.partialResult ?? event.args ?? {}), toolCallId: event.toolCallId };
        this.event(type, { ...presentation, status: event.type === 'tool_execution_end' ? event.isError ? 'failed' : 'completed' : 'inProgress', data },
          { itemId: spawn ? event.toolCallId : `pi-tool:${this.sessionId}:${event.toolCallId}` });
        if (spawn) this.spawnTool(event);
        else if (CANCEL_TOOLS.has(event.toolName)) this.cancelTool(event);
        else if (event.toolName === 'team_delete') this.teamDeleted(event);
        break;
      }
      case 'compaction_end':
        if (event.aborted || event.errorMessage) break;
        this.sawCompaction = true;
        this.event('thread.state.changed', { state: 'compacted',
          ...(event.result?.details?.source === 'rubato-history-notes-v1'
            ? { detail: { contextMode: 'history-notes', windowId: event.result.details.window?.windowId } }
            : {}) });
        break;
      case 'auto_compaction_end':
        if (event.aborted || event.errorMessage) break;
        this.sawCompaction = true;
        this.event('thread.state.changed', { state: 'compacted' });
        break;
    }
  }
}
