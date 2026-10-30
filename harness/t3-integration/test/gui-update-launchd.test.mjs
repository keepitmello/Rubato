import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHD_LABEL, handOffToLaunchd, launchdApplies, renderLaunchdJob, startJob, stateDirectory,
} from '../gui-update.mjs';

const workerModule = fileURLToPath(new URL('../gui-update.mjs', import.meta.url));

// A launchctl that records its calls. `running` makes `print` report a live job; `bootstrap-fails`
// holds how many bootstraps fail with launchd's EIO first; `bootstrap-broken` makes them all fail.
async function fakeLaunchctl(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rubato-gui-update-launchd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'launchctl');
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(root)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const has = (name) => fs.existsSync(path.join(dir, name));
if (args[0] === 'print') {
  if (has('running')) { process.stdout.write('state = running\\n\\tpid = 4242\\n'); process.exit(0); }
  if (has('loaded')) { process.stdout.write('state = not running\\n'); process.exit(0); }
  process.exit(113);
}
if (args[0] === 'bootstrap') {
  if (has('bootstrap-broken')) { process.stderr.write('Bootstrap failed: 5: Input/output error\\n'); process.exit(5); }
  const file = path.join(dir, 'bootstrap-fails');
  const left = Number(has('bootstrap-fails') ? fs.readFileSync(file, 'utf8') : 0);
  if (left > 0) { fs.writeFileSync(file, String(left - 1)); process.stderr.write('Bootstrap failed: 5: Input/output error\\n'); process.exit(5); }
}
process.exit(0);
`);
  chmodSync(bin, 0o755);
  const env = { ...process.env, HOME: root, USERPROFILE: root, RUBATO_LAUNCHCTL_BIN: bin };
  const calls = async () => (await readFile(path.join(root, 'calls.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, bin, env, calls, mark: (name, value = '') => writeFile(path.join(root, name), value) };
}

test('the job is loaded into launchd as a one-shot job that keeps what it reopens', async (t) => {
  const h = await fakeLaunchctl(t);
  const token = randomUUID();
  const handed = await handOffToLaunchd(['restart', token, '77140'], { env: h.env, uid: 501, node: '/x/node', cwd: '/repo' });
  assert.equal(handed, 'launched');
  const plistPath = path.join(stateDirectory(h.env), `${LAUNCHD_LABEL}.plist`);
  assert.deepEqual(await h.calls(), [
    ['print', `gui/501/${LAUNCHD_LABEL}`],
    ['bootout', `gui/501/${LAUNCHD_LABEL}`],
    ['bootstrap', 'gui/501', plistPath],
  ]);
  const plist = await readFile(plistPath, 'utf8');
  assert.match(plist, new RegExp(`<key>ProgramArguments</key><array><string>/x/node</string><string>${workerModule}</string><string>restart</string><string>${token}</string><string>77140</string></array>`));
  assert.match(plist, /<key>RunAtLoad<\/key><true\/><key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(plist, /<key>RUBATO_GUI_UPDATE_LAUNCHD<\/key><string>1<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key><string>\/repo<\/string>/);
  assert.ok(plist.includes(`<key>StandardOutPath</key><string>${path.join(stateDirectory(h.env), 'update.log')}</string>`));
});

test('the job gets the caller environment, minus launchd values and what a plist cannot hold', () => {
  const plist = renderLaunchdJob({ programArguments: ['/n'], cwd: '/', logPath: '/l',
    env: { PATH: '/a&b', XPC_SERVICE_NAME: 'application.app.rubato.t3', ESCAPED: '<x>', CONTROL: 'a\x1bb' } });
  assert.match(plist, /<key>PATH<\/key><string>\/a&amp;b<\/string>/);
  assert.match(plist, /<key>ESCAPED<\/key><string>&lt;x&gt;<\/string>/);
  assert.doesNotMatch(plist, /XPC_SERVICE_NAME|CONTROL/);
});

test('a job that is running now is never booted out for another', async (t) => {
  const h = await fakeLaunchctl(t);
  await h.mark('running');
  assert.equal(await handOffToLaunchd(['run', randomUUID(), '1234'], { env: h.env, uid: 501 }), 'duplicate');
  assert.deepEqual((await h.calls()).map(([verb]) => verb), ['print']);
});

test('a live updater lock answers duplicate before launchd is touched', async (t) => {
  const h = await fakeLaunchctl(t);
  const directory = stateDirectory(h.env);
  await handOffToLaunchd(['run', randomUUID(), '1234'], { env: h.env, uid: 501 });
  await writeFile(path.join(directory, 'lock.json'), JSON.stringify({ pid: process.pid, token: randomUUID() }));
  const before = (await h.calls()).length;
  assert.equal(await handOffToLaunchd(['run', randomUUID(), '1234'], { env: h.env, uid: 501 }), 'duplicate');
  assert.equal((await h.calls()).length, before);
});

test('a bootstrap that races the bootout (EIO) is retried', async (t) => {
  const h = await fakeLaunchctl(t);
  await h.mark('loaded');
  await h.mark('bootstrap-fails', '2');
  assert.equal(await handOffToLaunchd(['restart', randomUUID(), '0'], { env: h.env, uid: 501, retryMs: 1 }), 'launched');
  assert.deepEqual((await h.calls()).map(([verb]) => verb), ['print', 'bootout', 'bootstrap', 'bootstrap', 'bootstrap']);
});

test('a handoff that keeps failing runs the job here, as before', async (t) => {
  const h = await fakeLaunchctl(t);
  await h.mark('bootstrap-broken');
  const ran = [];
  const logged = [];
  const token = randomUUID();
  const result = await startJob({ kind: 'restart', token, parentPid: 77140, env: h.env, platform: 'darwin',
    handOff: (args, options) => handOffToLaunchd(args, { ...options, uid: 501, retryMs: 1 }),
    run: async (options) => { ran.push(options); return { status: 'succeeded' }; }, log: (line) => logged.push(line) });
  assert.equal(result.status, 'succeeded');
  assert.equal(ran.length, 1);
  assert.equal(ran[0].token, token);
  assert.equal(ran[0].kind, 'restart');
  assert.match(logged[0], /launchd handoff failed, running here: launchctl bootstrap failed: Bootstrap failed: 5/);
});

test('update and restart hand off with the command the job runs; nothing runs here', async (t) => {
  const h = await fakeLaunchctl(t);
  const handed = [];
  const run = async () => { throw new Error('must not run here'); };
  const handOff = async (args) => { handed.push(args); return 'launched'; };
  const update = randomUUID();
  const restart = randomUUID();
  assert.deepEqual(await startJob({ kind: 'update', token: update, parentPid: 10, env: h.env, platform: 'darwin', handOff, run }), { launchd: true });
  assert.deepEqual(await startJob({ kind: 'restart', token: restart, parentPid: 0, env: h.env, platform: 'darwin', handOff, run }), { launchd: true });
  assert.deepEqual(handed, [['run', update, '10'], ['restart', restart, '0']]);
});

test('inside the job, off macOS, and under a test HOME the job runs here', async (t) => {
  const h = await fakeLaunchctl(t);
  assert.equal(launchdApplies(h.env, { platform: 'darwin' }), true);
  assert.equal(launchdApplies({ ...h.env, RUBATO_GUI_UPDATE_LAUNCHD: '1' }, { platform: 'darwin' }), false);
  assert.equal(launchdApplies(h.env, { platform: 'linux' }), false);
  const { RUBATO_LAUNCHCTL_BIN: _named, ...testHome } = h.env;
  assert.equal(launchdApplies(testHome, { platform: 'darwin' }), false);
});

test('the job does not hand its launchd marker to what it runs, so the reopened app hands off again', async (t) => {
  const h = await fakeLaunchctl(t);
  const ran = [];
  await startJob({ kind: 'restart', token: randomUUID(), parentPid: 0, env: { ...h.env, RUBATO_GUI_UPDATE_LAUNCHD: '1' },
    platform: 'darwin', handOff: async () => { throw new Error('must not hand off from inside the job'); },
    run: async (options) => { ran.push(options); return { status: 'succeeded' }; } });
  assert.equal(ran.length, 1);
  assert.equal('RUBATO_GUI_UPDATE_LAUNCHD' in ran[0].env, false);
  assert.equal(ran[0].env.HOME, h.env.HOME);
});

test('the CLI hands a restart to launchd and exits at once', { skip: process.platform !== 'darwin' }, async (t) => {
  const h = await fakeLaunchctl(t);
  const token = randomUUID();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [workerModule, 'restart', token, '0'], { env: h.env, stdio: 'ignore' });
    child.once('exit', resolve);
  });
  assert.equal(code, 0);
  assert.deepEqual((await h.calls()).map(([verb]) => verb), ['print', 'bootout', 'bootstrap']);
  const plist = await readFile(path.join(stateDirectory(h.env), `${LAUNCHD_LABEL}.plist`), 'utf8');
  assert.ok(plist.includes(`<string>restart</string><string>${token}</string><string>0</string>`));
});
