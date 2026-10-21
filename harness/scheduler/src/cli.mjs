#!/usr/bin/env node
// `rubato schedule` — the small CLI. Registering and editing belong to the settings page and
// the session tool; this lists tasks, starts one now, shows a task's history and makes sure the
// scheduler runs (inside the profile engine, which launchd keeps). `send` is for scripts: one
// message into a conversation now (an alert, a finished job), delivered by the scheduler with no
// session started.
import { COMPANION_TARGET, createScheduleStore, findTask, formatNextRun, ScheduleError } from '../../../packages/schedule-core/src/index.mjs';
import { engineLaunchAgentLoaded, startScheduler } from './launchd.mjs';

const USAGE = `usage: rubato schedule [list] [--json]
       rubato schedule run <task>          start a task now (name, id or id prefix)
       rubato schedule runs <task> [--json] a task's recent runs
       rubato schedule send <to> <text…>   send a message now to "companion" (Segno) or a conversation id
       rubato schedule status              is the scheduler running on this Mac
       rubato schedule install             make sure it runs: the Rubato engine, kept by launchd, runs it`;

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

const targetLabel = (sendTo) => (sendTo === COMPANION_TARGET ? 'Segno' : `conversation ${sendTo}`);

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
        `    ${task.summary} · ${task.enabled ? `next: ${task.nextRunLabel ?? '—'}` : 'off'} · ${task.sendTo ? 'message, no session' : task.model ?? 'default model'}`,
        `    ${task.sendTo ? `→ ${targetLabel(task.sendTo)}` : task.cwd}`,
        `    last: ${task.running ? 'running now' : describeRun(task.lastRun)}`,
      ].join('\n'));
      const banner = listing.scheduler.running ? '' : '\nThe scheduler is not running on this Mac — tasks will not run. Start it: rubato schedule install\n';
      print(listing, `${lines.length ? lines.join('\n\n') : 'No scheduled tasks. Ask any Rubato session, or use Settings > Scheduled tasks in the app.'}\n${banner}`);
      return 0;
    }
    case 'run': {
      const task = findTask((await store.list()).tasks, target);
      const result = await store.runNow(task.id);
      print({ taskId: task.id, ...result }, task.sendTo ? `Sending "${task.name}" to ${targetLabel(task.sendTo)}.\n`
        : `Started "${task.name}". It appears as a new session in ${task.cwd}.\n`);
      return 0;
    }
    case 'runs': {
      const task = findTask((await store.list()).tasks, target);
      const { runs } = await store.runs(task.id, { limit: 20 });
      print({ taskId: task.id, runs }, `${task.name}\n${runs.map((run) => `  ${describeRun(run)}${run.sessionId ? `  session ${run.sessionId}` : ''}`).join('\n') || '  no runs yet'}\n`);
      return 0;
    }
    case 'send': {
      const text = args.slice(2).join(' ');
      const result = await store.send({ to: target, text });
      print(result, `Queued for ${targetLabel(target.trim())}; the scheduler delivers it in a moment.\n`);
      return 0;
    }
    case 'status': {
      const status = store.schedulerStatus();
      const loaded = await engineLaunchAgentLoaded({ env }).catch(() => false);
      print({ ...status, launchAgent: loaded, root: store.files.root },
        `${status.running ? `running in the engine (pid ${status.pid}, last check ${status.lastTickAt ? formatNextRun(new Date(status.lastTickAt), new Date()) : '—'})` : 'not running'}`
        + ` · engine launchd job ${loaded ? 'registered' : 'not registered'} · ${store.files.root}\n`);
      return 0;
    }
    case 'install': {
      const result = await startScheduler({ env });
      print(result, result.installed ? `The Rubato engine is registered with launchd and runs the scheduler (pid ${result.pid}); both come back after login.\n`
        : `The scheduler is running in the Rubato engine (pid ${result.pid}).\n`);
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
