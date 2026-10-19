import { mkdir, rename, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { startSessionServer } from './host.mjs';
import { RpcWorker } from './rpc-worker.mjs';
import { SessionWorker } from './session-worker.mjs';
import { readDescriptor } from './descriptor.mjs';
import { drainForRestart, resumeAfterRestart, resumeFilePath } from './drain.mjs';
import { ensureSessionDefaults, sessionDefaultsLookCurrent } from '../../rubato-pi/src/session-defaults.mjs';
import { startCompanionKeeper } from '../../companion/keeper.mjs';
import { followingStore } from '../../companion/companion.mjs';
import { SessionClient } from './client.mjs';
export { readDescriptor } from './descriptor.mjs';

/**
 * `drainGate` and `drainTimeoutMs` are test seams: a hosted engine drains through the gate its
 * runtime build ships (drain.mjs); an engine without one closes at once, as before.
 * `companion` lets this engine keep the companion loaded (harness/companion keeper.mjs); the CLI
 * sets it for the person's own profile only.
 */
export async function serveProfile({ agentDir, socketPath, idleMs = 60000, runtimeRoot, workerFactory, onError = console.error,
  drainGate, drainTimeoutMs, companion: keepCompanion = false } = {}) {
  if (!path.isAbsolute(agentDir ?? '')) throw new TypeError('agentDir must be absolute');
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  agentDir = await realpath(agentDir);
  const serverDir = path.join(agentDir, 'server');
  await mkdir(serverDir, { recursive: true, mode: 0o700 });
  const descriptorPath = path.join(serverDir, 'connection.json');
  socketPath ??= process.platform === 'win32'
    ? ['', '', '.', 'pipe', `rubato-pi-${path.basename(agentDir)}`].join('\\')
    : path.join(serverDir, 'pi.sock');
  if (!path.isAbsolute(socketPath)) throw new TypeError('socketPath must be absolute');
  // UNIX paths are limited on macOS; fail explicitly instead of silently
  // changing to a different address or taking ownership of another socket.
  if (process.platform !== 'win32' && Buffer.byteLength(socketPath) > 100) throw new Error('Socket path is too long; pass --socket with a shorter absolute path');
  let service;
  let terminalServer;
  let compromised;
  let hosted;
  let companion;
  // 서버가 kill -9 로 죽으면 락은 stale 로 넘어갈 때까지 남고, 그 창이 그대로
  // 앱의 복구 지연이 된다. 실측 41초. 살아있는 서버는 update 마다 mtime 을 새로
  // 찍으므로 stale 은 update 의 세 배면 충분하다.
  const release = await lockfile.lock(agentDir, { lockfilePath: path.join(serverDir, 'owner.lock'),
    stale: 15000, update: 5000, retries: 0,
    onCompromised(error) {
      compromised = error; onError(error);
      void (async () => { await companion?.close(); hosted?.sessionLink.close(); await terminalServer?.close(); await service?.close(); })().catch(onError);
    } });
  try {
    let previous;
    try { previous = await readDescriptor(descriptorPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (compromised) throw compromised;
    if (runtimeRoot && workerFactory) throw new TypeError('Choose an engine build or an explicit worker factory, not both');
    hosted = runtimeRoot ? await (await import('./hosted-runtime.mjs')).loadHostedRuntime({ runtimeRoot, agentDir }) : undefined;
    // Only the engine holding the profile lock may bootstrap shared config.
    // Five simultaneous frontends must not truncate/read each other's JSON.
    if (hosted && !sessionDefaultsLookCurrent(agentDir)) ensureSessionDefaults(agentDir);
    const workerOptions = hosted ? await hosted.createWorkerOptions() : undefined;
    const sessionsDir = path.join(agentDir, 'sessions');
    service = await startSessionServer({ sessionsDir, socketPath,
      // Only the lock holder writes it, like the descriptor.
      sessionIndexPath: path.join(serverDir, 'session-index.json'),
      serverId: previous?.serverId ?? randomUUID(), idleMs, onError,
      workerFactory: workerFactory ?? (hosted ? ((metadata, creation) => new SessionWorker(metadata, workerOptions(metadata, creation))) : ((metadata) => new RpcWorker(metadata, {
        env: { RUBATO_PI_CODING_AGENT_DIR: agentDir },
      }))),
    });
    hosted?.bindHost(service.host);
    hosted?.sessionLink.bind({ host: service.host, sessionsDir, socketPath, serverId: service.serverId, onError,
      ...(keepCompanion ? { followStore: followingStore() } : {}) });
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
    // The companion (harness/companion) stays loaded in a hosted engine while it is turned on.
    if (hosted && keepCompanion) companion = startCompanionKeeper({ onError,
      connect: () => new SessionClient({ socketPath, serverId: service.serverId, onError }).connect() });
    // What the previous engine was running when a restart closed it (drain.mjs).
    const resumeFile = resumeFilePath(serverDir);
    const resumed = resumeAfterRestart({ descriptor, resumeFile, onError }).catch((error) => { onError(error); return []; });
    const gate = drainGate ?? await hosted?.loadDrainGate();
    let closing;
    const drainStop = new AbortController();
    return { ...service, descriptorPath, descriptor, resumed, companion, close: ({ drain = false } = {}) => closing ??= (async () => {
      // A restart lets running work reach the gate first; a second stop signal ends the wait.
      if (drain && !compromised) {
        await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, 10_000).unref?.())]);
        await drainForRestart({ host: service.host, gate, resumeFile, signal: drainStop.signal, onError,
          ...(drainTimeoutMs === undefined ? {} : { timeoutMs: drainTimeoutMs }) }).catch(onError);
      }
      await companion?.close().catch(onError);
      hosted?.sessionLink.close();
      try { await terminalServer?.close(); await service.close(); } finally { if (!compromised) await release(); }
    })(), stopDraining: () => drainStop.abort() };
  } catch (error) {
    await companion?.close().catch(() => {});
    hosted?.sessionLink.close();
    await terminalServer?.close().catch(() => {});
    await service?.close().catch(() => {});
    if (!compromised) await release().catch(() => {});
    throw error;
  }
}
