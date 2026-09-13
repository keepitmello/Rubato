// Deliberately fake MODEL/RUNTIME for lifecycle stress tests. The real Pi Server,
// Client, socket and child process transport are never replaced in these tests.
import { createInterface } from 'node:readline';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const args = process.argv.slice(2);
const manager = SessionManager.open(args[args.indexOf('--session') + 1]);
let running = false;
let timer;
let ui;
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const settle = () => { clearTimeout(timer); running = false; emit({ type: 'agent_end', messages: [] }); emit({ type: 'agent_settled' }); };
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'extension_ui_response') { ui = command; settle(); return; }
  let data = null;
  switch (command.type) {
    case 'get_state': data = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), isStreaming: running, isCompacting: false, pendingMessageCount: 0 }; break;
    case 'get_messages': data = { messages: manager.getBranch().filter((item) => item.type === 'message').map((item) => item.message) }; break;
    case 'prompt':
      running = true;
      manager.appendMessage({ role: 'user', content: command.message, timestamp: Date.now() });
      emit({ type: 'agent_start' });
      if (command.message === 'question') emit({ type: 'extension_ui_request', method: 'select', title: 'Choose', options: ['yes', 'no'], id: 'question-1' });
      else timer = setTimeout(settle, command.message === 'background' ? 10000 : 350);
      break;
    case 'steer': case 'follow_up': running = true; break;
    case 'abort': settle(); break;
    case 'set_session_name': manager.appendSessionInfo(command.name); break;
    case 'get_commands': data = { commands: [] }; break;
    case 'get_available_models': data = { models: [] }; break;
    default: emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unsupported fixture command' }); return;
  }
  emit({ id: command.id, type: 'response', command: command.type, success: true, data });
});
