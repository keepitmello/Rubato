// An engine that closes the way one with running conversations does: on SIGTERM its socket goes
// at once, but the process (and the profile lock it holds) stays for `--close-ms` more.
// Named cli.mjs and started with --agent-dir so the restart helper finds it like a real engine; it
// holds the real profile lock, so the next engine cannot start before it ends.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import lockfile from 'proper-lockfile';

const { values } = parseArgs({ options: { 'agent-dir': { type: 'string' }, 'close-ms': { type: 'string' } } });
const serverDir = path.join(values['agent-dir'], 'server');
mkdirSync(serverDir, { recursive: true });
// The profile lock, held as profile-server.mjs holds it, until the process ends.
await lockfile.lock(values['agent-dir'], { lockfilePath: path.join(serverDir, 'owner.lock'), stale: 15000, update: 5000, retries: 0 });
const socketPath = path.join(serverDir, 'pi.sock');
const server = createServer((socket) => socket.destroy());
server.listen(socketPath, () => {
  writeFileSync(path.join(serverDir, 'connection.json'), JSON.stringify({ version: 1, serverId: randomUUID(), socketPath }));
  process.stdout.write('ready\n');
});
process.on('SIGTERM', () => {
  server.close();
  setTimeout(() => process.exit(0), Number(values['close-ms']));
});
