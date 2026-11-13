// Runs a companion call stack in a terminal, the same one the engine keeps as a resident service
// (service.mjs): LiveKit, the call worker and the control surface with its test page on
// http://127.0.0.1:18790/. Ctrl-C stops all of it. Logs go to ~/.rubato/call/logs/.
import { spawn } from 'node:child_process';
import { startCallStack } from './stack.mjs';

const stack = await startCallStack({
  spawn: async (command, args, options) => spawn(command, args, options),
  onExit: (name, code) => { console.error(`[call] ${name} exited (${code})`); void stop(1); },
});
console.log(`[call] http://127.0.0.1:${stack.port}/  livekit ${stack.livekit.url}`);
let stopping = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  await stack.close();
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
