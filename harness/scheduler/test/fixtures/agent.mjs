// Deterministic stand-in for the MODEL only. The Pi server, its client, the socket, the
// session router and the JSONL writer are the real ones; this child speaks Pi RPC and
// persists its messages with the real SessionManager, like a real turn would.
//
// Prompts steer the outcome: "fail" → assistant error, "slow" → 1.5 s turn, "question" →
// a pending select, "hang" → never settles until aborted, anything else → a reply.
import { createInterface } from 'node:readline';
// Resolved from the Pi server's own dependencies, the same package its session files use.
const { SessionManager } = await import(new URL('../../../pi-server/node_modules/@earendil-works/pi-coding-agent/dist/index.js', import.meta.url).href);

const args = process.argv.slice(2);
const manager = SessionManager.open(args[args.indexOf('--session') + 1]);
const MODELS = { 'fixture/good': ['off', 'low', 'high'], 'fixture/other': ['off'] };
let model = { provider: 'fixture', id: 'good' };
let thinkingLevel = 'off';
let running = false;
let timer;
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (text, extra = {}) => {
  const message = { role: 'assistant', content: [{ type: 'text', text }], provider: model.provider, model: model.id,
    stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, ...extra };
  manager.appendMessage(message);
  emit({ type: 'message_end', message });
};
const settle = () => { clearTimeout(timer); running = false; emit({ type: 'agent_end', messages: [] }); emit({ type: 'agent_settled' }); };

createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'extension_ui_response') { reply(`answered ${command.value ?? command.confirmed}`); settle(); return; }
  let data = null;
  switch (command.type) {
    case 'get_state':
      data = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionName: manager.getSessionName?.(),
        model: { provider: model.provider, id: model.id }, thinkingLevel, isStreaming: running, isCompacting: false, pendingMessageCount: 0 };
      break;
    case 'get_messages':
      data = { messages: manager.getBranch().filter((entry) => entry.type === 'message').map((entry) => entry.message) };
      break;
    case 'set_model': {
      const key = `${command.provider}/${command.modelId}`;
      if (!MODELS[key]) { emit({ id: command.id, type: 'response', command: command.type, success: false, error: `Model not found: ${key}` }); return; }
      model = { provider: command.provider, id: command.modelId };
      manager.appendModelChange(command.provider, command.modelId);
      data = { contextWindow: 1000 };
      break;
    }
    case 'get_available_thinking_levels': data = { levels: MODELS[`${model.provider}/${model.id}`] }; break;
    case 'set_thinking_level': thinkingLevel = command.level; break;
    case 'prompt':
      running = true;
      manager.appendMessage({ role: 'user', content: command.message, timestamp: Date.now() });
      emit({ id: command.id, type: 'response', command: command.type, success: true, data: null });
      // The real engine answers the prompt after preflight, before the loop reports streaming.
      setTimeout(() => {
        emit({ type: 'agent_start' });
        if (command.message === 'fail') { reply('', { stopReason: 'error', errorMessage: '401 invalid credentials' }); timer = setTimeout(settle, 50); }
        else if (command.message === 'question') emit({ type: 'extension_ui_request', id: 'q1', method: 'select', title: 'Pick', options: ['a', 'b'] });
        else if (command.message === 'hang') { /* until abort */ }
        else timer = setTimeout(() => { reply(`done: ${command.message}`); settle(); }, command.message === 'slow' ? 1500 : 100);
      }, 30);
      return;
    case 'abort':
      if (running) { reply('', { stopReason: 'aborted' }); settle(); }
      break;
    case 'get_commands': data = { commands: [] }; break;
    case 'get_available_models': data = { models: Object.keys(MODELS).map((key) => ({ provider: key.split('/')[0], id: key.split('/')[1] })) }; break;
    case 'extension_request': data = { active: 0 }; break;
    case 'get_cache_warming': data = { status: { state: 'inactive' } }; break;
    default:
      emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unsupported fixture command' });
      return;
  }
  emit({ id: command.id, type: 'response', command: command.type, success: true, data });
});
