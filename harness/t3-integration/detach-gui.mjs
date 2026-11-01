// A fresh session, not merely nohup: the new app must outlive the update group.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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
    const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd] });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      if (command === '/usr/bin/open') child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`open exited ${code}`)));
      else child.once('spawn', resolve);
    });
    child.unref();
  } finally { closeSync(fd); }
}
