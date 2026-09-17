import { spawn } from 'node:child_process';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { readDescriptor } from './descriptor.mjs';
import { resolveLaunchEngine, readPiEngineReceipt } from '../../rubato-pi/src/engine-selection.mjs';

const openings = new Map();
const serverCli = path.join(import.meta.dirname, 'cli.mjs');
export function isConversationLaunch(args) {
  if (['auth', 'install', 'remove', 'update', 'config', 'list'].includes(args[0])) return false;
  const flags = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length);
  return !flags.some(arg => /^(?:-h|--help|-v|--version|--list-models(?:=.*)?|--export(?:=.*)?)$/.test(arg));
}
export function installedSharedRuntime(env = process.env) {
  const selection = resolveLaunchEngine({ env });
  if (selection.error) return undefined;
  const features = readPiEngineReceipt(selection.root)?.features;
  return features?.includes('session-ui') && features.includes('session-transport') ? selection.root : undefined;
}
export function socketAlive(socketPath) {
  return new Promise(resolve => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = value => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
async function liveDescriptor(file) {
  try { const descriptor = await readDescriptor(file); return await socketAlive(descriptor.socketPath) ? descriptor : undefined; }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
}

/** Shared CLI/GUI bootstrap. Concurrent presentations contend on one profile
 * owner lock; none kills or replaces an engine with active user conversations.
 */
export async function ensureProfileEngine({ descriptorPath, nodeBin = process.execPath, env = process.env,
  runtimeRoot = installedSharedRuntime(env), requireTerminal = false, timeoutMs = 40000 }) {
  if (!path.isAbsolute(descriptorPath)) throw new TypeError('Descriptor path must be absolute');
  const agentDir = path.dirname(path.dirname(descriptorPath));
  const expectedRoot = runtimeRoot && await realpath(runtimeRoot);
  const accept = descriptor => {
    if (requireTerminal && (!descriptor.terminalSocketPath || descriptor.runtimeRoot !== expectedRoot)) {
      throw new Error('This profile still has an older engine running. Finish its active work and restart the profile engine before using the shared CLI. No second engine was started.');
    }
    return descriptor;
  };
  const live = await liveDescriptor(descriptorPath);
  if (live) return accept(live);
  let operation = openings.get(descriptorPath);
  if (!operation) {
    operation = (async () => {
      await mkdir(agentDir, { recursive: true, mode: 0o700 });
      await mkdir(path.join(agentDir, 'logs'), { recursive: true, mode: 0o700 });
      const logFile = path.join(agentDir, 'logs', 'pi-server.log');
      const deadline = Date.now() + timeoutMs;
      let child;
      let spawnError;
      // Bounded startup/recovery probes only. Once connected, the official
      // session streams carry changes; there is no frontend idle polling loop.
      while (Date.now() < deadline) {
        if (!child || child.exitCode !== null || child.signalCode !== null) {
          const sink = await open(logFile, 'a', 0o600);
          try {
            child = spawn(nodeBin, [serverCli, '--agent-dir', agentDir,
              ...(runtimeRoot ? ['--runtime-root', runtimeRoot] : [])], {
              cwd: agentDir, detached: true, stdio: ['ignore', sink.fd, sink.fd],
              env: { ...env, ELECTRON_RUN_AS_NODE: '1',
                NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --experimental-strip-types`.trim() },
            });
            child.on('error', error => { spawnError = error; }); child.unref();
          } finally { await sink.close(); }
        }
        // A competing client may win startup. Discovery, never child PID,
        // determines which profile engine all presentations attach to.
        for (let i = 0; i < 20 && Date.now() < deadline; i++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          if (spawnError) throw spawnError;
          const ready = await liveDescriptor(descriptorPath);
          if (ready) return ready;
        }
      }
      let tail = ''; try { tail = (await readFile(logFile, 'utf8')).slice(-800).trim(); } catch {}
      throw new Error(`Rubato profile engine did not start${tail ? `\n${tail}` : ''}`);
    })().finally(() => openings.delete(descriptorPath));
    openings.set(descriptorPath, operation);
  }
  return accept(await operation);
}
