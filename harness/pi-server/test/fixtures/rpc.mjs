// Deliberately fake MODEL/RUNTIME for lifecycle stress tests. The real Pi Server,
// Client, socket and child process transport are never replaced in these tests.
import { createInterface } from 'node:readline';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { findRewindTarget, REWIND_MARK } from '../../../pi-runtime/features/conversation-rewind/rewind.mjs';
const args = process.argv.slice(2);
let manager = SessionManager.open(args[args.indexOf('--session') + 1]);
let running = false;
let timer;
let ui;
let pendingWork = 0;
// The cache warmer's live state as `get_cache_warming` reports it.
let warming = { enabled: true, hours: 2, state: 'inactive' };
// The service-tier extension's live state; `/fast on|off` flips it like the real command.
let fast = { active: false, supported: true };
let blockMessages = false;
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const settle = () => { clearTimeout(timer); running = false; emit({ type: 'agent_end', messages: [] }); emit({ type: 'agent_settled' }); };
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'extension_ui_response') { ui = command; settle(); return; }
  let data = null;
  switch (command.type) {
    case 'get_state': data = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), isStreaming: running, isCompacting: false, pendingMessageCount: 0 }; break;
    case 'get_messages':
      if (blockMessages) return;
      data = { messages: manager.getBranch().filter((item) => item.type === 'message').map((item) => item.message) }; break;
    case 'rewind': {
      // The real rule picks the entry; moving the leaf and marking the landing is what the RPC does.
      let targetId;
      try { targetId = findRewindTarget(manager.getBranch(), { keep: command.keep, skip: command.skip }); }
      catch (failure) { emit({ id: command.id, type: 'response', command: command.type, success: false, error: failure.message }); return; }
      if (targetId === null) { data = { cancelled: false, moved: false, leafId: manager.getLeafId() }; break; }
      const from = manager.getLeafId();
      const target = manager.getEntry(targetId);
      if (target.parentId) manager.branch(target.parentId); else manager.resetLeaf();
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
      else if (command.message === 'busy-children' || command.message === 'idle-children') {
        pendingWork = command.message === 'busy-children' ? 1 : 0;
        timer = setTimeout(settle, 10);
      }
      else if (command.message.startsWith('reply:') || command.message.startsWith('wake:')) {
        // A turn that answers; `wake:` also has a child finish afterwards and wake the lead
        // without a user message, as a completed task does.
        const answer = (text) => {
          const message = { role: 'assistant', timestamp: Date.now(), model: 'fixture', stopReason: 'stop', content: [{ type: 'text', text }] };
          manager.appendMessage(message);
          emit({ type: 'message_end', message });
        };
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
      data = { mode: 'idle', sessionEnabled: warming.enabled, sessionHours: warming.hours, lastInputAt: 1_789_990_000_000, status: { state: warming.state },
        cache: { state: 'warm', hitPercent: 90, expiresAt: 1_790_000_000_000 } }; break;
    case 'extension_request':
      if (command.name === 'rubato.service-tier.status') { data = fast; break; }
      if (command.name !== 'rubato.task.pending-work') { emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unknown extension RPC request' }); return; }
      data = { active: pendingWork }; break;
    default: emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unsupported fixture command' }); return;
  }
  emit({ id: command.id, type: 'response', command: command.type, success: true, data });
});
