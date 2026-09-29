#!/usr/bin/env node
// `rubato schedule` — the small CLI. Registering and editing belong to the settings page and
// the session tool; this lists tasks, starts one now, shows a task's history and manages the
// scheduler's launchd job.
import { homedir } from 'node:os';
import { createScheduleStore, findTask, formatNextRun, ScheduleError } from '../../../packages/schedule-core/src/index.mjs';
import { schedulerLaunchAgentLoaded, startScheduler, uninstallSchedulerLaunchAgent } from './launchd.mjs';

const USAGE = `usage: rubato schedule [list] [--json]
       rubato schedule run <task>          start a task now (name, id or id prefix)
       rubato schedule runs <task> [--json] a task's recent runs
       rubato schedule status              is the scheduler running on this Mac
       rubato schedule install|uninstall   register or remove the scheduler's launchd job`;

const SKIP_LABEL = { sleep: 'Mac was asleep', 'not-running': "didn't run (Mac off or scheduler not running)", overlap: 'previous run still going' };
const pad = (value) => String(value).padStart(2, '0');
const stamp = (iso) => { const at = new Date(iso); return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`; };

export function describeRun(run) {
  if (!run) return 'never ran';
  const when = run.scheduledFor ? stamp(run.scheduledFor) : `manual ${stamp(run.startedAt ?? run.finishedAt)}`;
  if (run.status === 'skipped') {
    const span = run.skipCount > 1 ? ` ×${run.skipCount} · ${stamp(run.scheduledFor)}–${stamp(run.lastScheduledFor).split(' ')[1]}` : ` · ${when}`;
    return `skipped${span} (${SKIP_LABEL[run.reason] ?? run.reason})`;
  }
  if (run.status === 'failed') return `failed · ${when} (${run.reason}${run.detail ? `: ${run.detail}` : ''})`;
  return `${run.status} · ${when}`;
}

export async function main(argv, { env = process.env, out = (text) => process.stdout.write(text), store = createScheduleStore({ env }) } = {}) {
  const args = argv.filter((arg) => arg !== '--json');
  const json = argv.includes('--json');
  const [command = 'list', target] = args;
  const print = (value, text) => out(json ? `${JSON.stringify(value, null, 2)}\n` : text);
  switch (command) {
    case 'list': {
      const listing = await store.list();
      const lines = listing.tasks.map((task) => [
        `${task.enabled ? '●' : '○'} ${task.name}  [${task.id.slice(0, 8)}]`,
        `    ${task.summary} · ${task.enabled ? `next: ${task.nextRunLabel ?? '—'}` : 'off'} · ${task.model ?? 'default model'}`,
        `    ${task.cwd}`,
        `    last: ${task.running ? 'running now' : describeRun(task.lastRun)}`,
      ].join('\n'));
      const banner = listing.scheduler.running ? '' : '\nThe scheduler is not running on this Mac — tasks will not run. Start it: rubato schedule install\n';
      print(listing, `${lines.length ? lines.join('\n\n') : 'No scheduled tasks. Ask any Rubato session, or use Settings > Scheduled tasks in the app.'}\n${banner}`);
      return 0;
    }
    case 'run': {
      const task = findTask((await store.list()).tasks, target);
      const result = await store.runNow(task.id);
      print({ taskId: task.id, ...result }, `Started "${task.name}". It appears as a new session in ${task.cwd}.\n`);
      return 0;
    }
    case 'runs': {
      const task = findTask((await store.list()).tasks, target);
      const { runs } = await store.runs(task.id, { limit: 20 });
      print({ taskId: task.id, runs }, `${task.name}\n${runs.map((run) => `  ${describeRun(run)}${run.sessionId ? `  session ${run.sessionId}` : ''}`).join('\n') || '  no runs yet'}\n`);
      return 0;
    }
    case 'status': {
      const status = store.schedulerStatus();
      const loaded = await schedulerLaunchAgentLoaded(env.RUBATO_LAUNCHCTL_BIN ? { launchctl: env.RUBATO_LAUNCHCTL_BIN } : {}).catch(() => false);
      print({ ...status, launchAgent: loaded, root: store.files.root },
        `${status.running ? `running (pid ${status.pid}, last check ${status.lastTickAt ? formatNextRun(new Date(status.lastTickAt), new Date()) : '—'})` : 'not running'}`
        + ` · launchd job ${loaded ? 'registered' : 'not registered'} · ${store.files.root}\n`);
      return 0;
    }
    case 'install': {
      const result = await startScheduler({ env });
      print(result, result.installed ? `Scheduler started (pid ${result.pid}) and registered with launchd, so it comes back after login.\n`
        : `Scheduler is already running (pid ${result.pid}).\n`);
      return 0;
    }
    case 'uninstall': {
      const result = await uninstallSchedulerLaunchAgent({ home: env.HOME ?? homedir(),
        ...(env.RUBATO_LAUNCHCTL_BIN ? { launchctl: env.RUBATO_LAUNCHCTL_BIN } : {}) });
      print(result, 'Scheduler removed from launchd. Tasks are kept; they will not run until it is installed again.\n');
      return 0;
    }
    case '-h': case '--help': case 'help':
      out(`${USAGE}\n`);
      return 0;
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`rubato schedule: ${error instanceof ScheduleError ? error.message : error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
