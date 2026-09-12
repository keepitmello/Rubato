import { createHash, randomUUID } from 'node:crypto';

export const textOf = (message, type = 'text') => typeof message?.content === 'string'
  ? type === 'text' ? message.content : ''
  : (message?.content ?? []).filter((part) => part.type === type).map((part) => part[type] ?? '').join('');
export const messageKey = (sessionId, message) => `pi:${sessionId}:${createHash('sha256')
  .update(JSON.stringify([message.role, message.timestamp, message.model ?? null])).digest('hex').slice(0, 24)}`;
export const importedId = (instanceId, sessionId, message) => `import:${instanceId}:${messageKey(sessionId, message)}`;
const toolType = (name) => name === 'bash' ? 'command_execution' : ['write', 'edit'].includes(name) ? 'file_change' : 'dynamic_tool_call';

/** Only T3-normalized events leave this boundary; no Pi protocol types in UI. */
export class EventProjection {
  constructor({ threadId, sessionId, instanceId, emit }) {
    Object.assign(this, { threadId, sessionId, instanceId, emit });
    this.text = new Map(); this.thinking = new Map(); this.completed = new Set(); this.questions = new Map();
  }
  event(type, payload, fields = {}) {
    this.emit({ eventId: randomUUID(), provider: 'rubato-pi', providerInstanceId: this.instanceId,
      threadId: this.threadId, createdAt: new Date().toISOString(),
      ...(this.turnId ? { turnId: this.turnId } : {}), ...fields, type, payload });
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
  project(event) {
    switch (event.type) {
      case 'agent_start': this.begin(); break;
      case 'agent_settled': this.settle(); break;
      case 'message_start': case 'message_update': this.message(event.message, false); break;
      case 'message_end': this.message(event.message, true); break;
      case 'extension_ui_request': this.question(event); break;
      case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': {
        const type = event.type === 'tool_execution_start' ? 'item.started' : event.type === 'tool_execution_end' ? 'item.completed' : 'item.updated';
        this.event(type, { itemType: toolType(event.toolName), title: event.toolName || 'Tool',
          status: event.type === 'tool_execution_end' ? event.isError ? 'failed' : 'completed' : 'inProgress',
          data: event.result ?? event.partialResult ?? event.args ?? {} }, { itemId: `pi-tool:${this.sessionId}:${event.toolCallId}` });
        break;
      }
      case 'auto_compaction_end': this.event('thread.state.changed', { state: 'compacted' }); break;
    }
  }
}
