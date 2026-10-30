#!/usr/bin/env node
// One-shot updater. No Electron binary/module is held open across a rebuild.
// It also runs Settings > About's `rubato restart`: the same lock keeps an update
// and a restart from rebuilding the app at once, and the same result file and
// reopen handshake tell the app whether the restart finished.
import { spawn, execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, stat, realpath } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
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

// A scheduled update or restart lets running work finish first (pi-server drain.mjs) while the
// person keeps working. "Now", a second press, asks the job to stop waiting: the engine restart
// cuts running work at once (restart-profile-engine.mjs). The stage tells the page what the job
// is waiting on. Both name the job's token, so a file a past job left answers nothing.
const nowPath = (directory) => path.join(directory, 'now.json');
const stagePath = (directory) => path.join(directory, 'stage.json');
export const requestNow = (directory, token) => atomicJson(nowPath(directory), { token, at: Date.now() });
export const nowRequested = async (directory, token) => Boolean(token) && (await readJson(nowPath(directory)))?.token === token;
export const markStage = (directory, token, stage) => atomicJson(stagePath(directory), { token, stage, at: Date.now() });
export const jobStage = async (directory, token) => {
  const saved = await readJson(stagePath(directory));
  return token && saved?.token === token ? saved.stage : null;
};

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
      throw new Error(reason || 'Could not check for updates. Check the network and try again.', { cause: error });
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
async function executeUpdate(command, args, options, timeoutMs, signal, did = 'The update') {
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
        if (timedOut) reject(new Error(`${did} took too long and was stopped.`));
        else if (code !== 0) reject(new Error(`${did} did not finish (${exitSignal || code}). Check the log.`));
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

const WORDS = {
  update: { did: 'The update', failed: 'Rubato update failed' },
  restart: { did: 'The restart', failed: 'Rubato restart failed' },
};

/**
 * kind 'restart' runs `rubato restart` instead of the update. Its parentPid is the
 * app to replace, or 0 when no app runs here (a server without a desktop app):
 * then exit 0 is success and nothing waits for a reopened window.
 */
export async function runUpdate({
  token, parentPid, root = repo, env = process.env, kind = 'update',
  updateTimeoutMs = 30 * 60_000, readyTimeoutMs = 90_000,
  command, args,
  notify = notifyFailure,
} = {}) {
  const words = WORDS[kind];
  const app = parentPid !== 0 || kind !== 'restart';
  if (!words || !tokenPattern.test(token) || !Number.isSafeInteger(parentPid) || (app && parentPid < 2))
    throw new Error('Invalid update request');
  const directory = stateDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lock(directory, token);
  if (!release) return { duplicate: true };
  const resultFile = path.join(directory, 'result.json');
  const readyFile = path.join(directory, `ready-${token}.json`);
  // restart-gui.sh leaves this when the app could stay open: nothing it runs
  // changed, so it only reconnects to the new engine and no window reopens.
  const keptFile = path.join(directory, `kept-${token}.json`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const ignoreHangup = () => {};
  process.on('SIGHUP', ignoreHangup);
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  let result;
  try {
    await atomicJson(resultFile, { token, kind, status: 'running', pid: process.pid, startedAt: Date.now() });
    let jobArgs = args;
    if (!jobArgs && kind === 'update') {
      const script = path.join(root, 'harness/scripts/rubato-update.sh');
      // git may replace the updater itself. Bash must not keep reading that file
      // at old byte offsets after the pull; $0 still supplies its original HERE.
      jobArgs = ['-c', await readFile(script, 'utf8'), script, '--yes'];
    }
    jobArgs ??= [path.join(root, 'harness/scripts/rubato-pi.sh'), 'restart'];
    // rubato-pi.sh is a POSIX sh script; ~/.local/bin/rubato runs it with /bin/sh too.
    command ??= kind === 'update' ? '/bin/bash' : '/bin/sh';
    // The relaunch variables hand the token to the reopened app (its ready file)
    // and detach it from this job's process group. Without an app, restart-gui.sh
    // must not open one.
    const jobEnv = { ...env, RUBATO_GUI_UPDATE_TOKEN: token, RUBATO_GUI_UPDATE_NODE: process.execPath };
    if (kind === 'update') jobEnv.RUBATO_GUI_UPDATE = '1';
    if (app) jobEnv.RUBATO_GUI_UPDATE_RELAUNCH = '1';
    await executeUpdate(command, jobArgs, { cwd: root, env: jobEnv }, updateTimeoutMs, controller.signal, words.did);
    if (!app) result = { token, kind, status: 'succeeded', finishedAt: Date.now() };
    else if ((await readJson(keptFile))?.token === token && alive(parentPid))
      result = { token, kind, status: 'succeeded', appPid: parentPid, kept: true, finishedAt: Date.now() };
    const deadline = Date.now() + readyTimeoutMs;
    while (app && !result && !controller.signal.aborted && Date.now() < deadline) {
      const ready = await readJson(readyFile);
      if (ready?.token === token && ready.pid !== parentPid && alive(ready.pid)) {
        result = { token, kind, status: 'succeeded', appPid: ready.pid, finishedAt: Date.now() };
        break;
      }
      await delay(200, undefined, { signal: controller.signal });
    }
    if (!result) throw new Error(`${words.did} ran, but the app did not confirm it reopened. Open Rubato yourself.`);
  } catch (error) {
    result = { token, kind, status: 'failed', message: error.message, finishedAt: Date.now() };
  } finally {
    try {
      if (result) await atomicJson(resultFile, result);
    } finally {
      await unlink(readyFile).catch(() => {});
      await unlink(keptFile).catch(() => {});
      await release();
      process.removeListener('SIGHUP', ignoreHangup);
      process.removeListener('SIGTERM', abort);
      process.removeListener('SIGINT', abort);
    }
  }
  if (result?.status === 'failed') await notify(result.message, words.failed).catch(() => {});
  return result;
}

// macOS ends what a Dock-launched app started once that app quits, unless the person allowed the
// app to run in the background: loginwindow terminates the app's coalition and Background Task
// Management decides. A detached child (new session, new process group) is still in that
// coalition, so a restart or update that quits the app also took down its own updater and the
// script that reopens the app — "The operation was aborted", no window (2026-10-30, loginwindow
// "killing coalition pid"). A launchd job starts in a coalition of its own, so the job is handed to
// launchd and outlives the app the way the engine job does.
export const LAUNCHD_LABEL = 'com.keepitmello.rubato.gui-update';
const IN_LAUNCHD = 'RUBATO_GUI_UPDATE_LAUNCHD';
// launchd's own per-job values; the job gets fresh ones.
const LAUNCHD_OWN_ENV = new Set(['XPC_SERVICE_NAME', 'XPC_FLAGS']);

/** Whether `run`/`restart` hand the job to launchd: macOS, not already in the job, and the
 * account's own home or a caller that named its own launchctl (a test HOME never reaches launchd). */
export function launchdApplies(env = process.env, { platform = process.platform } = {}) {
  if (platform !== 'darwin' || env[IN_LAUNCHD] === '1') return false;
  if (env.RUBATO_LAUNCHCTL_BIN) return true;
  try { return realpathSync(env.HOME || homedir()) === realpathSync(userInfo().homedir); } catch { return false; }
}

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
// XML 1.0 has no form for these; a plist holding one does not load.
const plistSafe = (value) => !/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(value);

/** A one-shot job: runs once when loaded, never again, and leaves the app it reopens running. */
export function renderLaunchdJob({ label = LAUNCHD_LABEL, programArguments, env, cwd, logPath }) {
  const vars = Object.fromEntries(Object.entries(env)
    .filter(([key, value]) => typeof value === 'string' && !LAUNCHD_OWN_ENV.has(key) && plistSafe(key) && plistSafe(value)));
  vars[IN_LAUNCHD] = '1';
  const dict = Object.keys(vars).sort().map((key) => `<key>${xml(key)}</key><string>${xml(vars[key])}</string>`).join('');
  const args = programArguments.map((value) => `<string>${xml(value)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${xml(cwd)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>AbandonProcessGroup</key><true/>
<key>EnvironmentVariables</key><dict>${dict}</dict>
<key>StandardOutPath</key><string>${xml(logPath)}</string>
<key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`;
}

/**
 * Loads `args` (`run|restart TOKEN APP_PID`) as this account's one gui-update job and returns once
 * launchd has it. The job's own lock still decides whether it runs; a job that is running now is
 * never booted out for a new one. The plist stays outside LaunchAgents: it is not a login item and
 * is gone from launchd after logout.
 * @returns {Promise<'launched' | 'duplicate'>}
 */
export async function handOffToLaunchd(args, { env = process.env, label = LAUNCHD_LABEL,
  launchctl = env.RUBATO_LAUNCHCTL_BIN || '/bin/launchctl', uid = process.getuid?.(),
  node = process.execPath, script = fileURLToPath(import.meta.url), cwd = repo, retryMs = 200 } = {}) {
  if (uid === undefined) throw new Error('launchd needs a user id');
  const directory = stateDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const owner = await readJson(path.join(directory, 'lock.json'));
  if (owner && alive(owner.pid)) return 'duplicate';
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const launch = (...argv) => exec(launchctl, argv, { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const running = await launch('print', target).then(({ stdout }) => /^\s*pid = \d+/m.test(stdout), () => false);
  if (running) return 'duplicate';
  // The last job ran and ended; launchd still holds its definition under this label.
  await launch('bootout', target).catch(() => {});
  const plistPath = path.join(directory, `${label}.plist`);
  await atomicJsonText(plistPath, renderLaunchdJob({ label, programArguments: [node, script, ...args], env, cwd,
    logPath: path.join(directory, 'update.log') }));
  // A bootout can return before launchd lets go of the label; the bootstrap then fails with EIO.
  for (let attempt = 1; ; attempt++) {
    try { await launch('bootstrap', domain, plistPath); return 'launched'; }
    catch (error) {
      if (attempt >= 10) throw new Error(`launchctl bootstrap failed: ${String(error.stderr || error.message).trim()}`, { cause: error });
      await delay(retryMs);
    }
  }
}

async function atomicJsonText(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(text); } finally { await handle.close(); }
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
}

/** The `run`/`restart` command: hands the job to launchd where that applies, else runs it here. A
 * failed handoff runs it here as before, which still works when the app was not opened from the Dock. */
export async function startJob({ kind, token, parentPid, env = process.env, platform = process.platform,
  handOff = handOffToLaunchd, run = runUpdate, log = console.error } = {}) {
  if (!tokenPattern.test(token ?? '') || !Number.isSafeInteger(parentPid)) throw new Error('Invalid update request');
  if (launchdApplies(env, { platform })) {
    try {
      const handed = await handOff([kind === 'update' ? 'run' : 'restart', token, String(parentPid)], { env });
      return handed === 'duplicate' ? { duplicate: true } : { launchd: true };
    } catch (error) {
      log(`gui-update: launchd handoff failed, running here: ${error.message}`);
    }
  }
  // The marker belongs to this job alone. Handed down, the app it reopens would take its own next
  // restart for one already in launchd and run it inside the app again.
  const { [IN_LAUNCHD]: _inJob, ...jobEnv } = env;
  return run({ kind, token, parentPid, env: jobEnv });
}

async function notifyFailure(message, title) {
  // A notification returns immediately; no shell waits for a dialog dismissal.
  // The durable result is also displayed by the app on the next window load.
  if (process.platform !== 'darwin') return;
  await exec('/usr/bin/osascript', ['-e',
    'on run argv\n display notification (item 1 of argv) with title (item 2 of argv)\nend run', message, title],
  { timeout: 5000 });
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'check') console.log(JSON.stringify(await checkForUpdate()));
    else if (process.argv[2] === 'run' || process.argv[2] === 'restart') {
      const kind = process.argv[2] === 'run' ? 'update' : 'restart';
      const result = await startJob({ kind, token: process.argv[3], parentPid: Number(process.argv[4]) });
      process.exitCode = result?.status === 'failed' ? 1 : 0;
    } else throw new Error('Usage: gui-update.mjs check | run TOKEN APP_PID | restart TOKEN APP_PID|0');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
