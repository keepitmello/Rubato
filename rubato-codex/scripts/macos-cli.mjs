import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doctor, updateApp, run } from './macos-app.mjs';

export function parseUpdateArgs(args) {
  const options = { action: 'install' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['--check', '--install', '--check-and-install', '--version', '--doctor', '--rollback'].includes(a)) options.action = a === '--check-and-install' ? 'install' : a.slice(2);
    else if (a === '--app') options.appPath = args[++i];
    else if (a === '--upstream-version') options.upstreamVersion = args[++i];
    else if (a === '--wait-for-pid') options.waitForPid = Number(args[++i]);
    else if (a === '--relaunch') options.relaunch = true;
    else throw new Error(`Unknown updater option: ${a}`);
  }
  if (Object.hasOwn(options, 'waitForPid') && (!Number.isSafeInteger(options.waitForPid) || options.waitForPid < 2)) throw new Error('Invalid wait PID');
  for (const key of ['appPath', 'upstreamVersion']) if (Object.hasOwn(options, key) && !options[key]) throw new Error(`Missing ${key}`);
  return options;
}
async function main() {
  const options = parseUpdateArgs(process.argv.slice(2));
  if (options.waitForPid) {
    const probe = spawnSync('/bin/ps', ['-p', String(options.waitForPid), '-o', 'command='], { encoding: 'utf8' });
    if (probe.status !== 0 && probe.status !== 1) throw new Error('Could not inspect update wait PID');
    if (probe.status === 0 && !probe.stdout.includes((options.appPath || '/Applications/Rubato.app') + '/Contents/MacOS/')) throw new Error('Wait PID does not belong to the target Rubato app');
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { process.kill(options.waitForPid, 0); } catch (e) { if (e.code === 'ESRCH') break; throw e; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    try { process.kill(options.waitForPid, 0); throw new Error('Rubato did not exit; update cancelled'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  const result = options.action === 'doctor' ? await doctor(options) : await updateApp(options);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (options.relaunch) run('/usr/bin/open', [options.appPath || '/Applications/Rubato.app']);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`rubato-update: ${error.message}`); process.exitCode = 1; });
