import { mkdir, readFile, rename, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { startSessionServer } from './host.mjs';
import { RpcWorker } from './rpc-worker.mjs';

/** The descriptor is an address, not a session database. */
export async function readDescriptor(file) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (value.version !== 1 || typeof value.serverId !== 'string' || typeof value.socketPath !== 'string'
    || !path.isAbsolute(value.socketPath)) throw new Error('Invalid Rubato Pi server descriptor');
  return value;
}

export async function serveProfile({ agentDir, socketPath, idleMs = 60000, workerFactory, onError = console.error } = {}) {
  if (!path.isAbsolute(agentDir ?? '')) throw new TypeError('agentDir must be absolute');
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  agentDir = await realpath(agentDir);
  const serverDir = path.join(agentDir, 'server');
  await mkdir(serverDir, { recursive: true, mode: 0o700 });
  const descriptorPath = path.join(serverDir, 'connection.json');
  socketPath ??= path.join(serverDir, 'pi.sock');
  if (!path.isAbsolute(socketPath)) throw new TypeError('socketPath must be absolute');
  // UNIX paths are limited on macOS; fail explicitly instead of silently
  // changing to a different address or taking ownership of another socket.
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Socket path is too long; pass --socket with a shorter absolute path');
  let service;
  let compromised;
  const release = await lockfile.lock(agentDir, { lockfilePath: path.join(serverDir, 'owner.lock'),
    stale: 30000, update: 10000, retries: 0,
    onCompromised(error) { compromised = error; onError(error); if (service) void service.close(); } });
  try {
    let previous;
    try { previous = await readDescriptor(descriptorPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (compromised) throw compromised;
    service = await startSessionServer({ sessionsDir: path.join(agentDir, 'sessions'), socketPath,
      serverId: previous?.serverId ?? randomUUID(), idleMs, onError,
      workerFactory: workerFactory ?? ((metadata) => new RpcWorker(metadata, {
        env: { RUBATO_PI_CODING_AGENT_DIR: agentDir },
      })),
    });
    if (compromised) throw compromised;
    const descriptor = { version: 1, serverId: service.serverId, socketPath };
    const temporary = `${descriptorPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, descriptorPath);
    let closing;
    return { ...service, descriptorPath, descriptor, close: () => closing ??= (async () => {
      try { await service.close(); } finally { if (!compromised) await release(); }
    })() };
  } catch (error) {
    await service?.close().catch(() => {});
    if (!compromised) await release().catch(() => {});
    throw error;
  }
}
