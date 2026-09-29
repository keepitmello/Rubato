import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SessionClient } from '../../pi-server/src/client.mjs';
import { ensureProfileEngine } from '../../pi-server/src/discovery.mjs';
import { resolveLaunchAgentDir } from '../../rubato-pi/src/launch.mjs';

/**
 * The profile engine every CLI window and the T3 app share. Starting it when absent is the
 * same bootstrap they use (one profile lock, never a second engine). Session calls carry no
 * timeout: a scheduled turn may run for a long time.
 */
export function createEngineConnector({ env = process.env, agentDir = resolveLaunchAgentDir(env), nodeBin = process.execPath,
  onError = () => {} } = {}) {
  const descriptorPath = path.join(agentDir, 'server', 'connection.json');
  return {
    agentDir,
    descriptorPath,
    async connect() {
      mkdirSync(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
      const descriptor = await ensureProfileEngine({ descriptorPath, nodeBin, env });
      return new SessionClient({ socketPath: descriptor.socketPath, serverId: descriptor.serverId, onError }).connect();
    },
  };
}
