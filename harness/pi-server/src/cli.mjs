#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { serveProfile } from './profile-server.mjs';
import { resolveLaunchAgentDir } from '../../rubato-pi/src/launch.mjs';

try {
  const { values } = parseArgs({ options: {
    'agent-dir': { type: 'string' }, socket: { type: 'string' }, 'idle-ms': { type: 'string' }, help: { type: 'boolean' },
  }, allowPositionals: false });
  if (values.help) {
    console.log('Usage: node harness/pi-server/src/cli.mjs [--agent-dir /absolute/profile] [--socket /short/pi.sock] [--idle-ms 60000]');
  } else {
    const idleMs = values['idle-ms'] === 'never' ? null : Number(values['idle-ms'] ?? 60000);
    const service = await serveProfile({ agentDir: path.resolve(values['agent-dir'] ?? resolveLaunchAgentDir()),
      socketPath: values.socket, idleMs, onError: (error) => console.error(error.message) });
    console.log(JSON.stringify({ ...service.descriptor, descriptorPath: service.descriptorPath }));
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      try { await service.close(); } catch (error) { console.error(error); process.exitCode = 1; }
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
} catch (error) {
  console.error(`rubato-pi-server: ${error.message}`);
  process.exitCode = 1;
}
