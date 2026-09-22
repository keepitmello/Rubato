// A fresh session, not merely nohup: the new app must outlive the update group.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
const [start, log] = process.argv.slice(2);
const fd = openSync(log, 'a', 0o600);
try {
  const child = spawn(start, [], { detached: true, stdio: ['ignore', fd, fd] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
} finally { closeSync(fd); }
