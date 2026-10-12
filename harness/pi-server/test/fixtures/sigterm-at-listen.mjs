// Preload for cli-signals.test.mjs. Sends a real SIGTERM to this process the moment the
// profile socket starts listening — after a client could already connect, before the
// engine has finished starting. `kill` runs as a separate program because the engine's
// exit guard refuses process.kill on its own pid.
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const listen = net.Server.prototype.listen;
let sent = false;
net.Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address();
    if (sent || typeof address !== 'string' || !address.includes('bind-')) return;
    sent = true;
    execFileSync('kill', ['-TERM', String(process.pid)]);
  });
  return listen.apply(this, args);
};
