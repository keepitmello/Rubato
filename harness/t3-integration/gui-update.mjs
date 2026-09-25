#!/usr/bin/env node
// One-shot updater. No Electron binary/module is held open across a rebuild.
import { spawn, execFile } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const tokenPattern = /^[a-f0-9-]{36}$/;
export const stateDirectory = (env = process.env) =>
  path.join(env.HOME || env.USERPROFILE || homedir(), '.rubato-pi', 'gui-update');
export const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
export async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); } finally { await handle.close(); }
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
}

// An interrupted worker can leave its lock. Recover only a dead owner's lock;
// malformed/new locks are not assumed free while another process is creating one.
async function lock(directory, token) {
  const file = path.join(directory, 'lock.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
      finally { await handle.close(); }
      return async () => {
        if ((await readJson(file))?.token === token) await unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(file);
      if (owner && alive(owner.pid)) return null;
      if (!owner && Date.now() - (await stat(file)).mtimeMs < 30_000) return null;
      // Recheck immediately before removal. Simultaneous stale-lock recovery is
      // serialized separately, so a contender cannot remove a newly acquired lock.
      let recovery;
      try { recovery = await open(path.join(directory, 'recover.lock'), 'wx', 0o600); }
      catch (cause) { if (cause.code === 'EEXIST') return null; throw cause; }
      try {
        const current = await readJson(file);
        if (current && alive(current.pid)) return null;
        await unlink(file).catch((cause) => { if (cause.code !== 'ENOENT') throw cause; });
      } finally {
        await recovery.close();
        await unlink(path.join(directory, 'recover.lock'));
      }
    }
  }
  return null;
}

export async function checkForUpdate({ root = repo, env = process.env } = {}) {
  let available = false;
  try {
    await exec('/bin/bash', [path.join(root, 'harness/scripts/rubato-update.sh'), '--check'],
      { cwd: root, env: { ...env, RUBATO_GUI_UPDATE: '1' }, timeout: 20_000, maxBuffer: 128 * 1024 });
  } catch (error) {
    if (error.code !== 10) {
      // rubato-update.sh names the real reason (wrong branch, offline). Saying
      // "network" for a checkout on another branch sent people the wrong way.
      const reason = String(error.stderr ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .split('\n').map((line) => line.replace(/^\s*✗\s*/, '').trim()).filter(Boolean).at(-1);
      throw new Error(reason || '업데이트를 확인하지 못했어요. 네트워크를 확인한 뒤 다시 시도해 주세요.', { cause: error });
    }
    available = true;
  }
  if (!available) return { available: false };
  const git = async (...args) => (await exec('git', ['-C', root, ...args],
    { env, timeout: 5000, maxBuffer: 128 * 1024 })).stdout.trim();
  return {
    available: true,
    revision: await git('rev-parse', 'origin/rubato/base'),
    commits: Number(await git('rev-list', '--count', 'HEAD..origin/rubato/base')),
  };
}

// The update process gets its own group. New apps must be detached from that
// group too (restart-gui.sh), so a timed-out build can be cleaned up safely.
async function executeUpdate(command, args, options, timeoutMs, signal) {
  const child = spawn(command, args, { ...options, detached: true, stdio: 'inherit' });
  let timedOut = false;
  let escalation;
  const terminate = () => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    escalation = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
  };
  const timer = setTimeout(terminate, timeoutMs);
  signal.addEventListener('abort', terminate, { once: true });
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, exitSignal) => {
        if (timedOut) reject(new Error('업데이트가 제한 시간 안에 끝나지 않아 중단했어요.'));
        else if (code !== 0) reject(new Error(`업데이트를 마치지 못했어요 (${exitSignal || code}). 오류 기록을 확인해 주세요.`));
        else resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', terminate);
    // If the shell exited on TERM, its build children may still be alive.
    if (timedOut) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    clearTimeout(escalation);
  }
}

export async function runUpdate({
  token, parentPid, root = repo, env = process.env,
  updateTimeoutMs = 30 * 60_000, readyTimeoutMs = 90_000,
  command = '/bin/bash', args,
  notify = notifyFailure,
} = {}) {
  if (!tokenPattern.test(token) || !Number.isSafeInteger(parentPid) || parentPid < 2) throw new Error('Invalid update request');
  const directory = stateDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lock(directory, token);
  if (!release) return { duplicate: true };
  const resultFile = path.join(directory, 'result.json');
  const readyFile = path.join(directory, `ready-${token}.json`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const ignoreHangup = () => {};
  process.on('SIGHUP', ignoreHangup);
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  let result;
  try {
    await atomicJson(resultFile, { token, status: 'running', pid: process.pid, startedAt: Date.now() });
    const script = path.join(root, 'harness/scripts/rubato-update.sh');
    // git may replace the updater itself. Bash must not keep reading that file
    // at old byte offsets after the pull; $0 still supplies its original HERE.
    const updateArgs = args ?? ['-c', await readFile(script, 'utf8'), script, '--yes'];
    await executeUpdate(command, updateArgs, {
      cwd: root,
      env: { ...env, RUBATO_GUI_UPDATE: '1', RUBATO_GUI_UPDATE_TOKEN: token,
        RUBATO_GUI_UPDATE_NODE: process.execPath, RUBATO_GUI_UPDATE_RELAUNCH: '1' },
    }, updateTimeoutMs, controller.signal);
    const deadline = Date.now() + readyTimeoutMs;
    while (!controller.signal.aborted && Date.now() < deadline) {
      const ready = await readJson(readyFile);
      if (ready?.token === token && ready.pid !== parentPid && alive(ready.pid)) {
        result = { token, status: 'succeeded', appPid: ready.pid, finishedAt: Date.now() };
        break;
      }
      await delay(200, undefined, { signal: controller.signal });
    }
    if (!result) throw new Error('업데이트는 실행됐지만 앱이 다시 열렸는지 확인하지 못했어요. Rubato를 직접 열어 주세요.');
  } catch (error) {
    result = { token, status: 'failed', message: error.message, finishedAt: Date.now() };
  } finally {
    try {
      if (result) await atomicJson(resultFile, result);
    } finally {
      await unlink(readyFile).catch(() => {});
      await release();
      process.removeListener('SIGHUP', ignoreHangup);
      process.removeListener('SIGTERM', abort);
      process.removeListener('SIGINT', abort);
    }
  }
  if (result?.status === 'failed') await notify(result.message).catch(() => {});
  return result;
}

async function notifyFailure(message) {
  // A notification returns immediately; no shell waits for a dialog dismissal.
  // The durable result is also displayed by the app on the next window load.
  if (process.platform !== 'darwin') return;
  await exec('/usr/bin/osascript', ['-e',
    'on run argv\n display notification (item 1 of argv) with title "Rubato 업데이트 실패"\nend run', message],
  { timeout: 5000 });
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'check') console.log(JSON.stringify(await checkForUpdate()));
    else if (process.argv[2] === 'run') {
      const result = await runUpdate({ token: process.argv[3], parentPid: Number(process.argv[4]) });
      process.exitCode = result?.status === 'failed' ? 1 : 0;
    } else throw new Error('Usage: gui-update.mjs check | run TOKEN APP_PID');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
