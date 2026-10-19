// A resident service for the fault tests (resident-services.test.mjs). It counts its starts in
// `options.marker`, starts the real service named by `options.target` when given (the keeper, the
// scheduler, ...), and on its first start injects `options.fault` into its own thread.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function inject(fault, ctx) {
  const later = (work) => setTimeout(work, 50);
  switch (fault) {
    case 'throw': later(() => { throw new Error('injected throw'); }); break;
    case 'reject': later(() => { Promise.reject(new Error('injected rejection')); }); break;
    case 'exit': later(() => process.exit(7)); break;
    case 'kill': later(() => { process.kill(process.pid, 'SIGKILL'); }); break;
    case 'hang': later(() => { for (;;) { /* busy */ } }); break;
    case 'start-throw': throw new Error('injected start failure');
    case 'none': break;
    default: throw new Error(`unknown fault ${fault}`);
  }
  void ctx;
}

export async function start(ctx) {
  const { fault = 'none', target, targetExport = 'start', marker } = ctx.options;
  appendFileSync(marker, 'start\n');
  const starts = readFileSync(marker, 'utf8').split('\n').filter(Boolean).length;
  if (starts === 1 && fault === 'start-throw') inject(fault, ctx);
  const inner = target ? (await (await import(pathToFileURL(target).href))[targetExport](ctx)) ?? {} : {};
  if (starts === 1) inject(fault, ctx);
  return {
    ...inner,
    starts: () => starts,
    notice: (args) => ctx.host.notice(args),
    async close() { appendFileSync(marker, 'closed\n'); await inner.close?.(); },
  };
}
