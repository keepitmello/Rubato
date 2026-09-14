import { mkdir, rename, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { startSessionServer } from './host.mjs';
import { RpcWorker } from './rpc-worker.mjs';
import { SessionWorker } from './session-worker.mjs';
import { readDescriptor } from './descriptor.mjs';
import { ensureSessionDefaults, sessionDefaultsLookCurrent } from '../../rubato-pi/src/session-defaults.mjs';
export { readDescriptor } from './descriptor.mjs';

export async function serveProfile({ agentDir, socketPath, idleMs = 60000, runtimeRoot, workerFactory, onError = console.error } = {}) {
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
  let terminalServer;
  let compromised;
  // 서버가 kill -9 로 죽으면 락은 stale 로 넘어갈 때까지 남고, 그 창이 그대로
  // 앱의 복구 지연이 된다. 실측 41초. 살아있는 서버는 update 마다 mtime 을 새로
  // 찍으므로 stale 은 update 의 세 배면 충분하다.
  const release = await lockfile.lock(agentDir, { lockfilePath: path.join(serverDir, 'owner.lock'),
    stale: 15000, update: 5000, retries: 0,
    onCompromised(error) {
      compromised = error; onError(error);
      void (async () => { await terminalServer?.close(); await service?.close(); })().catch(onError);
    } });
  try {
    let previous;
    try { previous = await readDescriptor(descriptorPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (compromised) throw compromised;
    if (runtimeRoot && workerFactory) throw new TypeError('Choose an engine build or an explicit worker factory, not both');
    const hosted = runtimeRoot ? await (await import('./hosted-runtime.mjs')).loadHostedRuntime({ runtimeRoot, agentDir }) : undefined;
    // Only the engine holding the profile lock may bootstrap shared config.
    // Five simultaneous frontends must not truncate/read each other's JSON.
    if (hosted && !sessionDefaultsLookCurrent(agentDir)) ensureSessionDefaults(agentDir);
    const workerOptions = hosted ? await hosted.createWorkerOptions() : undefined;
    service = await startSessionServer({ sessionsDir: path.join(agentDir, 'sessions'), socketPath,
      serverId: previous?.serverId ?? randomUUID(), idleMs, onError,
      workerFactory: workerFactory ?? (hosted ? ((metadata, creation) => new SessionWorker(metadata, workerOptions(metadata, creation))) : ((metadata) => new RpcWorker(metadata, {
        env: { RUBATO_PI_CODING_AGENT_DIR: agentDir },
      }))),
    });
    hosted?.bindHost(service.host);
    if (compromised) throw compromised;
    const descriptor = { version: 1, serverId: service.serverId, socketPath };
    if (hosted) {
      const { startTerminalServer } = await import('./terminal-server.mjs');
      terminalServer = await startTerminalServer({ socketPath: socketPath + '.tty', host: service.host, descriptor,
        api: await hosted.loadTerminalApi(), onError });
      descriptor.terminalSocketPath = terminalServer.socketPath;
      descriptor.runtimeRoot = await realpath(runtimeRoot);
    }
    const temporary = `${descriptorPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, descriptorPath);
    let closing;
    return { ...service, descriptorPath, descriptor, close: () => closing ??= (async () => {
      try { await terminalServer?.close(); await service.close(); } finally { if (!compromised) await release(); }
    })() };
  } catch (error) {
    await terminalServer?.close().catch(() => {});
    await service?.close().catch(() => {});
    if (!compromised) await release().catch(() => {});
    throw error;
  }
}
