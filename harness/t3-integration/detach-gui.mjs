// A fresh session, not merely nohup: the new app must outlive the update group.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { INHERITED_JOB_ENV } from './gui-update.mjs';

/** The app keeps the environment it opens with and hands it to its next restart job, so the job's
 * own markers stop here (gui-update.mjs INHERITED_JOB_ENV). The token goes on, for the ready file. */
export function appEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !INHERITED_JOB_ENV.has(key) && key !== 'RUBATO_GUI_UPDATE_NODE'));
}

export function guiLaunchCommand(start, app, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'darwin' || !app) return [start, []];
  // A detached process still belongs to the updater's macOS coalition. LaunchServices
  // must own the app, or quitting that app on the next restart can terminate the updater.
  const args = ['-a', app];
  for (const name of ['RUBATO_GUI_UPDATE_TOKEN', 'T3CODE_HOME']) {
    if (env[name]) args.push('--env', `${name}=${env[name]}`);
  }
  return ['/usr/bin/open', args];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [start, log, app] = process.argv.slice(2);
  const [command, args] = guiLaunchCommand(start, app);
  const fd = openSync(log, 'a', 0o600);
  try {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd], env: appEnvironment() });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      if (command === '/usr/bin/open') child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`open exited ${code}`)));
      else child.once('spawn', resolve);
    });
    child.unref();
  } finally { closeSync(fd); }
}
