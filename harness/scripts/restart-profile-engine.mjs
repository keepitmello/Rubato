#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDescriptor } from '../pi-server/src/descriptor.mjs';
import { ensureProfileEngine, socketAlive } from '../pi-server/src/discovery.mjs';
import { SessionClient } from '../pi-server/src/client.mjs';
import { DRAIN_TIMEOUT_MS, resumeFilePath } from '../pi-server/src/drain.mjs';
import { resolveLaunchAgentDir } from '../rubato-pi/src/launch.mjs';
import { engineJobPid, engineLaunchdApplies, ensureEngineLaunchAgent, reloadEngineJob } from '../pi-server/src/launchd.mjs';
import { markStage, nowRequested, stateDirectory } from '../t3-integration/gui-update.mjs';
// Process lookup lives apart so a test can reach it without the pi-server client above.
import { ancestorPids, listenerPid } from './profile-engine-pid.mjs';

/** How long an engine whose socket already closed may take to close its conversations and exit. */
export const CLOSE_WAIT_MS = 300_000;

/** Whether `pid` still runs. Another user's process (EPERM) counts as running; an exited one its
 * parent has not collected yet (a zombie) does not. */
function processAlive(pid) {
  try { process.kill(pid, 0); } catch (error) { return error?.code === 'EPERM'; }
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return state.status !== 0 ? false : !state.stdout.trim().startsWith('Z');
}

async function runningTurns(descriptor) {
  const client = await new SessionClient({ ...descriptor, timeoutMs: 2500 }).connect();
  try {
    return (await client.list()).filter((item) => ['running', 'waiting', 'starting'].includes(item.status));
  } finally { await client.close(); }
}

// The engine lets running tool calls finish before it closes (pi-server drain.mjs), so the wait
// covers its drain and the close after it. `onDraining` hears once that the engine is still
// finishing work after the stop; `cutShort` is asked while it does, and when it answers true the
// engine gets a second stop, which ends its wait and cuts what still runs.
//
// With launchd keeping the engine (pi-server launchd.mjs) the stop is the same SIGTERM, and
// launchd starts the next engine. `launchdJob` is what registering the job reported: a job whose
// definition changed is reloaded instead (`reload`), which stops the engine it runs the same way.
export async function restartProfileEngine({ descriptorPath, waitMs = DRAIN_TIMEOUT_MS + 30_000, closeWaitMs = CLOSE_WAIT_MS,
  startEngine = (path) => ensureProfileEngine({ descriptorPath: path }),
  onDraining = async () => {}, cutShort = async () => false, pollMs = 50,
  launchdJob, reload = () => reloadEngineJob(), jobPid = () => engineJobPid() } = {}) {
  descriptorPath ??= path.join(resolveLaunchAgentDir(), 'server', 'connection.json');
  if (!path.isAbsolute(descriptorPath)) throw new TypeError('descriptorPath must be absolute');
  let descriptor;
  try { descriptor = await readDescriptor(descriptorPath); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { restarted: false, reason: 'missing' };
    throw error;
  }
  const listening = await socketAlive(descriptor.socketPath);
  const pid = listenerPid(path.dirname(path.dirname(descriptor.socketPath)));
  // A closed socket is also the middle of shutdown, not proof that its owner exited.
  if (!listening && !pid) return { restarted: false, reason: 'dead' };
  let running = [];
  let inspectError = false;
  if (listening) {
    try { running = await runningTurns(descriptor); }
    catch { inspectError = true; }
  }
  if (!pid) return { restarted: false, reason: 'no-pid', running, inspectError };
  let reloading;
  if (launchdJob?.stale) {
    // bootout sends the job's engine the same SIGTERM; an engine launchd does not run (one the app
    // started before the job existed) still gets its own.
    const ownPid = await jobPid().catch(() => undefined);
    reloading = Promise.resolve().then(reload).catch((error) => error);
    if (ownPid !== pid) process.kill(pid, 'SIGTERM');
  } else {
    process.kill(pid, 'SIGTERM');
  }
  const deadline = Date.now() + waitMs;
  let draining = false;
  let cut = false;
  while (Date.now() < deadline) {
    if (!await socketAlive(descriptor.socketPath)) {
      // The socket closes before the engine has closed its conversations and let go of the profile
      // lock; with running conversations that takes a while. The next engine (launchd's, or the one
      // started below) cannot serve before then, so wait for the old process to end first.
      // Closing is under way once the socket is gone, so it gets its own allowance past the drain's.
      const closedBy = Math.max(deadline, Date.now() + closeWaitMs);
      while (processAlive(pid) && Date.now() < closedBy) {
        if (!cut && await cutShort().catch(() => false)) {
          cut = true;
          try { process.kill(pid, 'SIGTERM'); } catch { /* gone meanwhile */ }
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(pollMs, 250)));
      }
      if (processAlive(pid)) return { restarted: false, reason: 'timeout', pid, running, inspectError };
      // Work the old engine handed over is taken up by the next one (drain.mjs). Start it now
      // rather than when some window reconnects: a terminal-only machine has none that will.
      const handedOver = await access(resumeFilePath(path.dirname(descriptorPath))).then(() => true, () => false);
      const reloadError = await reloading;
      let resumeError;
      if (handedOver || launchdJob) await startEngine(descriptorPath).catch((error) => { resumeError = error; });
      return { restarted: !resumeError && !reloadError, ...(resumeError || reloadError ? { reason: 'start-failed' } : {}),
        pid, running, inspectError, handedOver, cut, ...(resumeError ? { resumeError } : {}), ...(reloadError ? { reloadError } : {}),
        ...(launchdJob?.stale ? { reloaded: !reloadError } : {}) };
    }
    if (!draining) { draining = true; await onDraining().catch(() => {}); }
    if (!cut && await cutShort().catch(() => false)) {
      cut = true;
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone meanwhile */ }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { restarted: false, reason: 'timeout', pid, running, inspectError };
}

/** True when the live profile engine is an ancestor of this process — a restart would cut the
 * conversation that ran the command. No live engine, or no pid for it, is not hosting. */
export async function profileEngineHostsCaller({ descriptorPath, ancestors = ancestorPids } = {}) {
  let descriptor;
  try { descriptor = await readDescriptor(descriptorPath); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
  if (!await socketAlive(descriptor.socketPath)) return false;
  const pid = listenerPid(path.dirname(path.dirname(descriptor.socketPath)));
  return Boolean(pid) && ancestors().has(pid);
}

/** Names the conversations the restart carries over on `stderr` and returns the one-word stdout token
 * (`restarted`, `missing`, `dead`, `no-pid`, `timeout <pid>`) the shell callers key on. */
export function reportRestart(result, stderr = process.stderr) {
  if (result.reloadError) {
    stderr.write(`엔진 launchd 설정을 다시 불러오지 못했습니다: ${result.reloadError.message ?? result.reloadError}\n`);
  }
  if (result.resumeError) {
    stderr.write(`새 엔진을 시작하지 못해 재시작이 완료되지 않았습니다: ${result.resumeError.message ?? result.resumeError}\n`);
  }
  if (result.inspectError) {
    stderr.write('진행 중인 대화를 확인하지 못했습니다. 프로필 엔진을 재시작합니다.\n');
  } else if (result.running?.length) {
    const names = result.running.map((item) => item.title || item.sessionId || 'untitled').join(', ');
    stderr.write(`진행 중인 대화 ${result.running.length}개는 하던 도구 호출을 마치고 새 엔진에서 이어 갑니다: ${names}\n`);
  }
  return result.restarted ? 'restarted' : result.reason === 'timeout' && result.pid
    ? `timeout ${result.pid}` : (result.reason ?? 'unknown');
}

export const restartSucceeded = (result) => !result.resumeError && (result.restarted || result.reason === 'missing' || result.reason === 'dead');

function isCli() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isCli()) {
  // Run by the app's Update or Restart (gui-update.mjs): the page shows the wait, and its
  // second press cuts it short.
  const token = process.env.RUBATO_GUI_UPDATE_TOKEN;
  const jobs = token ? stateDirectory(process.env) : null;
  // Every update and restart passes here, so a machine set up before the engine had a launchd job
  // gets it now, and loses the scheduler's own job (pi-server launchd.mjs). Only for the person's
  // own profile: a named descriptor elsewhere is a test or a tool.
  const ownDescriptor = path.join(resolveLaunchAgentDir(), 'server', 'connection.json');
  let launchdJob;
  if ((!process.argv[2] || path.resolve(process.argv[2]) === path.resolve(ownDescriptor)) && engineLaunchdApplies()) {
    try { launchdJob = await ensureEngineLaunchAgent(); }
    catch (error) { process.stderr.write(`엔진을 launchd 에 등록하지 못했습니다: ${error?.stderr || error?.message || error}\n`); }
  }
  const result = await restartProfileEngine({ descriptorPath: process.argv[2], launchdJob,
    ...(jobs ? { onDraining: () => markStage(jobs, token, 'draining'), cutShort: () => nowRequested(jobs, token) } : {}) });
  process.stdout.write(`${reportRestart(result)}\n`);
  process.exit(restartSucceeded(result) ? 0 : 1);
}
