#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { serveProfile } from './profile-server.mjs';
import { resolveLaunchAgentDir } from '../../rubato-pi/src/launch.mjs';
import { installedSharedRuntime } from './discovery.mjs';
import { errorLog } from './error-log.mjs';
import { installExitGuard } from './exit-guard.mjs';

try {
  const { values } = parseArgs({ options: {
    'agent-dir': { type: 'string' }, socket: { type: 'string' }, 'idle-ms': { type: 'string' }, 'runtime-root': { type: 'string' }, help: { type: 'boolean' },
  }, allowPositionals: false });
  if (values.help) {
    console.log('Usage: node harness/pi-server/src/cli.mjs [--agent-dir /absolute/profile] [--socket /short/pi.sock] [--idle-ms 60000] [--runtime-root /verified/engine]');
  } else {
    if (values['runtime-root'] && !values['agent-dir']) {
      throw new Error('--runtime-root is an incomplete candidate and requires an explicit --agent-dir; the normal profile is not selected implicitly');
    }
    installExitGuard();
    // The stop handler goes in before the engine starts. The socket answers while startup is
    // still finishing, so a restart may signal us then. With no handler of ours yet, the lock
    // library (signal-exit) read that signal as unhandled: it deleted the profile lock under a
    // running engine and re-sent the signal, which the exit guard refuses. A signal that comes
    // during startup closes the engine as soon as it is up. `on`, not `once`: a second signal
    // must still find our handler.
    let service;
    let stopRequested = false;
    let closing = false;
    const stop = async () => {
      stopRequested = true;
      if (!service || closing) return;
      closing = true;
      try { await service.close(); } catch (error) { console.error(error); process.exitCode = 1; }
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const idleMs = values['idle-ms'] === 'never' ? null : Number(values['idle-ms'] ?? 60000);
    service = await serveProfile({ agentDir: path.resolve(values['agent-dir'] ?? resolveLaunchAgentDir()),
      socketPath: values.socket, idleMs, runtimeRoot: values['runtime-root'] ?? installedSharedRuntime(), onError: errorLog() });
    console.log(JSON.stringify({ ...service.descriptor, descriptorPath: service.descriptorPath }));
    if (stopRequested) await stop();
  }
} catch (error) {
  console.error(`rubato-pi-server: ${error.message}`);
  process.exitCode = 1;
}
