import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHD_LABEL, handOffToLaunchd, launchdApplies, readJson, renderLaunchdJob, runLaunchdJob, startJob, stateDirectory,
} from '../gui-update.mjs';

const workerModule = fileURLToPath(new URL('../gui-update.mjs', import.meta.url));

// A launchctl that records its calls. `running` makes `print` report a live job, `loaded` a loaded
// idle one (from the path in `loaded`); `bootstrap-fails` holds how many bootstraps fail with
// launchd's EIO first; `bootstrap-broken` makes them all fail.
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
  if (has('loaded')) { process.stdout.write('\\tpath = ' + fs.readFileSync(path.join(dir, 'loaded'), 'utf8') + '\\n\\tstate = not running\\n'); process.exit(0); }
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
  const agentsDir = path.join(root, 'LaunchAgents');
  const env = { ...process.env, HOME: root, USERPROFILE: root, RUBATO_LAUNCHCTL_BIN: bin, RUBATO_LAUNCH_AGENTS_DIR: agentsDir };
  const calls = async () => (await readFile(path.join(root, 'calls.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, bin, env, agentsDir, calls, plistPath: path.join(agentsDir, `${LAUNCHD_LABEL}.plist`),
    mark: (name, value = '') => writeFile(path.join(root, name), value) };
}

test('the job is a standing LaunchAgent (managed by BTM), loaded once and woken per request', async (t) => {
  const h = await fakeLaunchctl(t);
  const token = randomUUID();
  const handed = await handOffToLaunchd(['restart', token, '77140'], { env: h.env, uid: 501, node: '/x/bin/node', cwd: '/repo' });
  assert.equal(handed, 'launched');
  const target = `gui/501/${LAUNCHD_LABEL}`;
  assert.deepEqual(await h.calls(), [['print', target], ['bootstrap', 'gui/501', h.plistPath], ['kickstart', target]]);
  const plist = await readFile(h.plistPath, 'utf8');
  assert.ok(plist.includes(`<key>ProgramArguments</key><array><string>/x/bin/node</string><string>${workerModule}</string><string>launchd-job</string></array>`));
  assert.match(plist, /<key>RunAtLoad<\/key><false\/><key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(plist, /<key>RUBATO_GUI_UPDATE_LAUNCHD<\/key><string>1<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key><string>\/repo<\/string>/);
  assert.ok(plist.includes(`<key>StandardOutPath</key><string>${path.join(stateDirectory(h.env), 'update.log')}</string>`));
  assert.doesNotMatch(plist, new RegExp(token), 'what one run needs is not in the definition BTM sees');
  const request = await readJson(path.join(stateDirectory(h.env), 'request.json'));
  assert.deepEqual(request.args, ['restart', token, '77140']);
  assert.equal(request.env.HOME, h.root);
});

test('an unchanged loaded agent is only woken, not reloaded', async (t) => {
  const h = await fakeLaunchctl(t);
  const options = { env: h.env, uid: 501, node: '/x/bin/node', cwd: '/repo' };
  await handOffToLaunchd(['run', randomUUID(), '10'], options);
  await h.mark('loaded', h.plistPath);
  const before = (await h.calls()).length;
  await handOffToLaunchd(['run', randomUUID(), '10'], options);
  assert.deepEqual((await h.calls()).slice(before).map(([verb]) => verb), ['print', 'kickstart']);
});

test('a changed definition, or one loaded from elsewhere, is reloaded', async (t) => {
  const h = await fakeLaunchctl(t);
  await handOffToLaunchd(['run', randomUUID(), '10'], { env: h.env, uid: 501, node: '/x/bin/node', cwd: '/repo' });
  await h.mark('loaded', h.plistPath);
  let before = (await h.calls()).length;
  await handOffToLaunchd(['run', randomUUID(), '10'], { env: h.env, uid: 501, node: '/y/bin/node', cwd: '/repo' });
  assert.deepEqual((await h.calls()).slice(before).map(([verb]) => verb), ['print', 'bootout', 'bootstrap', 'kickstart']);
  await h.mark('loaded', path.join(stateDirectory(h.env), `${LAUNCHD_LABEL}.plist`));
  before = (await h.calls()).length;
  await handOffToLaunchd(['run', randomUUID(), '10'], { env: h.env, uid: 501, node: '/y/bin/node', cwd: '/repo' });
  assert.deepEqual((await h.calls()).slice(before).map(([verb]) => verb), ['print', 'bootout', 'bootstrap', 'kickstart']);
});

test('the one-shot definition an earlier handoff left beside the state is removed', async (t) => {
  const h = await fakeLaunchctl(t);
  const stale = path.join(stateDirectory(h.env), `${LAUNCHD_LABEL}.plist`);
  await handOffToLaunchd(['run', randomUUID(), '10'], { env: h.env, uid: 501 });
  await writeFile(stale, 'old');
  await handOffToLaunchd(['run', randomUUID(), '10'], { env: h.env, uid: 501 });
  assert.equal(existsSync(stale), false);
});

test('a job that is running now is neither replaced nor given a second request', async (t) => {
  const h = await fakeLaunchctl(t);
  await h.mark('running');
  assert.equal(await handOffToLaunchd(['run', randomUUID(), '1234'], { env: h.env, uid: 501 }), 'duplicate');
  assert.deepEqual((await h.calls()).map(([verb]) => verb), ['print']);
  assert.equal(await readJson(path.join(stateDirectory(h.env), 'request.json')), null);
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
  await h.mark('loaded', '/elsewhere.plist');
  await h.mark('bootstrap-fails', '2');
  assert.equal(await handOffToLaunchd(['restart', randomUUID(), '0'], { env: h.env, uid: 501, retryMs: 1 }), 'launched');
  assert.deepEqual((await h.calls()).map(([verb]) => verb), ['print', 'bootout', 'bootstrap', 'bootstrap', 'bootstrap', 'kickstart']);
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

test('the woken job runs the request once, with the app environment and without the launchd marker', async (t) => {
  const h = await fakeLaunchctl(t);
  const token = randomUUID();
  await handOffToLaunchd(['run', token, '77140'], { env: { ...h.env, APP_ONLY: 'yes', XPC_SERVICE_NAME: 'application.app.rubato.t3' }, uid: 501 });
  const ran = [];
  const jobEnv = { HOME: h.root, RUBATO_GUI_UPDATE_LAUNCHD: '1', RUBATO_LAUNCHCTL_BIN: h.bin };
  await runLaunchdJob({ env: jobEnv, run: (options) => startJob({ ...options, platform: 'darwin',
    handOff: async () => { throw new Error('must not hand off from inside the job'); },
    run: async (inner) => { ran.push(inner); return { status: 'succeeded' }; } }) });
  assert.equal(ran.length, 1);
  assert.equal(ran[0].kind, 'update');
  assert.equal(ran[0].token, token);
  assert.equal(ran[0].parentPid, 77140);
  assert.equal(ran[0].env.APP_ONLY, 'yes');
  assert.equal('RUBATO_GUI_UPDATE_LAUNCHD' in ran[0].env, false, 'the reopened app must hand its next restart off again');
  assert.equal('XPC_SERVICE_NAME' in ran[0].env, false);
  assert.equal(await runLaunchdJob({ env: jobEnv, run: async () => { throw new Error('ran twice'); } }), null);
});

test('inside the job, off macOS, and under a test HOME the job runs here', async (t) => {
  const h = await fakeLaunchctl(t);
  assert.equal(launchdApplies(h.env, { platform: 'darwin' }), true);
  assert.equal(launchdApplies({ ...h.env, RUBATO_GUI_UPDATE_LAUNCHD: '1' }, { platform: 'darwin' }), false);
  assert.equal(launchdApplies(h.env, { platform: 'linux' }), false);
  const { RUBATO_LAUNCHCTL_BIN: _named, ...testHome } = h.env;
  assert.equal(launchdApplies(testHome, { platform: 'darwin' }), false);
});

test('the definition escapes what XML needs', () => {
  const plist = renderLaunchdJob({ node: '/a&b/node', script: '/s', cwd: '/<c>', home: '/h', logPath: '/l' });
  assert.ok(plist.includes('<string>/a&amp;b/node</string>'));
  assert.ok(plist.includes('<string>/&lt;c&gt;</string>'));
});

test('the CLI hands a restart to launchd and exits at once', { skip: process.platform !== 'darwin' }, async (t) => {
  const h = await fakeLaunchctl(t);
  const token = randomUUID();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [workerModule, 'restart', token, '0'], { env: h.env, stdio: 'ignore' });
    child.once('exit', resolve);
  });
  assert.equal(code, 0);
  assert.deepEqual((await h.calls()).map(([verb]) => verb), ['print', 'bootstrap', 'kickstart']);
  assert.deepEqual((await readJson(path.join(stateDirectory(h.env), 'request.json'))).args, ['restart', token, '0']);
});
