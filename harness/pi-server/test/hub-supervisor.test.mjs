import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultPaths } from '../../../scripts/remote-release/constants.mjs';
import { parseHubServiceSpec, startHubSupervisor, writeHubServiceSpec } from '../src/hub-supervisor.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A stand-in hub: records each start, follows its mode file, and leaves when its parent goes,
// as the real hub does (packages/rubato-remote-hub/src/main.ts).
const FAKE_HUB = `
import { appendFileSync, readFileSync } from 'node:fs';
const [log, modeFile] = process.argv.slice(2);
const mode = (() => { try { return readFileSync(modeFile, 'utf8').trim(); } catch { return 'stay'; } })();
appendFileSync(log, JSON.stringify({ pid: process.pid, at: Date.now(), mode,
  env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, RUBATO_BUILD_ID: process.env.RUBATO_BUILD_ID, PATH: process.env.PATH, USER: process.env.USER },
  ipc: typeof process.send === 'function' }) + '\\n');
if (mode === 'crash') process.exit(3);
if (mode === 'stubborn') process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => process.exit(0));
if (process.send) process.once('disconnect', () => process.exit(0));
setInterval(() => {}, 1000);
`;

async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-supervisor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const paths = defaultPaths(home, process.getuid());
  const hub = path.join(root, 'fake-hub.mjs');
  await writeFile(hub, FAKE_HUB);
  const log = path.join(root, 'starts.log');
  const modeFile = path.join(root, 'mode');
  const starts = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const spec = (extra = {}) => ({ schemaVersion: 1, command: process.execPath, args: [hub, log, modeFile],
    env: { HOME: home, TMPDIR: path.join(root, 'tmp'), RUBATO_BUILD_ID: 'build-1' },
    stdout: path.join(paths.logs, 'hub.stdout.log'), stderr: path.join(paths.logs, 'hub.stderr.log'), requestedAt: 'first', ...extra });
  return { root, home, paths, hub, log, modeFile, starts, spec, setMode: (mode) => writeFile(modeFile, mode) };
}

function supervise(t, box, options = {}) {
  const errors = [];
  const events = [];
  const supervisor = startHubSupervisor({ paths: box.paths, onError: (error) => errors.push(error), log: (event, details) => events.push({ event, ...details }),
    accountHome: false, pollMs: 50, minBackoffMs: 40, maxBackoffMs: 400, stableMs: 1_000, stopTimeoutMs: 500, ...options });
  t.after(() => supervisor.close());
  return { supervisor, errors, events };
}

test('runs the spec the release channel wrote, with the launchd environment and an IPC lifeline', async (t) => {
  const box = await sandbox(t);
  await writeHubServiceSpec(box.paths.service, box.spec());
  const { supervisor } = supervise(t, box);
  await supervisor.ready;
  const [first] = await until(async () => (await box.starts())[0] && box.starts());
  assert.equal(first.env.HOME, box.home);
  assert.equal(first.env.RUBATO_BUILD_ID, 'build-1');
  assert.equal(first.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.ok(first.env.USER);
  assert.equal(first.ipc, true);
  const record = JSON.parse(await readFile(box.paths.servicePid, 'utf8'));
  assert.equal(record.pid, first.pid);
  assert.equal(record.enginePid, process.pid);
  assert.equal(record.requestedAt, 'first');
  assert.equal((await stat(box.paths.servicePid)).mode & 0o077, 0);
});

test('a hub that keeps exiting comes back with growing delays, and a stable run resets them', async (t) => {
  const box = await sandbox(t);
  await box.setMode('crash');
  await writeHubServiceSpec(box.paths.service, box.spec());
  const { supervisor, events } = supervise(t, box);
  await supervisor.ready;
  await until(async () => (await box.starts()).length >= 5, 8_000);
  const delays = events.filter((item) => item.event === 'hub.exited').map((item) => item.restartInMs);
  assert.deepEqual(delays.slice(0, 4), [40, 80, 160, 320]);
  assert.equal(delays.slice(4).every((delay) => delay === 400), true);
  // It stays up long enough to count as stable; the next exit starts over at the shortest delay.
  await box.setMode('stay');
  const steady = await until(async () => (await box.starts()).find((item) => item.mode === 'stay'), 5_000);
  await sleep(1_100);
  await box.setMode('crash');
  // Count from here: crash exits before the steady run (under load there can be more) do not count.
  const exitsBefore = events.filter((item) => item.event === 'hub.exited').length;
  process.kill(steady.pid, 'SIGTERM');
  await until(() => events.filter((item) => item.event === 'hub.exited').length > exitsBefore);
  assert.equal(events.filter((item) => item.event === 'hub.exited')[exitsBefore].restartInMs, 40);
});

test('a hub that cannot start is reported and retried; the supervisor itself never throws', async (t) => {
  const box = await sandbox(t);
  await writeHubServiceSpec(box.paths.service, box.spec({ command: path.join(box.root, 'missing-node') }));
  const { supervisor, errors, events } = supervise(t, box);
  await supervisor.ready;
  await until(() => events.filter((item) => item.event === 'hub.exited').length >= 2);
  assert.ok(errors.some((error) => error.code === 'ENOENT'));
  // Fixing the spec brings the hub up without waiting out the backoff.
  await writeHubServiceSpec(box.paths.service, box.spec({ requestedAt: 'fixed' }));
  await until(async () => (await box.starts()).length === 1);
  await supervisor.close();
  assert.equal(supervisor.status().pid, null);
});

test('a new request in the spec restarts the hub; removing the spec stops it', async (t) => {
  const box = await sandbox(t);
  await writeHubServiceSpec(box.paths.service, box.spec());
  const { supervisor } = supervise(t, box);
  await supervisor.ready;
  const first = await until(async () => (await box.starts())[0]);
  await writeHubServiceSpec(box.paths.service, box.spec({ requestedAt: 'second', env: { ...box.spec().env, RUBATO_BUILD_ID: 'build-2' } }));
  const second = await until(async () => (await box.starts())[1]);
  assert.equal(alive(first.pid), false, 'the old hub is gone before the new one starts');
  assert.equal(second.env.RUBATO_BUILD_ID, 'build-2');
  assert.equal(JSON.parse(await readFile(box.paths.servicePid, 'utf8')).requestedAt, 'second');
  await rm(box.paths.service);
  await until(() => !alive(second.pid));
  await sleep(200);
  assert.equal((await box.starts()).length, 2);
});

test('stopping the engine stops the hub, with SIGKILL for one that ignores SIGTERM', async (t) => {
  const box = await sandbox(t);
  await box.setMode('stubborn');
  await writeHubServiceSpec(box.paths.service, box.spec());
  const { supervisor } = supervise(t, box);
  await supervisor.ready;
  const hub = await until(async () => (await box.starts())[0]);
  await supervisor.close();
  assert.equal(alive(hub.pid), false);
  await assert.rejects(stat(box.paths.servicePid), { code: 'ENOENT' });
  await sleep(200);
  assert.equal((await box.starts()).length, 1, 'nothing restarts after the engine stopped');
});

test('a killed engine takes its hub with it: the hub sees its IPC channel close', async (t) => {
  const box = await sandbox(t);
  await writeHubServiceSpec(box.paths.service, box.spec());
  const engine = spawn(process.execPath, ['--input-type=module', '-e', `
    import { startHubSupervisor } from ${JSON.stringify(new URL('../src/hub-supervisor.mjs', import.meta.url).href)};
    import { defaultPaths } from ${JSON.stringify(new URL('../../../scripts/remote-release/constants.mjs', import.meta.url).href)};
    startHubSupervisor({ paths: defaultPaths(${JSON.stringify(box.home)}, process.getuid()), accountHome: false, pollMs: 50 });
    setInterval(() => {}, 1000);`], { stdio: 'ignore' });
  t.after(() => { try { engine.kill('SIGKILL'); } catch {} });
  const hub = await until(async () => (await box.starts())[0]);
  engine.kill('SIGKILL');
  await until(() => !alive(hub.pid));
});

test('a hub left running by a killed engine is stopped before the next one starts; an unrelated pid is left alone', async (t) => {
  const box = await sandbox(t);
  await writeHubServiceSpec(box.paths.service, box.spec());
  // A hub from an older bundle that does not watch its parent: no IPC channel.
  const orphan = spawn(process.execPath, [box.hub, box.log, box.modeFile], { stdio: 'ignore', detached: true });
  orphan.unref();
  t.after(() => { try { process.kill(orphan.pid, 'SIGKILL'); } catch {} });
  await until(async () => (await box.starts())[0]);
  await mkdir(path.dirname(box.paths.servicePid), { recursive: true });
  await writeFile(box.paths.servicePid, JSON.stringify({ pid: orphan.pid, args: [box.hub] }));
  const { supervisor } = supervise(t, box);
  await supervisor.ready;
  assert.equal(alive(orphan.pid), false);
  const next = await until(async () => (await box.starts())[1]);
  assert.notEqual(next.pid, orphan.pid);
  await supervisor.close();

  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { bystander.kill('SIGKILL'); } catch {} });
  await writeFile(box.paths.servicePid, JSON.stringify({ pid: bystander.pid, args: [box.hub] }));
  const again = supervise(t, box);
  await again.supervisor.ready;
  assert.equal(alive(bystander.pid), true);
});

test('an install with the old hub LaunchAgent moves to the engine: same program, agent booted out, plist removed', async (t) => {
  const box = await sandbox(t);
  const label = 'com.keepitmello.rubato.test.remote-hub';
  const plist = path.join(path.dirname(box.paths.legacyPlist), `${label}.plist`);
  await mkdir(path.dirname(plist), { recursive: true });
  await writeFile(plist, 'plist');
  const agent = { Label: label, ProgramArguments: [process.execPath, box.hub, box.log, box.modeFile],
    EnvironmentVariables: { HOME: box.home, TMPDIR: path.join(box.root, 'tmp'), RUBATO_BUILD_ID: 'legacy-build' },
    StandardOutPath: path.join(box.paths.logs, 'hub.stdout.log'), StandardErrorPath: path.join(box.paths.logs, 'hub.stderr.log') };
  const launchctl = [];
  const { supervisor } = supervise(t, box, { label, readAgent: async () => agent, runLaunchctl: async (args) => { launchctl.push(args); return true; } });
  await supervisor.ready;
  const hub = await until(async () => (await box.starts())[0]);
  assert.equal(hub.env.RUBATO_BUILD_ID, 'legacy-build');
  assert.deepEqual(launchctl, [['bootout', `gui/${process.getuid()}/${label}`]]);
  await assert.rejects(stat(plist), { code: 'ENOENT' });
  const written = parseHubServiceSpec(await readFile(box.paths.service, 'utf8'));
  assert.deepEqual(written.args, [box.hub, box.log, box.modeFile]);
  assert.equal((await stat(box.paths.service)).mode & 0o077, 0);

  // An old release update registering the agent again: it is retired and the hub starts over.
  await writeFile(plist, 'plist');
  await until(() => launchctl.length === 2);
  await until(async () => (await box.starts()).length === 2);
  assert.equal(alive(hub.pid), false);
});

test("from another HOME the account's real hub LaunchAgent is never touched", async (t) => {
  const box = await sandbox(t);
  await mkdir(path.dirname(box.paths.legacyPlist), { recursive: true });
  await writeFile(box.paths.legacyPlist, 'plist');
  const launchctl = [];
  const { supervisor, events } = supervise(t, box, { readAgent: async () => { throw new Error('must not read'); }, runLaunchctl: async (args) => { launchctl.push(args); return true; } });
  await supervisor.ready;
  await sleep(150);
  assert.deepEqual(launchctl, []);
  assert.equal((await stat(box.paths.legacyPlist)).isFile(), true);
  assert.equal(events.filter((item) => item.event === 'hub.legacy-skipped').length, 1);
});

test('a spec other users can write is refused', async (t) => {
  const box = await sandbox(t);
  await writeHubServiceSpec(box.paths.service, box.spec());
  await chmod(box.paths.service, 0o666);
  const { supervisor, errors } = supervise(t, box);
  await supervisor.ready;
  await sleep(150);
  assert.equal((await box.starts()).length, 0);
  assert.equal(errors.length, 1, 'reported once, not on every poll');
  assert.match(errors[0].message, /writable by other users/);
});

test('the engine thread hands the hub to ctx.spawn, and a rejected spawn is retried', async (t) => {
  const box = await sandbox(t);
  await writeHubServiceSpec(box.paths.service, box.spec());
  const calls = [];
  let reject = true;
  const { startHubSupervisor: startSupervisor } = await import('../src/hub-supervisor.mjs');
  const events = [];
  const supervisor = startSupervisor({ paths: box.paths, accountHome: false, pollMs: 50, minBackoffMs: 40, onError: () => {},
    log: (event) => events.push(event),
    spawn: async (command, args, options) => {
      calls.push({ command, args, stdio: options.stdio });
      if (reject) { reject = false; throw Object.assign(new Error('spawn failed'), { code: 'EACCES' }); }
      return spawn(command, args, options);
    } });
  t.after(() => supervisor.close());
  await supervisor.ready;
  const hub = await until(async () => (await box.starts())[0]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].stdio[3], 'ipc');
  assert.equal(events.includes('hub.exited'), true);
  assert.equal(hub.ipc, true);
});

test('start(ctx) runs the hub through the engine main-thread spawn when the engine offers it', async (t) => {
  const box = await sandbox(t);
  await writeHubServiceSpec(box.paths.service, box.spec());
  const { start } = await import('../src/hub-supervisor.mjs');
  const previous = process.env.HOME;
  process.env.HOME = box.home;
  const spawned = [];
  let owned = 0;
  let service;
  try {
    service = await start({ onError: () => {}, log: () => {}, own: () => { owned += 1; },
      spawn: async (command, args, options) => { const child = spawn(command, args, options); spawned.push(child.pid); return child; } });
  } finally { process.env.HOME = previous; }
  t.after(() => service.close());
  const hub = await until(async () => (await box.starts())[0]);
  assert.deepEqual(spawned, [hub.pid]);
  assert.equal(owned, 0, 'a main-thread child needs no ctx.own');
  await service.close();
  assert.equal(alive(hub.pid), false);
});
