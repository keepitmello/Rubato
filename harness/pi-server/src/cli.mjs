#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { serveProfile } from './profile-server.mjs';
import { resolveLaunchAgentDir } from '../../rubato-pi/src/launch.mjs';
import { installedSharedRuntime } from './discovery.mjs';
import { errorLog } from './error-log.mjs';
import { installExitGuard } from './exit-guard.mjs';
import { loginShellPath, mergePaths } from './launchd.mjs';
import { rmSync } from 'node:fs';
import { listenerPid } from '../../scripts/profile-engine-pid.mjs';

const LOCK_WAIT_MS = 1000;

try {
  const { values } = parseArgs({ options: {
    'agent-dir': { type: 'string' }, socket: { type: 'string' }, 'idle-ms': { type: 'string' }, 'runtime-root': { type: 'string' },
    launchd: { type: 'boolean' }, help: { type: 'boolean' },
  }, allowPositionals: false });
  if (values.help) {
    console.log('Usage: node harness/pi-server/src/cli.mjs [--agent-dir /absolute/profile] [--socket /short/pi.sock] [--idle-ms 60000] [--runtime-root /verified/engine] [--launchd]');
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
    // A stop drains first: running work reaches the drain gate and the next engine continues
    // it (drain.mjs). A second stop signal cuts the wait short.
    let service;
    let stopRequested = false;
    let closing = false;
    const stop = async () => {
      stopRequested = true;
      if (!service) return;
      if (closing) { service.stopDraining?.(); return; }
      closing = true;
      try { await service.close({ drain: true }); } catch (error) { console.error(error); process.exitCode = 1; }
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const idleMs = values['idle-ms'] === 'never' ? null : Number(values['idle-ms'] ?? 60000);
    const agentDir = path.resolve(values['agent-dir'] ?? resolveLaunchAgentDir());
    // launchd (launchd.mjs) starts this engine with a bare environment. Conversations run their
    // tools with the login shell's PATH, as they do when the app starts the engine.
    if (values.launchd) process.env.PATH = mergePaths(loginShellPath(), process.env.PATH);
    // The resident services (the companion, the scheduler, ...) belong to the person's own
    // profile, not to a profile a test or a tool started.
    const options = { agentDir, socketPath: values.socket, idleMs, runtimeRoot: values['runtime-root'] ?? installedSharedRuntime(),
      onError: errorLog(), resident: agentDir === path.resolve(resolveLaunchAgentDir()),
      log: (line) => console.log(`${new Date().toISOString()} ${line}`) };
    // Under launchd another engine may hold the profile (one still draining after a restart, or
    // one the app started before this job existed). Exiting would have launchd start us again
    // and again; wait for the lock instead and take over when that engine ends.
    let waiting = false;
    for (;;) {
      try { service = await serveProfile(options); break; }
      catch (error) {
        if (!values.launchd || error?.code !== 'ELOCKED') throw error;
        if (stopRequested) break;
        // A lock no engine process holds is what a killed engine leaves. It would go stale on its
        // own after 15 s; launchd restarted us to serve now, so take it over at once.
        if (!listenerPid(agentDir)) {
          console.error(`${new Date().toISOString()} rubato-pi-server: the engine that held this profile is gone; taking over its lock`);
          rmSync(path.join(agentDir, 'server', 'owner.lock'), { recursive: true, force: true });
          continue;
        }
        if (!waiting) { waiting = true; console.error(`${new Date().toISOString()} rubato-pi-server: another engine holds this profile; waiting to take over`); }
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        if (stopRequested) break;
      }
    }
    if (service) {
      console.log(JSON.stringify({ ...service.descriptor, descriptorPath: service.descriptorPath }));
      if (stopRequested) await stop();
    }
  }
} catch (error) {
  // A start that finds the profile already held (another window or tool asked at the same time, or
  // an engine is still closing) is not a failure of that engine; say so instead of the lock's words.
  console.error(error?.code === 'ELOCKED'
    ? `${new Date().toISOString()} rubato-pi-server: another engine holds this profile; this start is not needed`
    : `rubato-pi-server: ${error.message}`);
  process.exitCode = 1;
}
