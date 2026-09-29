// The profile engine hosts every conversation in one process: GUI actors, terminal
// presentations and every extension they load. A `process.exit`, `process.abort` or a signal
// sent to our own pid from any of them ends all conversations at once — on 2026-09-29 a
// throwaway test extension that exited after its `session_start` closed every open session.
//
// The engine itself never leaves that way: it closes on SIGINT/SIGTERM from outside
// (cli.mjs) and lets the event loop drain, and terminal presentations exit through their own
// TerminalProcess. So inside the engine those calls are refused. The caller gets an error —
// an extension handler reports it as an extension error — and the other conversations keep
// running. A refusal thrown from a timer or a promise would otherwise surface as an uncaught
// error and crash the engine anyway, so only that error is absorbed there; every other
// uncaught error still ends the process as Node would.
const REFUSED = Symbol.for('rubato.hostedExitRefused');
const INSTALLED = Symbol.for('rubato.hostedExitGuard');

export class HostedExitRefused extends Error {
  constructor(call) {
    super(`${call} refused: this engine hosts every open conversation, so it cannot exit for one of them`);
    this.name = 'HostedExitRefused';
    this[REFUSED] = true;
  }
}

export const isHostedExitRefused = error => Boolean(error?.[REFUSED]);

export function installExitGuard({ proc = process, report = error => console.error(`rubato-pi-server: ${error.stack}`) } = {}) {
  if (proc[INSTALLED]) return false;
  const exit = proc.exit;
  const kill = proc.kill;
  const refuse = call => {
    const error = new HostedExitRefused(call);
    report(error);
    throw error;
  };
  proc.exit = code => refuse(`process.exit(${code ?? ''})`);
  proc.abort = () => refuse('process.abort()');
  proc.kill = function guardedKill(pid, signal) {
    const target = Number(pid);
    // Signal 0 only probes whether a process exists.
    if ((target === proc.pid || target === 0) && signal !== 0 && signal !== '0') {
      refuse(`process.kill(${pid}, ${signal ?? 'SIGTERM'})`);
    }
    return kill.call(proc, pid, signal);
  };
  proc.on('uncaughtException', error => {
    if (isHostedExitRefused(error)) return;
    // Any listener turns off Node's own crash, so keep it for everything else.
    console.error(error);
    exit.call(proc, 1);
  });
  proc[INSTALLED] = true;
  return true;
}
