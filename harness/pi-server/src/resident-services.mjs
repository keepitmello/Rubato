// The services the person's own engine keeps running beside its conversations: the companion
// keeper, the companion's nightly dream, the scheduler, the remote hub's supervisor and, while the
// product runs Telegram, the messenger. Each one runs in its own
// thread (resident-thread.mjs), so nothing a service does can stop the engine or a conversation:
//
//   failure in a service              what happens
//   throw from a timer / callback  →  its thread ends; started again after a backoff
//   unhandled promise rejection    →  same
//   process.exit(...)              →  ends the thread only (Node scopes it to the thread)
//   process.kill(own pid) / abort  →  refused inside the thread
//   hangs (busy loop)              →  no answer to the ping; the thread is terminated and restarted
//   runs out of memory             →  the thread's own heap limit ends the thread only
//
// A service that runs its own process (the hub) starts it with `ctx.spawn`: the main thread starts
// and owns it, so it is reaped when it ends (a process a thread started stays a zombie once that
// thread is gone), and when the service's thread ends the supervisor stops it (SIGTERM, then
// SIGKILL). `ctx.own(child)` does the stopping part for a process the thread started itself.
//
// A service module exports `start(ctx)` and may return `{ close?, ...methods }`. `ctx` carries
// `connect()` (a SessionClient on this engine), `host.<method>()` (calls into the main thread,
// such as `notice` to wake a conversation), `onError`, `log`, `signal` and the entry's `options`.
// `call(name, method, ...args)` reaches a returned method from the main thread.
import { spawn as spawnProcess } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { TELEGRAM_ENABLED } from '../../companion/messenger/store.mjs';
import { companionEnv, companionServiceName, listCompanions } from '../../companion/registry.mjs';

const here = import.meta.dirname;
const THREAD = path.join(here, 'resident-thread.mjs');

/** The Telegram messenger (harness/companion/messenger); it runs only while the product switch is on. */
export const MESSENGER_SERVICE = Object.freeze({ name: 'messenger', module: path.resolve(here, '../../companion/messenger/service.mjs') });

/** The services the person's own profile engine runs (cli.mjs decides which engine that is). */
export const RESIDENT_SERVICES = [
  { name: 'companion', module: path.resolve(here, '../../companion/keeper-service.mjs') },
  { name: 'companion-dream', module: path.resolve(here, '../../companion/dream/service.mjs') },
  { name: 'scheduler', module: path.resolve(here, '../../scheduler/src/service.mjs') },
  ...(TELEGRAM_ENABLED ? [MESSENGER_SERVICE] : []),
  { name: 'hub', module: path.join(here, 'hub-supervisor.mjs') },
];

/** Each companion capability has its own supervised failure boundary and private environment. */
export function residentServices(env = process.env) {
  const shared = RESIDENT_SERVICES.filter((item) => !['companion', 'companion-dream', 'messenger'].includes(item.name));
  return [...listCompanions(env).flatMap((profile) => {
    const scoped = companionEnv(profile.id, env);
    const kinds = ['companion', 'companion-dream', ...(profile.telegram || TELEGRAM_ENABLED ? ['messenger'] : [])];
    return kinds.map((kind) => {
      const base = kind === 'messenger' ? MESSENGER_SERVICE : RESIDENT_SERVICES.find((item) => item.name === kind);
      return { ...base, name: companionServiceName(kind, profile.id), options: { env: scoped } };
    });
  }), ...shared];
}

export const TIMINGS = Object.freeze({
  /** First wait before a failed service starts again; doubles per failure up to `restartMaxMs`. */
  restartMinMs: 1000,
  restartMaxMs: 60_000,
  /** A service that ran this long without failing starts its backoff over. */
  healthyMs: 60_000,
  pingMs: 15_000,
  /** A thread that has not answered a ping for this long is terminated and started again. */
  hungMs: 45_000,
  /** How long `close()` of a service may take before its thread is terminated. */
  closeMs: 5000,
  /** Heap limit per service thread. */
  heapMb: 512,
  /** How long an owned process has after SIGTERM before SIGKILL. */
  ownedKillMs: 3000,
});

const plainError = (error) => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error) });

/**
 * Starts every service in `services` and keeps it running until `close()`.
 * @param {{ services?: Array<{ name: string, module: string, export?: string, options?: object }>,
 *   context: { agentDir: string, socketPath: string, serverId: string },
 *   host?: Record<string, (...args: any[]) => unknown>, onError?: (error: Error) => void,
 *   log?: (line: string) => void, timings?: Partial<typeof TIMINGS> }} options
 */
export function startResidentServices({ services = RESIDENT_SERVICES, context, host = {}, onError = () => {}, log = () => {}, timings = {} }) {
  const t = { ...TIMINGS, ...timings };
  const hostMethods = Object.keys(host).filter((key) => typeof host[key] === 'function');
  const supervisors = new Map(services.map((spec) => [spec.name, supervise(spec)]));

  function supervise(spec) {
    const report = (message, extra) => {
      try { onError(Object.assign(new Error(`resident service ${spec.name}: ${message}`), extra)); } catch { /* the log itself failed */ }
    };
    const state = { name: spec.name, status: 'starting', starts: 0, failures: 0, lastError: null, lastExit: null, startedAt: null, readyAt: null };
    let worker;
    let closing = false;
    let restartTimer;
    let pingTimer;
    let lastPong = 0;
    const owned = new Set();
    const spawned = new Map();
    const stopOwned = () => {
      for (const pid of owned) {
        owned.delete(pid);
        try { process.kill(pid, 'SIGTERM'); } catch { continue; }
        const timer = setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } }, t.ownedKillMs);
        timer.unref?.();
      }
    };
    let nextCallId = 0;
    const calls = new Map();
    let readyResolve;
    const firstReady = new Promise((resolve) => { readyResolve = resolve; });

    function spawn() {
      if (closing) return;
      state.status = 'starting';
      state.starts += 1;
      state.startedAt = Date.now();
      state.readyAt = null;
      lastPong = Date.now();
      let current;
      try {
        current = new Worker(THREAD, {
          workerData: { name: spec.name, module: spec.module, export: spec.export ?? 'start', options: spec.options ?? {}, context, hostMethods },
          env: spec.options?.env ?? process.env,
          resourceLimits: { maxOldGenerationSizeMb: t.heapMb },
          stdout: false, stderr: false,
        });
      } catch (error) {
        state.lastError = plainError(error);
        report(`could not start: ${error.message}`);
        scheduleRestart();
        return;
      }
      worker = current;
      current.on('message', (message) => { if (worker === current) void receive(current, message); });
      current.on('error', (error) => {
        state.lastError = plainError(error);
        report(`failed: ${error?.stack ?? error?.message ?? error}`);
      });
      current.on('exit', (code) => {
        if (worker !== current) return;
        worker = undefined;
        clearInterval(pingTimer);
        stopOwned();
        for (const [id, call] of calls) { calls.delete(id); call.reject(new Error(`The resident service "${spec.name}" stopped`)); }
        if (closing) { state.status = 'stopped'; return; }
        state.lastExit = code;
        report(`stopped (exit ${code}); starting it again`);
        scheduleRestart();
      });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (worker !== current) return;
        if (Date.now() - lastPong > t.hungMs) {
          state.lastError = { name: 'Hung', message: `no answer for ${t.hungMs} ms` };
          report(`did not answer for ${t.hungMs} ms; terminating its thread`);
          void current.terminate();
          return;
        }
        current.postMessage({ type: 'ping' });
      }, t.pingMs);
      pingTimer.unref?.();
    }

    function scheduleRestart() {
      state.status = 'restarting';
      // A service that ran a while before failing is not crash-looping: start it again soon.
      if (state.readyAt && Date.now() - state.readyAt >= t.healthyMs) state.failures = 0;
      const wait = Math.min(t.restartMaxMs, t.restartMinMs * 2 ** state.failures);
      state.failures += 1;
      state.nextStartAt = Date.now() + wait;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(spawn, wait);
      restartTimer.unref?.();
    }

    async function receive(current, message) {
      switch (message?.type) {
        case 'pong': lastPong = Date.now(); return;
        case 'own': owned.add(message.pid); return;
        case 'spawn': {
          let started;
          try {
            started = spawnProcess(message.command, message.args ?? [], { cwd: message.options?.cwd, env: message.options?.env,
              stdio: message.options?.stdio ?? 'ignore', detached: false });
          } catch (error) {
            try { current.postMessage({ type: 'spawned', id: message.id, error: { message: error.message, code: error.code } }); } catch {}
            return;
          }
          spawned.set(message.id, started);
          if (started.pid) owned.add(started.pid);
          started.once('error', (error) => {
            if (started.pid) return;
            spawned.delete(message.id);
            try { current.postMessage({ type: 'spawned', id: message.id, error: { message: error.message, code: error.code } }); } catch {}
          });
          started.once('exit', (code, signal) => {
            spawned.delete(message.id);
            owned.delete(started.pid);
            if (worker === current) try { current.postMessage({ type: 'child-exit', id: message.id, code, signal }); } catch {}
          });
          // The thread ended while this was starting: nobody would stop it.
          if (worker !== current) { stopOwned(); return; }
          if (started.pid) current.postMessage({ type: 'spawned', id: message.id, pid: started.pid });
          return;
        }
        case 'child-kill': {
          try { spawned.get(message.id)?.kill(message.signal); } catch { /* ended */ }
          return;
        }
        case 'disown': owned.delete(message.pid); return;
        case 'ready':
          state.status = 'running'; state.readyAt = Date.now(); state.nextStartAt = undefined;
          log(`resident service ${spec.name} running`);
          readyResolve();
          return;
        case 'error': report(message.error?.stack ?? message.error?.message ?? 'error'); return;
        case 'log': log(`${spec.name} ${message.event}${message.details === undefined ? '' : ` ${JSON.stringify(message.details)}`}`); return;
        case 'host': {
          let reply;
          try {
            if (!hostMethods.includes(message.method)) throw new Error(`The engine offers no ${message.method}() to resident services`);
            const value = await host[message.method](...(message.args ?? []));
            reply = { type: 'host-result', id: message.id, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) };
          } catch (error) { reply = { type: 'host-result', id: message.id, error: plainError(error) }; }
          try { current.postMessage(reply); } catch { /* the thread is gone */ }
          return;
        }
        case 'call-result': {
          const call = calls.get(message.id);
          if (!call) return;
          calls.delete(message.id);
          if (message.error) call.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
          else call.resolve(message.value);
          return;
        }
      }
    }

    spawn();
    return {
      state,
      ready: firstReady,
      call(method, args) {
        if (!worker || state.status !== 'running') return Promise.reject(new Error(`The resident service "${spec.name}" is not running`));
        const id = ++nextCallId;
        return new Promise((resolve, reject) => {
          calls.set(id, { resolve, reject });
          worker.postMessage({ type: 'call', id, method, args });
        });
      },
      async close() {
        closing = true;
        clearTimeout(restartTimer);
        clearInterval(pingTimer);
        const current = worker;
        if (!current) { state.status = 'stopped'; return; }
        const exited = new Promise((resolve) => current.once('exit', resolve));
        try { current.postMessage({ type: 'close' }); } catch { /* already gone */ }
        let timer;
        const late = new Promise((resolve) => { timer = setTimeout(resolve, t.closeMs, 'late'); });
        if (await Promise.race([exited, late]) === 'late') {
          report(`did not close within ${t.closeMs} ms; terminating its thread`);
          await current.terminate().catch(() => {});
        }
        clearTimeout(timer);
        state.status = 'stopped';
      },
    };
  }

  return {
    /** Resolves when every service has been running once (tests and status pages). */
    ready: Promise.all([...supervisors.values()].map((item) => item.ready)),
    status: () => [...supervisors.values()].map(({ state }) => ({ ...state })),
    call(name, method, ...args) {
      const supervisor = supervisors.get(name);
      if (!supervisor) return Promise.reject(new Error(`No resident service named "${name}"`));
      return supervisor.call(method, args);
    },
    async close() {
      await Promise.all([...supervisors.values()].map((item) => item.close().catch((error) => { try { onError(error); } catch {} })));
    },
  };
}
