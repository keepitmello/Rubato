import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ENGINE_CLI, ENGINE_LAUNCHD_LABEL, EXIT_TIMEOUT_S, LEGACY_SCHEDULER_LABEL, engineJob, engineJobPid, ensureEngineLaunchAgent,
  launchdManagesEngine, plistAgentDir, removeEngineLaunchAgent, renderEngineLaunchAgent,
  reloadEngineJob,
} from '../src/launchd.mjs';
import { ensureProfileEngine, socketAlive } from '../src/discovery.mjs';
import { readDescriptor } from '../src/descriptor.mjs';
import { restartProfileEngine } from '../../scripts/restart-profile-engine.mjs';
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';

const fakeLaunchd = fileURLToPath(new URL('./fixtures/fake-launchd.mjs', import.meta.url));
const daemon = fileURLToPath(new URL('../../scheduler/src/daemon.mjs', import.meta.url));
const TEST_LABEL = 'com.keepitmello.rubato.test.engine-unit';
// Starters and restarts ask launchd only on macOS (launchd.mjs engineLaunchdApplies); elsewhere
// they start and stop the engine themselves, so these paths exist only there.
const MAC_ONLY = { skip: process.platform !== 'darwin' && 'launchd manages the engine only on macOS' };

const until = async (predicate, label, ms = 30_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await delay(50);
  }
};
const alive = (pid) => {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
};
const engineProcesses = (agentDir) => spawnSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
  .filter((line) => line.includes('cli.mjs') && line.includes(`--agent-dir ${agentDir}`)).map((line) => Number(line.trim().split(/\s+/)[0]));

/** A temp HOME with a launchd stand-in; every launchd label it sees is the sandbox's own. */
async function sandbox(t) {
  const home = await mkdtemp('/tmp/rbld-');
  const launchd = path.join(home, 'launchd');
  const launchctl = path.join(home, 'launchctl');
  writeFileSync(launchctl, `#!/bin/sh\nFAKE_LAUNCHD_DIR="${launchd}" exec "${process.execPath}" "${fakeLaunchd}" "$@"\n`, { mode: 0o755 });
  const env = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', RUBATO_LAUNCHCTL_BIN: launchctl, RUBATO_NODE: process.execPath,
    RUBATO_STOCK_ENGINE_DIR: path.join(home, 'no-engine'), RUBATO_ENGINE_LAUNCHD_LABEL: TEST_LABEL,
    RUBATO_LAUNCH_AGENTS_DIR: path.join(home, 'LaunchAgents') };
  const agentDir = path.join(home, '.rubato-pi', 'agent');
  t.after(async () => {
    await removeEngineLaunchAgent({ env }).catch(() => {});
    for (const pid of engineProcesses(agentDir)) try { process.kill(pid, 'SIGKILL'); } catch {}
    await rm(home, { recursive: true, force: true });
  });
  const calls = () => { try { return readFileSync(path.join(launchd, 'calls'), 'utf8').trim().split('\n'); } catch { return []; } };
  const starts = () => { try { return readFileSync(path.join(launchd, 'starts'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  return { home, env, agentDir, descriptorPath: path.join(agentDir, 'server', 'connection.json'), calls, starts };
}

test('the engine job starts the profile engine at load, keeps it alive and waits out a draining engine', () => {
  const plist = renderEngineLaunchAgent({ nodePath: '/n/node', agentDir: '/h/.rubato-pi/agent', home: '/h', pathEnv: '/n:/usr/bin',
    logPath: '/h/.rubato-pi/agent/logs/pi-server.log', env: { RUBATO_SCHEDULE_HOME: '/s&t' } });
  assert.match(plist, new RegExp(`<key>Label</key><string>${ENGINE_LAUNCHD_LABEL}</string>`));
  assert.match(plist, new RegExp(`<string>/n/node</string><string>${ENGINE_CLI}</string><string>--agent-dir</string><string>/h/.rubato-pi/agent</string><string>--launchd</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key><true\/><key>KeepAlive<\/key><true\/>/);
  // A restart drains running tool calls for up to two minutes; launchd must not SIGKILL it first.
  assert.match(plist, new RegExp(`<key>ExitTimeOut</key><integer>${EXIT_TIMEOUT_S}</integer>`));
  assert.ok(EXIT_TIMEOUT_S >= 120 + 20);
  // Processes a conversation started (a dev server) outlive an engine restart, as before.
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(plist, /<key>NODE_OPTIONS<\/key><string>--experimental-strip-types<\/string>/);
  assert.match(plist, /<key>RUBATO_SCHEDULE_HOME<\/key><string>\/s&amp;t<\/string>/);
  assert.equal(plistAgentDir(plist), '/h/.rubato-pi/agent');
  assert.doesNotMatch(plist, /--runtime-root/, 'the engine reads the installed build at each start');
  assert.match(renderEngineLaunchAgent({ nodePath: '/n', agentDir: '/a', home: '/h', pathEnv: '/n', logPath: '/l', runtimeRoot: '/c' }),
    /<string>--launchd<\/string><string>--runtime-root<\/string><string>\/c<\/string>/);
  // The restart helpers find the engine by `cli.mjs --agent-dir <dir>` on its command line.
  assert.ok(plist.indexOf('cli.mjs') < plist.indexOf('--agent-dir'));
});

test('only test labels may replace the real one, and a test label never reaches the real scheduler job', () => {
  assert.throws(() => engineJob({ HOME: '/h', RUBATO_ENGINE_LAUNCHD_LABEL: 'com.keepitmello.rubato.engine2' }), /must start with/);
  const job = engineJob({ HOME: '/h', RUBATO_ENGINE_LAUNCHD_LABEL: TEST_LABEL }, { uid: 501 });
  assert.equal(job.target, `gui/501/${TEST_LABEL}`);
  assert.equal(job.legacySchedulerLabel, 'com.keepitmello.rubato.test.scheduler');
  assert.equal(engineJob({ HOME: '/h' }, { uid: 501 }).legacySchedulerLabel, LEGACY_SCHEDULER_LABEL);
  assert.equal(engineJob({ HOME: '/h' }).plistPath, `/h/Library/LaunchAgents/${ENGINE_LAUNCHD_LABEL}.plist`);
});

test('reload accepts a concurrent bootstrap but never hides a failed load or unload', async t => {
  const home = await mkdtemp('/tmp/rbld-race-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const launchctl = path.join(home, 'launchctl');
  writeFileSync(launchctl, `#!/bin/sh
case "$1" in
  bootout) [ "$MODE" != unload-failed ] ;;
  bootstrap) exit 5 ;;
  print) [ "$MODE" != load-failed ] ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  const env = { HOME: home, RUBATO_LAUNCHCTL_BIN: launchctl, RUBATO_ENGINE_LAUNCHD_LABEL: TEST_LABEL };
  await reloadEngineJob({ env: { ...env, MODE: 'raced' } });
  await assert.rejects(reloadEngineJob({ env: { ...env, MODE: 'load-failed' } }), /bootstrap/);
  await assert.rejects(reloadEngineJob({ env: { ...env, MODE: 'unload-failed' } }), /bootout/);
});

test('profile registration survives launchd handoff without carrying private companion credentials', async t => {
  const box = await sandbox(t);
  const registry = path.join(box.home, 'local-companions.json');
  writeFileSync(registry, JSON.stringify({ companions: [] }));
  const env = { ...box.env, RUBATO_COMPANIONS_FILE: registry,
    RUBATO_DEFAULT_COMPANION_HOME: path.join(box.home, 'default-home'), ROO_PRIVATE_SECRET: 'MUST_NOT_CARRY' };
  await ensureEngineLaunchAgent({ env, agentDir: box.agentDir });
  const plist = readFileSync(engineJob(env).plistPath, 'utf8');
  assert.ok(plist.includes(`<key>RUBATO_COMPANIONS_FILE</key><string>${registry}</string>`));
  assert.ok(plist.includes(`<key>RUBATO_DEFAULT_COMPANION_HOME</key><string>${env.RUBATO_DEFAULT_COMPANION_HOME}</string>`));
  assert.doesNotMatch(plist, /ROO_PRIVATE_SECRET|MUST_NOT_CARRY/);
});

test('registering moves an older install over: the engine job is loaded and the scheduler job removed; again, nothing changes', async (t) => {
  const box = await sandbox(t);
  const job = engineJob(box.env);
  // An older install: the scheduler's own job, loaded.
  mkdirSync(job.agentsDir, { recursive: true });
  writeFileSync(job.legacySchedulerPlist, `<?xml version="1.0"?><plist><dict><key>Label</key><string>${job.legacySchedulerLabel}</string>`
    + `<key>ProgramArguments</key><array><string>/bin/sleep</string><string>600</string></array><key>EnvironmentVariables</key><dict></dict>`
    + `<key>StandardOutPath</key><string>${path.join(box.home, 'legacy.log')}</string></dict></plist>`);
  spawnSync(box.env.RUBATO_LAUNCHCTL_BIN, ['bootstrap', job.domain, job.legacySchedulerPlist]);
  const first = await ensureEngineLaunchAgent({ env: box.env, agentDir: box.agentDir });
  assert.deepEqual([first.changed, first.bootstrapped, first.stale, first.removedLegacy], [true, true, false, true]);
  assert.equal(existsSync(job.legacySchedulerPlist), false);
  assert.ok(box.calls().includes(`bootout ${job.domain}/${job.legacySchedulerLabel}`));
  assert.equal(launchdManagesEngine({ agentDir: box.agentDir, env: box.env, platform: 'darwin' }), true);
  assert.equal(launchdManagesEngine({ agentDir: path.join(box.home, 'other'), env: box.env, platform: 'darwin' }), false);
  assert.equal(launchdManagesEngine({ agentDir: box.agentDir, env: box.env, platform: 'linux' }), false);
  const descriptor = await until(async () => { try { const d = await readDescriptor(box.descriptorPath); return await socketAlive(d.socketPath) && d; } catch { return false; } }, 'engine up');
  const again = await ensureEngineLaunchAgent({ env: box.env, agentDir: box.agentDir });
  assert.deepEqual([again.changed, again.bootstrapped, again.stale, again.removedLegacy], [false, false, false, false]);
  // A different Node is a different definition: kept running, reported stale for the next restart.
  const moved = await ensureEngineLaunchAgent({ env: box.env, agentDir: box.agentDir, nodePath: '/usr/bin/true' });
  assert.deepEqual([moved.changed, moved.stale], [true, true]);
  assert.equal(await socketAlive(descriptor.socketPath), true, 'the running engine was left alone');
  assert.equal(box.starts().filter((line) => line.startsWith(TEST_LABEL)).length, 1);
});

test('with launchd keeping the engine: killed, it comes back; starters ask launchd and never start a second engine; a restart drains and launchd starts the next one; the scheduler runs inside it', MAC_ONLY, async (t) => {
  const box = await sandbox(t);
  await ensureEngineLaunchAgent({ env: box.env, agentDir: box.agentDir });
  const options = { descriptorPath: box.descriptorPath, env: box.env, runtimeRoot: null, timeoutMs: 40_000 };
  const first = await ensureProfileEngine(options);
  const [firstPid] = engineProcesses(box.agentDir);
  assert.equal(await engineJobPid({ env: box.env }), firstPid, 'the engine is the one launchd runs');
  // The scheduler runs inside it.
  const store = createScheduleStore({ env: box.env });
  await until(() => store.schedulerStatus().running, 'scheduler beats');
  assert.equal(store.schedulerStatus().pid, firstPid);

  // Killed: launchd starts it again, and the new one takes over the lock nobody holds now instead
  // of waiting 15 s for it to go stale.
  const killedAt = Date.now();
  process.kill(firstPid, 'SIGKILL');
  await until(() => !alive(firstPid), 'killed');
  const second = await ensureProfileEngine(options);
  assert.ok(Date.now() - killedAt < 8000, `back in ${Date.now() - killedAt} ms`);
  assert.match(readFileSync(path.join(box.agentDir, 'logs', 'pi-server.log'), 'utf8'), /the engine that held this profile is gone; taking over its lock/);
  assert.equal(second.serverId, first.serverId);
  const afterKill = engineProcesses(box.agentDir);
  assert.equal(afterKill.length, 1, `one engine: ${afterKill}`);
  assert.notEqual(afterKill[0], firstPid);
  assert.equal(box.calls().filter((line) => line.startsWith('bootstrap') && line.includes(TEST_LABEL)).length, 1,
    'the starter asked launchd (kickstart); it did not load or spawn anything');

  // A restart: SIGTERM, the engine drains and exits, and launchd starts the next one.
  const result = await restartProfileEngine({ descriptorPath: box.descriptorPath, waitMs: 30_000, startEngine: (target) => ensureProfileEngine({ ...options, descriptorPath: target }) });
  assert.equal(result.restarted, true, JSON.stringify(result));
  assert.equal(result.pid, afterKill[0]);
  const third = await ensureProfileEngine(options);
  assert.equal(third.serverId, first.serverId);
  const afterRestart = await until(() => { const pids = engineProcesses(box.agentDir); return pids.length === 1 && pids[0] !== afterKill[0] && pids; }, 'next engine');
  assert.equal(await engineJobPid({ env: box.env }), afterRestart[0]);
  await until(() => store.schedulerStatus().running && store.schedulerStatus().pid === afterRestart[0], 'scheduler beats in the next engine');
});

test('an engine the app started before the job existed keeps the profile; the job waits and takes over when it ends', MAC_ONLY, async (t) => {
  const box = await sandbox(t);
  // The app's engine: started on demand, before any job.
  const off = { launchd: { manages: () => false, kickstart: async () => false } };
  const before = await ensureProfileEngine({ descriptorPath: box.descriptorPath, env: box.env, runtimeRoot: null, timeoutMs: 20_000, ...off });
  const [appEngine] = engineProcesses(box.agentDir);
  await ensureEngineLaunchAgent({ env: box.env, agentDir: box.agentDir });
  // The job's engine waits for the lock instead of exiting (no restart loop).
  const standby = await until(() => engineJobPid({ env: box.env }), 'job started');
  await delay(1500);
  assert.equal(alive(standby), true, 'the job\'s engine is still waiting');
  assert.equal(box.starts().length, 1, 'launchd did not have to start it again');
  assert.match(readFileSync(path.join(box.agentDir, 'logs', 'pi-server.log'), 'utf8'), /another engine holds this profile; waiting to take over/);
  assert.equal((await readDescriptor(box.descriptorPath)).serverId, before.serverId);
  // The update's restart ends the app's engine; the job's engine takes the profile.
  const result = await restartProfileEngine({ descriptorPath: box.descriptorPath, waitMs: 60_000 });
  assert.equal(result.restarted, true, JSON.stringify(result));
  assert.equal(result.pid, appEngine);
  const after = await ensureProfileEngine({ descriptorPath: box.descriptorPath, env: box.env, runtimeRoot: null, timeoutMs: 40_000 });
  assert.equal(after.serverId, before.serverId);
  assert.deepEqual(engineProcesses(box.agentDir), [standby]);
});

test('a restart reloads a job whose definition changed, through launchd rather than a second signal', MAC_ONLY, async (t) => {
  const box = await sandbox(t);
  await ensureEngineLaunchAgent({ env: box.env, agentDir: box.agentDir });
  await ensureProfileEngine({ descriptorPath: box.descriptorPath, env: box.env, runtimeRoot: null, timeoutMs: 40_000 });
  const [running] = engineProcesses(box.agentDir);
  const stale = await ensureEngineLaunchAgent({ env: box.env, agentDir: box.agentDir, nodePath: process.execPath,
    cliPath: ENGINE_CLI.replace(/cli\.mjs$/, './cli.mjs') });
  assert.equal(stale.stale, true);
  const { reloadEngineJob } = await import('../src/launchd.mjs');
  let reloads = 0;
  const result = await restartProfileEngine({ descriptorPath: box.descriptorPath, waitMs: 30_000, launchdJob: stale,
    startEngine: (descriptorPath) => ensureProfileEngine({ descriptorPath, env: box.env, runtimeRoot: null, timeoutMs: 40_000 }),
    reload: async () => { reloads++; await reloadEngineJob({ env: box.env }); }, jobPid: () => engineJobPid({ env: box.env }) });
  assert.deepEqual([result.restarted, result.reloaded, result.pid, reloads], [true, true, running, 1]);
  const next = await until(() => { const pids = engineProcesses(box.agentDir); return pids.length === 1 && pids[0] !== running && pids[0]; }, 'reloaded engine');
  assert.ok(spawnSync('ps', ['-o', 'command=', '-p', String(next)], { encoding: 'utf8' }).stdout.includes('/./cli.mjs'), 'the new definition runs');
});

test('the old scheduler job, started by launchd after an update, moves the machine over and removes itself', async (t) => {
  const box = await sandbox(t);
  const job = engineJob(box.env);
  mkdirSync(job.agentsDir, { recursive: true });
  writeFileSync(job.legacySchedulerPlist, '<plist/>');
  const child = spawn(process.execPath, [daemon], { env: { ...box.env, XPC_SERVICE_NAME: job.legacySchedulerLabel }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, output);
  assert.match(output, /moved into the engine/);
  assert.equal(existsSync(job.legacySchedulerPlist), false);
  assert.equal(existsSync(job.plistPath), true);
  assert.ok(box.calls().some((line) => line.startsWith(`bootstrap ${job.domain} ${job.plistPath}`)));
  await ensureProfileEngine({ descriptorPath: box.descriptorPath, env: box.env, runtimeRoot: null, timeoutMs: 40_000 });
});
