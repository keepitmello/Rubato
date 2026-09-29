import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createScheduleStore, ScheduleError } from '../../../packages/schedule-core/src/index.mjs';

const execFileAsync = promisify(execFile);
export const SCHEDULER_LAUNCHD_LABEL = 'com.keepitmello.rubato.scheduler';
export const DAEMON_PATH = path.resolve(import.meta.dirname, 'daemon.mjs');

const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/**
 * PATH is the one the installing shell had: launchd hands a job /usr/bin:/bin, and sessions
 * the scheduler starts (and an engine it has to start) would otherwise miss git, bun and
 * friends. AbandonProcessGroup keeps an engine it started alive when launchd restarts it.
 */
export function renderSchedulerLaunchAgent({ nodePath, daemonPath = DAEMON_PATH, home, pathEnv, logPath, scheduleHome }) {
  const extra = scheduleHome ? `<key>RUBATO_SCHEDULE_HOME</key><string>${escapeXml(scheduleHome)}</string>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(SCHEDULER_LAUNCHD_LABEL)}</string>
<key>ProgramArguments</key><array><string>${escapeXml(nodePath)}</string><string>${escapeXml(daemonPath)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>AbandonProcessGroup</key><true/>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${escapeXml(home)}</string><key>PATH</key><string>${escapeXml(pathEnv)}</string>${extra}</dict>
<key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
<key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
</dict></plist>
`;
}

export function launchAgentPaths({ home = homedir(), scheduleRoot } = {}) {
  return {
    plistPath: path.join(home, 'Library', 'LaunchAgents', `${SCHEDULER_LAUNCHD_LABEL}.plist`),
    logPath: path.join(scheduleRoot ?? path.join(home, '.rubato', 'schedule'), 'logs', 'scheduler.log'),
  };
}

export async function installSchedulerLaunchAgent({ nodePath = process.execPath, home = homedir(), pathEnv = process.env.PATH ?? '/usr/bin:/bin',
  scheduleRoot, scheduleHome, launchctl = '/bin/launchctl', uid = process.getuid?.(), env = process.env } = {}) {
  if (uid === undefined) throw new Error('launchd needs a user id');
  const { plistPath, logPath } = launchAgentPaths({ home, scheduleRoot });
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  writeFileSync(plistPath, renderSchedulerLaunchAgent({ nodePath, home, pathEnv, logPath, scheduleHome }));
  const domain = `gui/${uid}`;
  const run = (args) => execFileAsync(launchctl, args, { env });
  await run(['bootout', `${domain}/${SCHEDULER_LAUNCHD_LABEL}`]).catch(() => {});
  await run(['bootstrap', domain, plistPath]);
  await run(['enable', `${domain}/${SCHEDULER_LAUNCHD_LABEL}`]);
  await run(['kickstart', '-k', `${domain}/${SCHEDULER_LAUNCHD_LABEL}`]);
  return { plistPath, logPath, label: SCHEDULER_LAUNCHD_LABEL };
}

export async function uninstallSchedulerLaunchAgent({ home = homedir(), launchctl = '/bin/launchctl', uid = process.getuid?.() } = {}) {
  const { plistPath } = launchAgentPaths({ home });
  await execFileAsync(launchctl, ['bootout', `gui/${uid}/${SCHEDULER_LAUNCHD_LABEL}`]).catch(() => {});
  rmSync(plistPath, { force: true });
  return { plistPath };
}

export async function schedulerLaunchAgentLoaded({ launchctl = '/bin/launchctl', uid = process.getuid?.() } = {}) {
  try { await execFileAsync(launchctl, ['print', `gui/${uid}/${SCHEDULER_LAUNCHD_LABEL}`]); return true; }
  catch { return false; }
}

const nodeMajor = (bin) => {
  try { return Number(String(execFileSync(bin, ['-v'], { encoding: 'utf8', timeout: 5000 })).trim().replace(/^v/, '').split('.')[0]); }
  catch { return 0; }
};

/**
 * A real Node 24+ for the job. The T3 server runs this under Electron, whose execPath is the
 * app, so look where `rubato` itself found Node (its cache), then the usual install places.
 */
export function resolveNodeBinary(env = process.env) {
  const home = env.HOME ?? homedir();
  const candidates = [];
  if (env.RUBATO_NODE) candidates.push(env.RUBATO_NODE);
  if (!process.versions.electron) candidates.push(process.execPath);
  try { candidates.push(readFileSync(path.join(home, '.rubato-pi', 'node-path'), 'utf8').trim()); } catch {}
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  try { candidates.push(...readdirSync(nvm).sort().reverse().map((version) => path.join(nvm, version, 'bin', 'node'))); } catch {}
  candidates.push('/opt/homebrew/opt/node@24/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node');
  for (const candidate of candidates) if (candidate && existsSync(candidate) && nodeMajor(candidate) >= 24) return candidate;
  return null;
}

/**
 * PATH for sessions the scheduler starts. The app is usually opened from the Dock with
 * /usr/bin:/bin, so combine the login shell's PATH with the places Rubato's tools live.
 */
export function composeLaunchPath(env = process.env, nodePath) {
  const home = env.HOME ?? homedir();
  let login = '';
  try { login = execFileSync('/bin/zsh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 3000, env: { HOME: home, USER: env.USER ?? '' } }); } catch {}
  const parts = [
    ...(nodePath ? [path.dirname(nodePath)] : []), ...login.split(':'), ...(env.PATH ?? '').split(':'),
    path.join(home, '.bun', 'bin'), path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  return [...new Set(parts.filter((part) => part && path.isAbsolute(part)))].join(':');
}

function isAccountHome(home) {
  try { return realpathSync(home) === realpathSync(userInfo().homedir); } catch { return false; }
}

const startFailed = (message, detail) => Object.assign(new ScheduleError('scheduler-start-failed', message), detail ? { detail } : {});

/**
 * Makes sure the scheduler runs on this Mac: the settings page's "Start scheduler", the
 * installer and `rubato schedule install` all come here. Already running → nothing to do.
 * Otherwise (re)writes the launchd job for this checkout and starts it, then waits for its
 * heartbeat. `env.RUBATO_LAUNCHCTL_BIN` substitutes launchctl (tests); without it a HOME that
 * is not the account's is refused, because launchd jobs belong to the account.
 * @returns {Promise<{ running: true, pid: number, installed: boolean }>}
 */
export async function startScheduler({ env = process.env, timeoutMs = 10_000, platform = process.platform } = {}) {
  if (platform !== 'darwin') {
    throw new ScheduleError('unsupported-platform', 'The scheduler runs as a macOS launchd job; this computer is not a Mac.');
  }
  const store = createScheduleStore({ env });
  const before = store.schedulerStatus();
  if (before.running) return { running: true, pid: before.pid, installed: false };
  const home = env.HOME ?? homedir();
  const launchctl = env.RUBATO_LAUNCHCTL_BIN || '/bin/launchctl';
  if (!env.RUBATO_LAUNCHCTL_BIN && !isAccountHome(home)) {
    throw startFailed('Not starting the scheduler: this HOME is not the account home, and launchd jobs belong to the account.');
  }
  const nodePath = resolveNodeBinary(env);
  if (!nodePath) throw startFailed('Could not find Node.js 24 or newer to run the scheduler.');
  let logPath;
  try {
    ({ logPath } = await installSchedulerLaunchAgent({ nodePath, home, pathEnv: composeLaunchPath(env, nodePath), launchctl, env,
      scheduleRoot: store.files.root, ...(env.RUBATO_SCHEDULE_HOME?.trim() ? { scheduleHome: store.files.root } : {}) }));
  } catch (error) {
    throw startFailed('Could not register the scheduler with launchd.', String(error?.stderr || error?.message || error).trim().slice(0, 500));
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = store.schedulerStatus();
    if (status.running) return { running: true, pid: status.pid, installed: true };
    if (Date.now() > deadline) {
      let tail = '';
      try { tail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch {}
      throw startFailed('The scheduler was registered but did not start.', tail || undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
