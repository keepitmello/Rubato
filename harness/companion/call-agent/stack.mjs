// Everything a call needs, started together: the LiveKit server, the call worker and the control
// surface with its call log. The engine starts it as a resident service (service.mjs); `run.mjs`
// starts the same thing in a terminal.
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControl, listen } from './control.mjs';
import { createCallLog } from './calls.mjs';
import { CALL_HOME, CONTROL_PORT, livekitConfig, livekitServerPath } from './livekit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `spawn(command, args, { env, stdio })` resolves to a process handle with `kill()` and an 'exit'
 * event. `onExit(name, code)` hears about a process that ended while the stack was up.
 */
export async function startCallStack({ spawn, onExit = () => {}, env = process.env, home = CALL_HOME, port = CONTROL_PORT }) {
  const server = livekitServerPath(env);
  if (!server) throw new Error('livekit-server is not installed (brew install livekit)');
  const livekit = livekitConfig(path.join(home, 'livekit.yaml'));
  mkdirSync(path.join(home, 'logs'), { recursive: true, mode: 0o700 });
  const log = createCallLog({ dir: path.join(home, 'calls') });
  const control = createControl({ livekit, log });
  const http = await listen(control, { port });
  let closing = false;
  const children = [];
  async function start(name, command, args, extraEnv = {}) {
    const fd = openSync(path.join(home, 'logs', `${name}.log`), 'a', 0o600);
    try {
      const child = await spawn(command, args, { env: { ...env, ...extraEnv }, stdio: ['ignore', fd, fd] });
      child.on('exit', code => { if (!closing) onExit(name, code); });
      children.push(child);
    } finally { closeSync(fd); }
  }
  await start('livekit', server, ['--config', livekit.file]);
  await start('agent', process.execPath, [path.join(here, 'agent.mjs'), 'start'], {
    LIVEKIT_URL: livekit.url, LIVEKIT_API_KEY: livekit.key, LIVEKIT_API_SECRET: livekit.secret,
    RUBATO_CALL_CONTROL: `http://127.0.0.1:${port}`,
  });
  return {
    livekit, log, control, port,
    async close() {
      closing = true;
      for (const child of children) try { child.kill('SIGTERM'); } catch {}
      log.close();
      await new Promise(resolve => { http.close(resolve); http.closeAllConnections?.(); });
    },
  };
}
