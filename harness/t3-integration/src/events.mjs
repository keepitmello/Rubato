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
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const detailsOf = (value) => {
  const body = record(value);
  return record(body.details?.details ? body.details : body.details ?? (body.agentId || body.childId || body.progress ? body : {}));
};
const spawnLabel = (args, result) => nonempty(args.summary) || nonempty(detailsOf(result).task_summary)
  || nonempty(args.description) || nonempty(detailsOf(result).name) || nonempty(args.team_name)
  || nonempty(detailsOf(result).team_name) || (nonempty(args.prompt) ? nonempty(args.prompt).slice(0, 200) : undefined);
export const toolType = (name) => SPAWN_TOOLS.has(name) ? 'collab_agent_tool_call'
  : name === 'bash' ? 'command_execution' : ['write', 'edit'].includes(name) ? 'file_change' : 'dynamic_tool_call';

/** Only T3-normalized events leave this boundary; no Pi protocol types in UI. */
export class EventProjection {
  constructor({ threadId, sessionId, instanceId, emit }) {
    Object.assign(this, { threadId, sessionId, instanceId, emit });
    this.text = new Map(); this.thinking = new Map(); this.completed = new Set(); this.questions = new Map();
    this.tasks = new Map(); this.children = new Map();
  }
  event(type, payload, fields = {}) {
    this.emit({ eventId: randomUUID(), provider: 'rubato-pi', providerInstanceId: this.instanceId,
      threadId: this.threadId, createdAt: new Date().toISOString(),
      ...(this.turnId ? { turnId: this.turnId } : {}), ...fields, type, payload });
  }
  reset(sessionId = this.sessionId) {
    this.sessionId = sessionId;
    this.text.clear(); this.thinking.clear(); this.completed.clear(); this.questions.clear();
    this.tasks.clear(); this.children.clear();
    this.turnId = undefined; this.failed = false; this.interrupted = false;
  }
  begin(turnId = randomUUID()) {
    if (this.turnId) return this.turnId;
    this.turnId = turnId; this.failed = false; this.interrupted = false;
    this.event('turn.started', {}); return turnId;
  }
  settle() {
    if (!this.turnId) return;
    this.event('turn.completed', { state: this.interrupted ? 'interrupted' : this.failed ? 'failed' : 'completed' });
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
  message(message, complete) {
    if (message?.role !== 'assistant') return;
    const itemId = messageKey(this.sessionId, message);
    for (const [type, cache, streamKind] of [['text', this.text, 'assistant_text'], ['thinking', this.thinking, 'reasoning_text']]) {
      const full = textOf(message, type);
      const previous = cache.get(itemId) ?? '';
      if (!full.startsWith(previous)) {
        this.event('runtime.error', { message: 'Stored presentation text does not match the Pi transcript', class: 'validation_error' });
        continue;
      }
      const delta = full.slice(previous.length);
      if (delta) this.event('content.delta', { streamKind, delta }, { itemId });
      cache.set(itemId, full);
    }
    if (complete && !this.completed.has(itemId)) {
      const detail = textOf(message);
      this.event('item.completed', { itemType: 'assistant_message',
        status: message.stopReason === 'error' ? 'failed' : 'completed', ...(detail ? { detail } : {}) }, { itemId });
      this.completed.add(itemId);
      if (message.stopReason === 'error') this.failed = true;
      if (message.stopReason === 'aborted') this.interrupted = true;
    }
  }
  question(request) {
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
    return { taskType: task.taskType, agentKind: 'agent', toolUseId: task.toolUseId,
      ...(task.label ? { title: task.label } : {}), ...(task.role ? { role: task.role } : {}),
      ...(task.model ? { model: task.model } : {}), ...(task.workflowName ? { workflowName: task.workflowName } : {}),
      ...extra };
  }
  startTask(toolCallId, { label, taskType, role, model, workflowName, taskId = toolCallId }) {
    if (!nonempty(toolCallId) || this.tasks.has(toolCallId)) return this.tasks.get(toolCallId);
    const task = { taskId, toolUseId: toolCallId, taskType, label, role, model, workflowName };
    this.tasks.set(toolCallId, task);
    this.event('task.started', { taskId, ...(label ? { description: label } : {}), ...this.linkage(task) });
    return task;
  }
  progressTask(task, { description, summary, lastToolName, status, error }) {
    const text = nonempty(description) || nonempty(summary) || task.label || 'Subagent task';
    this.event('task.progress', { taskId: task.taskId, description: text,
      ...(nonempty(summary) ? { summary } : {}), ...(nonempty(lastToolName) ? { lastToolName } : {}),
      ...(status ? { status } : {}), ...(nonempty(error) ? { error } : {}), ...this.linkage(task) });
  }
  completeTask(task, status, summary) {
    if (task.done) return;
    task.done = true; task.terminal = status;
    this.event('task.completed', { taskId: task.taskId, status,
      ...(nonempty(summary) ? { summary } : {}), ...this.linkage(task) });
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
    if (id) this.children.set(id, toolCallId);
  }
  spawnTool(event) {
    const args = record(event.args);
    const result = event.result ?? event.partialResult ?? {};
    const details = detailsOf(result);
    const progress = record(details.progress?.activity ? details : record(result).progress ? result : {});
    const label = spawnLabel(args, result);
    const taskType = event.toolName === 'team_create' ? 'local_workflow' : 'subagent';
    const workflowName = nonempty(args.team_name) || nonempty(details.team_name);
    const task = this.startTask(event.toolCallId, { label, taskType,
      role: nonempty(details.subagent_type) || nonempty(args.preset),
      model: nonempty(details.model) || nonempty(args.model), workflowName });
    this.rememberChild(details.agentId || details.childId || progress.childId, event.toolCallId);
    if (event.type === 'tool_execution_update' && task) {
      const activity = nonempty(progress.progress?.activity) || nonempty(progress.activity);
      const summary = nonempty(progress.lastAssistantLine) || activity;
      const lastToolName = nonempty(progress.currentTool);
      if (activity || summary || lastToolName) this.progressTask(task, { description: activity || label, summary, lastToolName, status: 'running' });
    }
    if (event.type === 'tool_execution_end' && task && !task.done) {
      const status = nonempty(details.status);
      const failed = event.isError || status === 'failed' || status === 'error' || status === 'denied';
      const stopped = status === 'cancelled' || status === 'aborted';
      // Agent spawn returns while the child is still running. Completing the
      // task here would tell mobile the subagent finished at ack time.
      if (failed) this.completeTask(task, 'failed', label);
      else if (stopped) this.completeTask(task, 'stopped', label);
      else if (status === 'completed') this.completeTask(task, 'completed', label);
      else this.progressTask(task, { description: label, status: status === 'pending' ? 'pending' : 'running' });
      for (const member of details.members ?? []) {
        const memberId = nonempty(member.task_id);
        if (!memberId) continue;
        const memberLabel = nonempty(member.task_summary) || nonempty(member.name) || label;
        this.rememberChild(memberId, event.toolCallId);
        this.startTask(memberId, { taskId: memberId, label: memberLabel, taskType: 'subagent',
          role: nonempty(member.role), workflowName: workflowName || label });
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
  taskUpdated(event) {
    if (event.name !== 'rubato.task.updated') return;
    const tasks = record(event.data).tasks;
    if (!Array.isArray(tasks)) return;
    for (const raw of tasks) {
      const item = record(raw);
      const childId = nonempty(item.task_id);
      if (!childId) continue;
      const live = record(item.live_progress);
      const label = nonempty(item.task_summary) || nonempty(item.name) || nonempty(live.activity);
      let task = this.taskForChild(childId);
      if (!task) {
        this.rememberChild(childId, childId);
        task = this.startTask(childId, { taskId: childId, label, taskType: 'subagent',
          role: nonempty(item.agent_type), model: nonempty(item.model) });
      }
      if (!task || task.done) continue;
      const status = nonempty(item.status);
      if (status === 'failed' || status === 'error') this.completeTask(task, 'failed', label);
      else if (status === 'cancelled' || status === 'interrupted') this.completeTask(task, 'stopped', label);
      else if (status === 'completed') this.completeTask(task, 'completed', nonempty(item.final_response) || label);
      else {
        const activity = nonempty(live.activity);
        this.progressTask(task, { description: activity || label, summary: nonempty(live.last_assistant_line) || activity,
          lastToolName: nonempty(live.current_tool),
          status: ['pending', 'running', 'waiting', 'idle'].includes(status) ? status : 'running' });
      }
    }
  }
  project(event) {
    switch (event.type) {
      case 'agent_start': this.begin(); break;
      case 'agent_settled': this.settle(); break;
      case 'message_start': case 'message_update': this.message(event.message, false); break;
      case 'message_end': this.message(event.message, true); break;
      case 'extension_ui_request': this.question(event); break;
      case 'extension_event': this.taskUpdated(event); break;
      case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': {
        const itemType = toolType(event.toolName);
        const spawn = SPAWN_TOOLS.has(event.toolName);
        const title = spawn ? (event.toolName === 'team_create' ? 'Team' : 'Subagent task') : (event.toolName || 'Tool');
        const detail = spawn ? spawnLabel(record(event.args), event.result ?? event.partialResult ?? {}) : undefined;
        const type = event.type === 'tool_execution_start' ? 'item.started' : event.type === 'tool_execution_end' ? 'item.completed' : 'item.updated';
        this.event(type, { itemType, title, status: event.type === 'tool_execution_end' ? event.isError ? 'failed' : 'completed' : 'inProgress',
          ...(detail ? { detail } : {}), data: event.result ?? event.partialResult ?? event.args ?? {} },
          { itemId: `pi-tool:${this.sessionId}:${event.toolCallId}` });
        if (spawn) this.spawnTool(event);
        else if (CANCEL_TOOLS.has(event.toolName)) this.cancelTool(event);
        break;
      }
      case 'auto_compaction_end': this.event('thread.state.changed', { state: 'compacted' }); break;
    }
  }
}
