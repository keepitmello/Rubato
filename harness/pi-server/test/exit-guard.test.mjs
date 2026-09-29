import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../src/exit-guard.mjs', import.meta.url));

// Each case runs in its own node process: the guard replaces process globals.
function run(body, { signalAfterMs } = {}) {
  const script = `import { installExitGuard } from ${JSON.stringify(guard)};
installExitGuard({ report() {} });
${body}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (signalAfterMs) setTimeout(() => child.kill('SIGTERM'), signalAfterMs);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('a hosted caller cannot end the engine with process.exit, abort or a signal to itself', async () => {
  const result = await run(`
const refused = [];
for (const call of [() => process.exit(0), () => process.abort(), () => process.kill(process.pid, 'SIGTERM'), () => process.kill(0, 'SIGKILL')]) {
  try { call(); } catch (error) { refused.push(error.name); }
}
setTimeout(() => process.exit(0), 5);
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10);
Promise.resolve().then(() => process.exit(2));
setTimeout(() => console.log(JSON.stringify({ refused, alive: true, probe: process.kill(process.pid, 0) })), 100);
`);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    refused: ['HostedExitRefused', 'HostedExitRefused', 'HostedExitRefused', 'HostedExitRefused'],
    alive: true,
    probe: true,
  });
});

test('other uncaught errors still end the engine', async () => {
  const result = await run(`setTimeout(() => { throw new Error('real failure'); }, 5);
setTimeout(() => console.log('still alive'), 200);`);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /real failure/);
  assert.doesNotMatch(result.stdout, /still alive/);
});

test('a signal from outside still stops the engine', async () => {
  const result = await run('setInterval(() => {}, 1000);', { signalAfterMs: 200 });
  assert.equal(result.signal, 'SIGTERM');
});
