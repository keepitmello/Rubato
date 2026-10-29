// Deliberately fake MODEL/RUNTIME for lifecycle stress tests. The real Pi Server,
// Client, socket and child process transport are never replaced in these tests.
import { createInterface } from 'node:readline';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { findRewindTarget, findStepTarget, REWIND_MARK } from '../../../pi-runtime/features/conversation-rewind/rewind.mjs';
const args = process.argv.slice(2);
let manager = SessionManager.open(args[args.indexOf('--session') + 1]);
let running = false;
let timer;
let ui;
let pendingWork = 0;
/** Background commands and monitors whose completion would wake the session (terminal pending-work). */
let terminalWork = 0;
// The cache warmer's live state as `get_cache_warming` reports it.
let warming = { enabled: true, hours: 2, state: 'inactive' };
// The service-tier extension's live state; `/fast on|off` flips it like the real command.
let fast = { active: false, supported: true };
let blockMessages = false;
// What `set_model` can pick and the efforts each allows; an unsupported effort drops to the nearest lower one.
const MODELS = { 'fixture/local': ['off'], 'fixture/deep': ['off', 'minimal', 'low', 'medium', 'high'] };
let model = 'fixture/local';
let thinkingLevel = 'off';
const clamp = (level) => { const allowed = MODELS[model]; const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  return order.slice(0, order.indexOf(level) + 1).findLast((item) => allowed.includes(item)) ?? 'off'; };
// What the session-link extension would have received: a steer while running, a new turn when idle.
const deliveries = [];
// Answers a test scripts for the next deliveries, as the real handler words them.
const scripted = [];
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
// Distinct timestamps: a reply's identity is its role, timestamp and model.
let clock = 0;
const tick = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
const answer = (text) => {
  const message = { role: 'assistant', timestamp: tick(), model: 'fixture', stopReason: 'stop', content: [{ type: 'text', text }] };
  manager.appendMessage(message);
  emit({ type: 'message_end', message });
};
const settle = () => { clearTimeout(timer); running = false; emit({ type: 'agent_end', messages: [] }); emit({ type: 'agent_settled' }); };
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'extension_ui_response') { ui = command; settle(); return; }
  let data = null;
  switch (command.type) {
    case 'get_state': data = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), isStreaming: running, isCompacting: false, pendingMessageCount: 0,
      model: { provider: model.split('/')[0], id: model.split('/')[1] }, thinkingLevel }; break;
    case 'get_session_stats': data = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(),
      contextUsage: { tokens: null, contextWindow: 1_000_000, percent: null } }; break;
    case 'set_model':
      if (!MODELS[`${command.provider}/${command.modelId}`]) { emit({ id: command.id, type: 'response', command: command.type, success: false, error: `Model not found: ${command.provider}/${command.modelId}` }); return; }
      model = `${command.provider}/${command.modelId}`; thinkingLevel = clamp(thinkingLevel); break;
    case 'set_thinking_level': thinkingLevel = clamp(command.level); break;
    case 'get_messages':
      if (blockMessages) return;
      data = { messages: manager.getBranch().filter((item) => item.type === 'message').map((item) => item.message) }; break;
    case 'rewind': {
      // The real rule picks the entry; moving the leaf and marking the landing is what the RPC does.
      let targetId;
      try {
        targetId = command.step !== undefined ? findStepTarget(manager.getBranch(), command.step)
          : findRewindTarget(manager.getBranch(), { keep: command.keep, skip: command.skip });
      }
      catch (failure) { emit({ id: command.id, type: 'response', command: command.type, success: false, error: failure.message }); return; }
      if (targetId === null || (command.step !== undefined && targetId === manager.getLeafId())) { data = { cancelled: false, moved: false, leafId: manager.getLeafId() }; break; }
      const from = manager.getLeafId();
      const target = manager.getEntry(targetId);
      // A step lands on its last result; a turn rewind lands before the first entry it drops.
      if (command.step !== undefined) manager.branch(targetId);
      else if (target.parentId) manager.branch(target.parentId); else manager.resetLeaf();
      manager.appendCustomEntry(REWIND_MARK, { from });
      data = { cancelled: false, moved: true, leafId: manager.getLeafId() };
      break;
    }
    case 'prompt':
      if (/^\/fast (?:on|off)$/.test(command.message)) {
        fast = { ...fast, active: fast.supported && command.message === '/fast on' };
        break;
      }
      if (command.message === '__fast_unsupported') { fast = { active: false, supported: false }; break; }
      if (command.message === '__block_messages') blockMessages = true;
      running = true;
      manager.appendMessage({ role: 'user', content: command.message, timestamp: Date.now() });
      emit({ type: 'agent_start' });
      if (command.message === 'question') emit({ type: 'extension_ui_request', method: 'select', title: 'Choose', options: ['yes', 'no'], id: 'question-1' });
      else if (command.message === 'task-tick') {
        emit({ type: 'extension_event', name: 'rubato.task.updated', data: {
          parent_session_id: manager.getSessionId(),
          tasks: [{ task_id: 'st_livechild', name: 'helper', task_summary: 'Audit auth', status: 'running', model: 'fixture/model',
            live_progress: { activity: 'Audit auth · running read src/foo.ts', started_at: Date.now(),
              current_tool: 'read src/foo.ts', last_assistant_line: 'looking at middleware', turns: 1, tool_calls: 1 } }],
        } });
        timer = setTimeout(settle, 50);
      }
      else if (command.message === 'busy-terminal' || command.message === 'idle-terminal') {
        terminalWork = command.message === 'busy-terminal' ? 1 : 0;
        timer = setTimeout(settle, 10);
      }
      else if (command.message === 'busy-children' || command.message === 'idle-children') {
        pendingWork = command.message === 'busy-children' ? 1 : 0;
        timer = setTimeout(settle, 10);
      }
      else if (command.message.startsWith('tools:')) {
        // `tools:a|b,c`: one reply per batch, calling its tools together; each answers, then
        // a closing answer. Calls made together are one rewind step.
        // A model call sits between batches, so each batch lands later than the last.
        timer = setTimeout(async () => {
          for (const batch of command.message.slice('tools:'.length).split('|')) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            const ids = batch.split(',');
            const message = { role: 'assistant', timestamp: tick(), model: 'fixture', stopReason: 'toolUse',
              content: [{ type: 'text', text: `calling ${batch}` }, ...ids.map((id) => ({ type: 'toolCall', id, name: 'read', arguments: { path: id } }))] };
            manager.appendMessage(message);
            emit({ type: 'message_end', message });
            for (const id of ids) emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: id } });
            for (const id of ids) {
              manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: id }], isError: false, timestamp: tick() });
              emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: id }] }, isError: false });
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          answer('tools done');
          settle();
        }, 20);
      }
      else if (command.message.startsWith('reply:') || command.message.startsWith('wake:')) {
        // A turn that answers; `wake:` also has a child finish afterwards and wake the lead
        // without a user message, as a completed task does.
        const text = command.message.slice(command.message.indexOf(':') + 1);
        timer = setTimeout(() => {
          answer(`answer to ${text}`);
          settle();
          if (!command.message.startsWith('wake:')) return;
          timer = setTimeout(() => {
            running = true;
            manager.appendCustomMessageEntry('rubato.task.completion', `child finished ${text}`, true);
            emit({ type: 'agent_start' });
            answer(`woke on ${text}`);
            settle();
          }, 30);
        }, 20);
      }
      else if (command.message === 'usage') {
        emit({ type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), stopReason: 'stop',
          content: [{ type: 'text', text: 'ok' }], usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, totalTokens: 105 } } });
        timer = setTimeout(settle, 10);
      }
      else if (command.message === 'warm-cache') {
        warming = { ...warming, state: warming.enabled ? 'scheduled' : 'inactive' };
        timer = setTimeout(settle, 10);
      }
      else if (command.message === 'lone') {
        emit({ type: 'message_update', message: { role: 'assistant', timestamp: Date.now(),
          content: [{ type: 'text', text: 'half of a pair \uD83D stays behind' }] } });
        timer = setTimeout(settle, 50);
      } else if (command.message === 'screenshots') {
        for (let index = 0; index < 6; index++) {
          emit({ type: 'message_update', message: { role: 'assistant', timestamp: Date.now(),
            content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(3 * 1024 * 1024) }] } });
        }
        timer = setTimeout(settle, 50);
      }
      else timer = setTimeout(settle, command.message === 'background' ? 10000 : 350);
      break;
    case 'continue': {
      const last = manager.getBranch().filter((item) => item.type === 'message').at(-1)?.message;
      if (command.resume === true) {
        // A restart's resume (drain.mjs): the run the last engine stopped carries on.
        if (running) { emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'Wait for the current turn to finish before continuing' }); return; }
        running = true;
        emit({ type: 'agent_start' });
        timer = setTimeout(() => { answer('resumed after restart'); settle(); }, 20);
        data = { continued: true };
        break;
      }
      if (running || last?.role !== 'toolResult') { emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'Only a conversation that stops at a tool result can continue without a message' }); return; }
      running = true;
      emit({ type: 'agent_start' });
      timer = setTimeout(() => { answer('continued'); settle(); }, 20);
      break;
    }
    case 'steer': case 'follow_up': running = true; break;
    case 'abort': settle(); break;
    case 'set_session_name': manager.appendSessionInfo(command.name); break;
    case 'get_commands': data = { commands: [] }; break;
    case 'get_available_models': data = { models: [] }; break;
    case 'set_session_cache_warming':
      warming = { enabled: command.enabled ?? warming.enabled, hours: command.hours ?? warming.hours,
        state: (command.enabled ?? warming.enabled) ? warming.state : 'inactive' };
      // falls through: the answer is the state after the switch
    case 'get_cache_warming':
      data = { mode: 'idle', sessionEnabled: warming.enabled, sessionUntil: warming.hours ? 1_790_000_000_000 + warming.hours * 3_600_000 : null, lastInputAt: 1_789_990_000_000, status: { state: warming.state },
        cache: { state: 'warm', hitPercent: 90, expiresAt: 1_790_000_000_000 } }; break;
    case 'extension_request':
      if (command.name === 'rubato.service-tier.status') { data = fast; break; }
      if (command.name === 'rubato.session-link.deliver') {
        const mode = running ? 'steer' : 'turn';
        // A delivered `busy-children` ends its turn with a subagent still running.
        if (command.data.text === 'busy-children') pendingWork = 1;
        deliveries.push({ data: command.data, mode });
        if (scripted.length) { data = scripted.shift(); break; }
        manager.appendCustomMessageEntry('rubato-session-message', `from ${command.data.from.title}: ${command.data.text}`, true, command.data);
        const reply = () => manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `reply: ${command.data.text}` }],
          stopReason: 'stop', provider: 'fixture', model: 'local', timestamp: Date.now() });
        // `instant`: the whole turn is written before the delivery is answered, the race a
        // fast target makes with a sender that reads its cursor afterwards.
        if (mode === 'turn' && command.data.text.startsWith('instant')) { emit({ type: 'agent_start' }); reply(); settle(); }
        else if (mode === 'turn') {
          running = true;
          emit({ type: 'agent_start' });
          timer = setTimeout(() => { reply(); settle(); }, 150);
        }
        data = { accepted: true }; break;
      }
      if (command.name === 'fixture.session-link.deliveries') { data = deliveries; break; }
      if (command.name === 'fixture.session-link.answer') { scripted.push(command.data); data = null; break; }
      if (command.name === 'fixture.pending-work') { pendingWork = command.data; data = null; break; }
      if (command.name === 'rubato.terminal.pending-work') { data = { active: terminalWork, undelivered: 0 }; break; }
      if (command.name !== 'rubato.task.pending-work') { emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unknown extension RPC request' }); return; }
      data = { active: pendingWork }; break;
    default: emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unsupported fixture command' }); return;
  }
  emit({ id: command.id, type: 'response', command: command.type, success: true, data });
});
