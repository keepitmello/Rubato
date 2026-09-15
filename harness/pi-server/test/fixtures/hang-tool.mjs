// Persists an assistant toolCall and then hangs without a toolResult, so a
// SIGTERM/SIGKILL of the worker leaves the JSONL in the mid-tool shape a real
// agent-loop write produces (message_end of the assistant happens before executeToolCalls).
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
const args = process.argv.slice(2);
let manager = SessionManager.open(args[args.indexOf('--session') + 1]);
let hanging = false;
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const persist = () => {
  const file = manager.getSessionFile();
  if (file && !existsSync(file)) {
    writeFileSync(file, [manager.getHeader(), ...manager.getEntries()].filter(Boolean).map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  }
};
process.on('SIGTERM', () => {});
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const command = JSON.parse(line);
  let data = null;
  switch (command.type) {
    case 'get_state': data = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), isStreaming: hanging, isCompacting: false, pendingMessageCount: 0 }; break;
    case 'get_messages': data = { messages: manager.getBranch().filter((item) => item.type === 'message').map((item) => item.message) }; break;
    case 'prompt': {
      hanging = true;
      manager.appendMessage({ role: 'user', content: command.message, timestamp: Date.now() });
      persist();
      const assistant = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_hang', name: 'bash', arguments: { command: 'sleep 30' } }],
        api: 'openai-completions', provider: 'fixture', model: 'local',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse', timestamp: Date.now(),
      };
      manager.appendMessage(assistant);
      persist();
      emit({ type: 'agent_start' });
      emit({ type: 'message_end', message: assistant });
      emit({ type: 'tool_execution_start', toolCallId: 'call_hang', toolName: 'bash', args: { command: 'sleep 30' } });
      emit({ id: command.id, type: 'response', command: command.type, success: true, data: { ok: true } });
      return;
    }
    case 'abort': hanging = false; data = { ok: true }; break;
    default: emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unsupported' }); return;
  }
  emit({ id: command.id, type: 'response', command: command.type, success: true, data });
});
setInterval(() => {}, 1000);
