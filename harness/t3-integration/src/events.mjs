import { createHash, randomUUID } from 'node:crypto';

export const textOf = (message, type = 'text') => typeof message?.content === 'string'
  ? type === 'text' ? message.content : ''
  : (message?.content ?? []).filter((part) => part.type === type).map((part) => part[type] ?? '').join('');
export const messageKey = (sessionId, message) => `pi:${sessionId}:${createHash('sha256')
  .update(JSON.stringify([message.role, message.timestamp, message.model ?? null])).digest('hex').slice(0, 24)}`;
export const importedId = (instanceId, sessionId, message) => `import:${instanceId}:${messageKey(sessionId, message)}`;

// Spawn opens a child. Peek/steer/board tools are ordinary calls even when the
// name contains "agent". Do not copy Claude's includes("agent") heuristic.
const SPAWN_TOOLS = new Set(['Agent', 'task', 'team_create']);
const CANCEL_TOOLS = new Set(['AgentCancel']);
const nonempty = (value) => {
  if (typeof value !== 'string') return;
  const text = value.trim();
  return text ? text : undefined;
};
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
const spawnLabel = (args, result) => nonempty(args.summary) || nonempty(detailsOf(result).task_summary)
  || nonempty(args.description) || nonempty(detailsOf(result).name) || nonempty(args.team_name)
  || nonempty(detailsOf(result).team_name) || (nonempty(args.prompt) ? nonempty(args.prompt).slice(0, 200) : undefined);
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
const liveFacts = (item) => {
  const live = record(item.live_progress);
  return {
    currentTool: nonempty(live.current_tool) || nonempty(live.currentTool),
    lastAssistantLine: nonempty(live.last_assistant_line) || nonempty(live.lastAssistantLine),
    totalTokens: live.total_tokens ?? live.totalTokens,
    outputTokens: live.output_tokens ?? live.outputTokens,
    toolCalls: live.tool_calls ?? live.toolCalls,
  };
};
const taskUsageOf = (item, live) => {
  const stats = record(item.run_stats);
  const total = asInt(live.totalTokens) ?? asInt(stats.total_tokens);
  if (total === undefined) return;
  const output = asInt(live.outputTokens) ?? asInt(stats.output_tokens);
  const tools = asInt(live.toolCalls) ?? asInt(stats.tool_calls);
  const duration = asInt(stats.runtime_ms);
  return {
    totalTokens: total,
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(tools !== undefined ? { toolUses: tools } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
  };
};
const FAILED_STATUS = new Set(['failed', 'error', 'denied', 'lost']);
const STOPPED_STATUS = new Set(['cancelled', 'aborted', 'interrupted']);
const LIVE_STATUS = new Set(['pending', 'running', 'waiting', 'idle']);
export const toolType = (name) => SPAWN_TOOLS.has(name) ? 'collab_agent_tool_call'
  : name === 'bash' ? 'command_execution' : ['write', 'edit'].includes(name) ? 'file_change' : 'dynamic_tool_call';

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
export class EventProjection {
  constructor({ threadId, sessionId, instanceId, emit }) {
    Object.assign(this, { threadId, sessionId, instanceId, emit });
    this.text = new Map(); this.thinking = new Map(); this.completed = new Set(); this.questions = new Map();
    this.tasks = new Map(); this.children = new Map(); this.spawns = new Map();
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
    this.turnId = undefined; this.failed = false; this.interrupted = false; this.lastUsage = undefined;
    this.lastError = undefined;
    this.maxTokens = undefined;
  }
  configureUsage({ maxTokens, compactsAutomatically, replaceWindow } = {}) {
    const window = asInt(maxTokens);
    if (window > 0) this.maxTokens = window;
    else if (replaceWindow) this.maxTokens = undefined;
    if (typeof compactsAutomatically === 'boolean') this.compactsAutomatically = compactsAutomatically;
  }
  usage(raw, message) {
    if (message?.stopReason === 'error' || message?.stopReason === 'aborted') return;
    const snapshot = tokenUsageFrom(raw, { maxTokens: this.maxTokens, compactsAutomatically: this.compactsAutomatically });
    if (!snapshot) return;
    const key = JSON.stringify(snapshot);
    if (key === this.lastUsage) return;
    this.lastUsage = key;
    this.event('thread.token-usage.updated', { usage: snapshot });
  }
  begin(turnId = randomUUID()) {
    if (this.turnId) return this.turnId;
    this.turnId = turnId; this.failed = false; this.interrupted = false; this.lastError = undefined;
    this.event('turn.started', {}); return turnId;
  }
  settle() {
    if (!this.turnId) return;
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
  seed(projected) {
    for (const message of projected ?? []) {
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
    if (message?.role !== 'assistant') return;
    const itemId = messageKey(this.sessionId, message);
    for (const [type, cache, streamKind, suffix] of [['text', this.text, 'assistant_text', ''], ['thinking', this.thinking, 'reasoning_text', ':reasoning']]) {
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
      const detail = textOf(message) || (message.stopReason === 'error' ? errorDetail(message) : undefined);
      this.event('item.completed', { itemType: 'assistant_message',
        status: message.stopReason === 'error' ? 'failed' : 'completed', ...(detail ? { detail } : {}) }, { itemId });
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
        options: [{ decision: 'accept', label: '승인' }, { decision: 'decline', label: '거절' }] }, { requestId: request.id });
    } else if (['select', 'input', 'editor'].includes(request.method)) {
      this.event('user-input.requested', { questions: [{ id: request.id, header: title, question: title,
        options: (request.options ?? []).map((value) => ({ label: value, description: '', value })),
        allowCustomAnswer: request.method !== 'select', multiSelect: false }] }, { requestId: request.id });
    }
  }
  linkage(task, extra = {}) {
    const title = displaySpawnTitle(task.label, task.model, task.effort);
    return { taskType: task.taskType, agentKind: 'agent', toolUseId: task.toolUseId,
      ...(title ? { title } : {}), ...(task.role ? { role: task.role } : {}),
      ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}),
      ...(task.workflowName ? { workflowName: task.workflowName } : {}),
      ...extra };
  }
  indexTask(task, key) {
    if (!nonempty(key)) return;
    const held = this.tasks.get(key);
    if (held && held !== task) return;
    this.tasks.set(key, task);
  }
  startTask(key, { label, taskType, role, model, effort, workflowName, taskId = key, toolUseId = key } = {}) {
    const id = nonempty(taskId) || nonempty(key);
    if (!id) return;
    const existing = this.tasks.get(key) || this.tasks.get(id);
    if (existing) {
      this.indexTask(existing, key);
      this.indexTask(existing, id);
      if (nonempty(toolUseId) && toolUseId !== existing.taskId) {
        this.indexTask(existing, toolUseId);
        existing.toolUseId = toolUseId;
      }
      if (label && !existing.label) existing.label = label;
      if (role && !existing.role) existing.role = role;
      if (model && !existing.model) existing.model = model;
      if (effort && !existing.effort) existing.effort = effort;
      if (!existing.turnId && this.turnId) existing.turnId = this.turnId;
      return existing;
    }
    const task = { taskId: id, toolUseId: nonempty(toolUseId) || id, taskType, label, role, model, workflowName,
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
    this.taskEvent('task.progress', { taskId: task.taskId, description: doing,
      ...(note && note !== task.label ? { summary: note } : {}),
      ...(nonempty(lastToolName) ? { lastToolName } : {}),
      ...(status ? { status } : {}), ...(nonempty(error) ? { error } : {}),
      ...(typedUsage ? { typedUsage } : {}), ...this.linkage(task) }, task);
  }
  completeTask(task, status, summary) {
    if (task.done) return;
    task.done = true; task.terminal = status;
    this.taskEvent('task.completed', { taskId: task.taskId, status,
      ...(nonempty(summary) && summary !== task.label ? { summary } : {}), ...this.linkage(task) }, task);
    this.maybeCompleteTeam(task);
  }
  // Member ids map at children[st_…] → the team spawn key. Prefer a task stored
  // under the child id so a member tick cannot land on the team row.
  taskForChild(childId) {
    const id = nonempty(childId);
    if (!id) return;
    return this.tasks.get(id) || this.tasks.get(this.children.get(id));
  }
  maybeCompleteTeam(member) {
    const spawnKey = this.children.get(member.taskId);
    const team = this.tasks.get(spawnKey);
    if (!team || team === member || team.taskType !== 'local_workflow' || team.done) return;
    const members = [...this.children.entries()].filter(([, key]) => key === spawnKey).map(([id]) => this.tasks.get(id)).filter((task) => task && task !== team);
    if (members.length === 0 || members.some((task) => !task.done)) return;
    this.completeTask(team, members.some((task) => task.terminal === 'failed') ? 'failed' : 'completed');
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
    const label = spawnLabel(args, result);
    const taskType = event.toolName === 'team_create' ? 'local_workflow' : 'subagent';
    const workflowName = nonempty(args.team_name) || nonempty(details.team_name);
    const role = nonempty(details.subagent_type) || nonempty(args.preset);
    const model = nonempty(details.model) || nonempty(args.model);
    const effort = effortOf(args, details);
    const childId = childIdOf(details, result);
    // Do not announce a row on tool_execution_start: Agent has no agentId yet.
    // Using the tool-call id there, then the snapshot's st_ id, is the duplicate.
    const taskKey = childId || (taskType === 'local_workflow' ? event.toolCallId : undefined);
    if (childId) this.rememberChild(childId, taskType === 'local_workflow' ? event.toolCallId : childId);
    const task = taskKey ? this.startTask(taskKey, { label, taskType, role, model, effort, workflowName,
      taskId: childId || taskKey, toolUseId: event.toolCallId }) : undefined;
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
      if (event.isError || FAILED_STATUS.has(status)) this.completeTask(task, 'failed', label);
      else if (STOPPED_STATUS.has(status)) this.completeTask(task, 'stopped', label);
      else if (status === 'completed') this.completeTask(task, 'completed', label);
      for (const member of details.members ?? []) {
        const memberId = nonempty(member.task_id);
        if (!memberId) continue;
        const memberLabel = nonempty(member.task_summary) || nonempty(member.name) || label;
        this.rememberChild(memberId, event.toolCallId);
        this.startTask(memberId, { taskId: memberId, label: memberLabel, taskType: 'subagent',
          role: nonempty(member.role), model: nonempty(member.model) || model, effort: effortOf(member, member) || effort,
          workflowName: workflowName || label, toolUseId: event.toolCallId });
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
      if (!task || task.done) continue;
      const status = nonempty(item.status);
      if (FAILED_STATUS.has(status)) this.completeTask(task, 'failed', label);
      else if (STOPPED_STATUS.has(status)) this.completeTask(task, 'stopped', label);
      else if (status === 'completed') this.completeTask(task, 'completed', nonempty(item.final_response) || label);
      else {
        const doing = live.lastAssistantLine || live.currentTool;
        const typedUsage = taskUsageOf(item, live);
        const mapped = LIVE_STATUS.has(status) ? status : 'running';
        if (!doing && !typedUsage && mapped === 'running') continue;
        this.progressTask(task, { description: doing || 'running', summary: live.lastAssistantLine,
          lastToolName: live.currentTool, status: mapped, typedUsage });
      }
    }
  }
  project(event) {
    switch (event.type) {
      case 'agent_start': this.begin(); break;
      case 'agent_settled': this.settle(); break;
      case 'message_start': case 'message_update':
        this.message(event.message, false);
        if (event.assistantMessageEvent?.type === 'thinking_end') this.endReasoning(event.message);
        this.usage(event.usage ?? event.message?.usage, event.message);
        break;
      case 'message_end':
        this.message(event.message, true);
        this.usage(event.message?.usage ?? event.usage, event.message);
        break;
      case 'extension_ui_request': this.question(event); break;
      case 'extension_event': this.taskUpdated(event); break;
      case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': {
        const itemType = toolType(event.toolName);
        const spawn = SPAWN_TOOLS.has(event.toolName);
        const title = spawn ? (event.toolName === 'team_create' ? 'Team' : 'Subagent task') : (event.toolName || 'Tool');
        const rawLabel = spawn ? spawnLabel(record(event.args), event.result ?? event.partialResult ?? {}) : undefined;
        const detail = rawLabel ? displaySpawnTitle(rawLabel) : undefined;
        const type = event.type === 'tool_execution_start' ? 'item.started' : event.type === 'tool_execution_end' ? 'item.completed' : 'item.updated';
        const data = { ...record(event.result ?? event.partialResult ?? event.args ?? {}), toolCallId: event.toolCallId };
        this.event(type, { itemType, title, status: event.type === 'tool_execution_end' ? event.isError ? 'failed' : 'completed' : 'inProgress',
          ...(detail ? { detail } : {}), data },
          { itemId: spawn ? event.toolCallId : `pi-tool:${this.sessionId}:${event.toolCallId}` });
        if (spawn) this.spawnTool(event);
        else if (CANCEL_TOOLS.has(event.toolName)) this.cancelTool(event);
        break;
      }
      case 'compaction_end':
        if (event.aborted) break;
        this.sawCompaction = true;
        this.event('thread.state.changed', { state: 'compacted' });
        break;
      case 'auto_compaction_end':
        this.sawCompaction = true;
        this.event('thread.state.changed', { state: 'compacted' });
        break;
    }
  }
}
