// One resident service's thread (resident-services.mjs starts it). The service module runs here,
// apart from the engine's main thread where every conversation lives: a throw from a timer, an
// unhandled rejection or `process.exit` ends this thread only, and the supervisor starts it again.
//
// Two calls would still reach the whole process from here, so they are refused: a signal to our
// own pid, and `process.abort` (Node refuses that one in a thread already).
import { EventEmitter } from 'node:events';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const { name, module: modulePath, export: exportName = 'start', options = {}, context = {}, hostMethods = [] } = workerData;

const kill = process.kill;
process.kill = function guardedKill(pid, signal) {
  const target = Number(pid);
  if ((target === process.pid || target === 0) && signal !== 0 && signal !== '0') {
    throw new Error(`process.kill(${pid}, ${signal ?? 'SIGTERM'}) refused: the resident service "${name}" shares the engine's process`);
  }
  return kill.call(process, pid, signal);
};

const plain = (error) => ({ name: error?.name, message: String(error?.message ?? error), stack: error?.stack });
const post = (message) => parentPort.postMessage(message);

let nextId = 0;
const pending = new Map();
const host = Object.fromEntries(hostMethods.map((method) => [method, (...args) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  post({ type: 'host', id, method, args: JSON.parse(JSON.stringify(args)) });
})]));

// Processes started through ctx.spawn: the engine's main thread owns them (so it reaps them when
// they end; a process a thread started stays a zombie once that thread is gone), and this side
// gets a ChildProcess-like handle.
const children = new Map();
const stop = new AbortController();
const ctx = {
  name,
  options,
  env: process.env,
  agentDir: context.agentDir,
  socketPath: context.socketPath,
  serverId: context.serverId,
  signal: stop.signal,
  host,
  onError: (error) => post({ type: 'error', error: plain(error) }),
  log: (event, details) => post({ type: 'log', event: String(event), details: details === undefined ? undefined : JSON.parse(JSON.stringify(details)) }),
  /**
   * A process this service started (a ChildProcess or a pid). It ends with the service: when the
   * thread stops for any reason, the supervisor stops what it still owns — also a child that does
   * not end on its IPC channel's 'disconnect'.
   */
  own(child) {
    const pid = typeof child === 'number' ? child : child?.pid;
    if (!Number.isInteger(pid) || pid <= 0) return;
    post({ type: 'own', pid });
    if (typeof child === 'object') child.once?.('exit', () => post({ type: 'disown', pid }));
  },
  /**
   * Starts a process owned by the engine's main thread, which reaps it and stops it when this
   * service's thread ends. `options`: `cwd`, `env`, `stdio` (each 'ignore', 'ipc', or a file
   * descriptor this thread opened — keep it open until this resolves). Resolves to a handle with
   * `pid`, `kill(signal)`, `exitCode`, `signalCode` and 'exit' (code, signal) / 'error' events.
   */
  spawn(command, args = [], options = {}) {
    const id = ++nextId;
    const handle = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, signalCode: null,
      kill(signal = 'SIGTERM') { post({ type: 'child-kill', id, signal }); return true; } });
    return new Promise((resolve, reject) => {
      children.set(id, { handle, resolve, reject });
      post({ type: 'spawn', id, command, args, options: { cwd: options.cwd, env: options.env, stdio: options.stdio } });
    });
  },
  async connect(clientOptions = {}) {
    const { SessionClient } = await import('./client.mjs');
    return new SessionClient({ socketPath: context.socketPath, serverId: context.serverId, onError: ctx.onError, ...clientOptions }).connect();
  },
};

let api;
let closing;
parentPort.on('message', async (message) => {
  switch (message?.type) {
    case 'ping': post({ type: 'pong' }); return;
    case 'spawned': {
      const entry = children.get(message.id);
      if (!entry) return;
      if (message.error) { children.delete(message.id); entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); return; }
      entry.handle.pid = message.pid;
      entry.resolve(entry.handle);
      return;
    }
    case 'child-exit': {
      const entry = children.get(message.id);
      if (!entry) return;
      children.delete(message.id);
      Object.assign(entry.handle, { exitCode: message.code, signalCode: message.signal });
      entry.handle.emit('exit', message.code, message.signal);
      return;
    }
    case 'host-result': {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(Object.assign(new Error(message.error.message), { name: message.error.name ?? 'Error' }));
      else call.resolve(message.value);
      return;
    }
    case 'call': {
      try {
        const method = api?.[message.method];
        if (message.method === 'close' || typeof method !== 'function') throw new Error(`The resident service "${name}" has no method ${message.method}`);
        const value = await method.apply(api, message.args ?? []);
        post({ type: 'call-result', id: message.id, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) });
      } catch (error) { post({ type: 'call-result', id: message.id, error: plain(error) }); }
      return;
    }
    case 'close': {
      closing ??= (async () => {
        stop.abort();
        try { await api?.close?.(); } catch (error) { ctx.onError(error); }
        post({ type: 'closed' });
        process.exit(0);
      })();
      return;
    }
  }
});

const loaded = await import(pathToFileURL(modulePath).href);
if (typeof loaded[exportName] !== 'function') throw new Error(`${modulePath} does not export ${exportName}()`);
api = await loaded[exportName](ctx) ?? {};
if (!closing) post({ type: 'ready' });
