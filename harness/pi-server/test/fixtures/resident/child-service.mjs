// A resident service that owns a child process, the way the hub supervisor owns the hub. The
// child (child.mjs) injects `options.childFault` on its first run; this service starts it again
// when it ends. Child pids go to `options.marker`. `options.threadFault` faults the thread itself.
import { fork } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { inject } from './fault.mjs';

export async function start(ctx) {
  const { marker, childFault = 'none', threadFault = 'none' } = ctx.options;
  let runs = 0;
  let child;
  let closing = false;
  const spawnChild = () => {
    runs += 1;
    child = fork(new URL('./child.mjs', import.meta.url), [runs === 1 ? childFault : 'none'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    ctx.own(child);
    appendFileSync(marker, `child ${child.pid}\n`);
    child.on('exit', (code) => {
      appendFileSync(marker, `child-exit ${code}\n`);
      if (!closing) setTimeout(spawnChild, 50);
    });
  };
  spawnChild();
  // The thread faults on its first start only.
  const firstStart = readFileSync(marker, 'utf8').split('\n').filter((line) => line.startsWith('child ')).length === 1;
  if (threadFault !== 'none' && firstStart) setTimeout(() => inject(threadFault, ctx), 300);
  return {
    childPid: () => child?.pid,
    async close() { closing = true; child?.kill('SIGTERM'); },
  };
}
