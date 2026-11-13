// Everything a call needs, started together: the LiveKit server, the call worker and the control
// surface with its call log. The engine starts it as a resident service (service.mjs); `run.mjs`
// starts the same thing in a terminal.
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControl, listen } from './control.mjs';
import { createCallLog } from './calls.mjs';
import { CALL_HOME, CONTROL_PORT, LIVEKIT_PORT, livekitConfig, livekitServerPath } from './livekit.mjs';
import { startTailnetExposure } from './remote.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The person's phones ring through a VoIP push the push relay's Mac sender sends
 * (harness/push-relay/mac/sender.mjs). Without that module, or when it cannot start, calls still
 * ring every open app and push stays off.
 */
async function pushSender(say) {
  try {
    const { createPushSender } = await import('../../push-relay/mac/sender.mjs');
    return createPushSender();
  } catch (error) { say('call push off', { reason: error.message }); return null; }
}

/**
 * `spawn(command, args, { env, stdio })` resolves to a process handle with `kill()` and an 'exit'
 * event. `onExit(name, code)` hears about a process that ended while the stack was up. `say(text,
 * fields)` writes a line to the engine log. `tailnet` is false to keep LiveKit off the tailnet.
 */
export async function startCallStack({ spawn, onExit = () => {}, say = () => {}, env = process.env, home = CALL_HOME, port = CONTROL_PORT, tailnet = true }) {
  const server = livekitServerPath(env);
  if (!server) throw new Error('livekit-server is not installed (brew install livekit)');
  const livekit = livekitConfig(path.join(home, 'livekit.yaml'));
  mkdirSync(path.join(home, 'logs'), { recursive: true, mode: 0o700 });
  const push = await pushSender(say);
  const log = createCallLog({ dir: path.join(home, 'calls'), onChange: call => {
    try { push?.callChanged(call); } catch (error) { say('call push failed', { reason: error.message }); }
  } });
  const exposure = tailnet ? startTailnetExposure({ localPort: LIVEKIT_PORT, env, log: say }) : null;
  const control = createControl({ livekit, log, remote: () => exposure?.state() ?? { url: null, reason: 'off' } });
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
    livekit, log, control, port, exposure,
    async close() {
      closing = true;
      exposure?.close();
      for (const child of children) try { child.kill('SIGTERM'); } catch {}
      log.close();
      await new Promise(resolve => { http.close(resolve); http.closeAllConnections?.(); });
    },
  };
}
