import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

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
export function renderSchedulerLaunchAgent({ nodePath, daemonPath = DAEMON_PATH, home, pathEnv, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(SCHEDULER_LAUNCHD_LABEL)}</string>
<key>ProgramArguments</key><array><string>${escapeXml(nodePath)}</string><string>${escapeXml(daemonPath)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>AbandonProcessGroup</key><true/>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${escapeXml(home)}</string><key>PATH</key><string>${escapeXml(pathEnv)}</string></dict>
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
  scheduleRoot, launchctl = '/bin/launchctl', uid = process.getuid?.() } = {}) {
  if (uid === undefined) throw new Error('launchd needs a user id');
  const { plistPath, logPath } = launchAgentPaths({ home, scheduleRoot });
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  writeFileSync(plistPath, renderSchedulerLaunchAgent({ nodePath, home, pathEnv, logPath }));
  const domain = `gui/${uid}`;
  await execFileAsync(launchctl, ['bootout', `${domain}/${SCHEDULER_LAUNCHD_LABEL}`]).catch(() => {});
  await execFileAsync(launchctl, ['bootstrap', domain, plistPath]);
  await execFileAsync(launchctl, ['enable', `${domain}/${SCHEDULER_LAUNCHD_LABEL}`]);
  await execFileAsync(launchctl, ['kickstart', '-k', `${domain}/${SCHEDULER_LAUNCHD_LABEL}`]);
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
