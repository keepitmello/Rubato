import { readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { createScheduleStore, ScheduleError } from '../../../packages/schedule-core/src/index.mjs';
import { ensureProfileEngine } from '../../pi-server/src/discovery.mjs';
import { engineJob, engineJobLoaded, ensureEngineLaunchAgent, resolveNodeBinary } from '../../pi-server/src/launchd.mjs';
import { resolveLaunchAgentDir } from '../../rubato-pi/src/launch.mjs';

// The scheduler runs inside the profile engine (service.mjs), and launchd keeps the engine
// (pi-server launchd.mjs). It no longer has a launchd job of its own: registering the engine
// removes the one older installs have.

export { resolveNodeBinary };

function isAccountHome(home) {
  try { return realpathSync(home) === realpathSync(userInfo().homedir); } catch { return false; }
}

const startFailed = (message, detail) => Object.assign(new ScheduleError('scheduler-start-failed', message), detail ? { detail } : {});

/** Whether the engine's launchd job is loaded on this Mac. */
export async function engineLaunchAgentLoaded({ env = process.env } = {}) {
  try { return await engineJobLoaded(engineJob(env), env); } catch { return false; }
}

/**
 * Makes sure the scheduler runs on this Mac: the settings page's "Start scheduler", the installer
 * and `rubato schedule install` all come here. Registers the engine with launchd (removing the old
 * scheduler job), makes sure the engine runs, and waits for its scheduler's heartbeat.
 * `env.RUBATO_LAUNCHCTL_BIN` substitutes launchctl (tests); without it a HOME that is not the
 * account's is refused, because launchd jobs belong to the account.
 * @returns {Promise<{ running: true, pid: number, installed: boolean }>}
 */
export async function startScheduler({ env = process.env, timeoutMs = 45_000, platform = process.platform } = {}) {
  if (platform !== 'darwin') {
    throw new ScheduleError('unsupported-platform', 'The scheduler runs inside the Rubato engine, which launchd keeps on macOS; this computer is not a Mac.');
  }
  const store = createScheduleStore({ env });
  const home = env.HOME || homedir();
  if (!env.RUBATO_LAUNCHCTL_BIN && !env.RUBATO_ENGINE_LAUNCHD_LABEL && !isAccountHome(home)) {
    throw startFailed('Not starting the scheduler: this HOME is not the account home, and launchd jobs belong to the account.');
  }
  const nodePath = resolveNodeBinary(env);
  if (!nodePath) throw startFailed('Could not find Node.js 24 or newer to run the Rubato engine.');
  const agentDir = path.resolve(resolveLaunchAgentDir(env));
  let registered;
  try { registered = await ensureEngineLaunchAgent({ env, agentDir, nodePath }); }
  catch (error) {
    throw startFailed('Could not register the Rubato engine with launchd.', String(error?.stderr || error?.message || error).trim().slice(0, 500));
  }
  const before = store.schedulerStatus();
  if (before.running) return { running: true, pid: before.pid, installed: registered.bootstrapped };
  try { await ensureProfileEngine({ descriptorPath: path.join(agentDir, 'server', 'connection.json'), env, nodeBin: nodePath }); }
  catch (error) {
    throw startFailed('The Rubato engine did not start.', String(error?.message ?? error).trim().slice(-500));
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = store.schedulerStatus();
    if (status.running) return { running: true, pid: status.pid, installed: registered.bootstrapped };
    if (Date.now() > deadline) {
      let tail = '';
      try { tail = readFileSync(path.join(agentDir, 'logs', 'pi-server.log'), 'utf8').trim().split('\n').slice(-5).join('\n'); } catch {}
      throw startFailed('The Rubato engine runs, but its scheduler did not start.', tail || undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
