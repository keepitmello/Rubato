import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { chmodSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runUpdate, stateDirectory, readJson, alive } from '../gui-update.mjs';
import { createRubatoUpdater, attachRubatoUpdates } from '../overlay/apps/desktop/src/updates/RubatoUpdates.ts';

const workerModule = fileURLToPath(new URL('../gui-update.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rubato-gui-update-'));
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  const directory = stateDirectory(env);
  await mkdir(directory, { recursive: true });
  t.after(async () => {
    const pid = Number(await readFile(path.join(root, 'app.pid'), 'utf8').catch(() => ''));
    if (alive(pid)) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  const script = path.join(root, 'update.mjs');
  await writeFile(script, `
    import {spawn} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    const app=spawn(process.execPath,['-e',${JSON.stringify(`
      const fs=require('node:fs'),path=require('node:path');
      const token=process.env.RUBATO_GUI_UPDATE_TOKEN;
      const dir=path.join(process.env.HOME,'.rubato-pi','gui-update');
      fs.writeFileSync(path.join(dir,'ready-'+token+'.json'),JSON.stringify({token,pid:process.pid}));
      setInterval(()=>{},1000);
    `)}],{detached:true,stdio:'ignore',env:process.env});
    writeFileSync(${JSON.stringify(path.join(root, 'app.pid'))},String(app.pid));
    app.unref();
  `);
  return { root, env, directory, script, options: {
    root, env, token: randomUUID(), parentPid: process.pid,
    command: process.execPath, args: [script], notify: async () => {},
    readyTimeoutMs: 3000, updateTimeoutMs: 5000,
  } };
}

function waitForJson(file, predicate, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    let watcher;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); watcher?.close();
      if (error) reject(error); else resolve(value);
    };
    const check = () => { void readJson(file).then((value) => {
      if (predicate(value)) finish(null, value);
    }, (error) => finish(error)); };
    const timer = setTimeout(() => finish(new Error(`Timed out: ${file}`)), timeout);
    watcher = watch(path.dirname(file), check);
    check();
  });
}

test('successful job waits for a different live app and removes lock/readiness files', async (t) => {
  const h = await fixture(t);
  const result = await runUpdate(h.options);
  assert.equal(result.status, 'succeeded');
  assert.ok(alive(result.appPid));
  assert.equal(await readJson(path.join(h.directory, 'lock.json')), null);
  assert.equal(await readJson(path.join(h.directory, `ready-${h.options.token}.json`)), null);
  assert.deepEqual(await readJson(path.join(h.directory, 'result.json')), result);
});

test('failure preserves a result, releases its lock, and permits retry', async (t) => {
  const h = await fixture(t);
  const messages = [];
  const result = await runUpdate({ ...h.options, args: ['-e', 'process.exit(7)'],
    notify: async (message) => messages.push(message) });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /7/);
  assert.equal(messages.length, 1);
  assert.equal(await readJson(path.join(h.directory, 'lock.json')), null);
  assert.equal((await runUpdate({ ...h.options, token: randomUUID() })).status, 'succeeded');
});

test('another live worker is not overwritten or launched twice', async (t) => {
  const h = await fixture(t);
  const owner = { pid: process.pid, token: randomUUID() };
  await writeFile(path.join(h.directory, 'lock.json'), JSON.stringify(owner));
  assert.deepEqual(await runUpdate(h.options), { duplicate: true });
  assert.deepEqual(await readJson(path.join(h.directory, 'lock.json')), owner);
  assert.equal(await readJson(path.join(h.directory, 'result.json')), null);
});

test('a dead worker lock can be recovered', async (t) => {
  const h = await fixture(t);
  await writeFile(path.join(h.directory, 'lock.json'), JSON.stringify({ pid: 99999999, token: randomUUID() }));
  assert.equal((await runUpdate(h.options)).status, 'succeeded');
  assert.equal(await readJson(path.join(h.directory, 'recover.lock')), null);
});

test('exit zero without a new loaded window is a failure, not update success', async (t) => {
  const h = await fixture(t);
  const result = await runUpdate({ ...h.options, args: ['-e', ''], readyTimeoutMs: 50 });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /앱이 다시 열렸는지/);
  assert.equal(await readJson(path.join(h.directory, 'lock.json')), null);
});

test('a stale acknowledgement from the old app cannot certify restart', async (t) => {
  const h = await fixture(t);
  await writeFile(path.join(h.directory, `ready-${h.options.token}.json`),
    JSON.stringify({ token: h.options.token, pid: process.pid }));
  const result = await runUpdate({ ...h.options, args: ['-e', ''], readyTimeoutMs: 50 });
  assert.equal(result.status, 'failed');
});

test('a timed-out updater is terminated and releases its lock', async (t) => {
  const h = await fixture(t);
  const pidFile = path.join(h.root, 'updater.pid');
  const result = await runUpdate({ ...h.options, updateTimeoutMs: 200,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`] });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /제한 시간/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.equal(alive(pid), false);
  assert.equal(await readJson(path.join(h.directory, 'lock.json')), null);
});

test('a relaunched app survives the updater killing its own process group', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rubato-detach-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = path.join(root, 'start.sh');
  const pidFile = path.join(root, 'app.pid');
  const plainPidFile = path.join(root, 'plain.pid');
  const detach = fileURLToPath(new URL('../detach-gui.mjs', import.meta.url));
  await writeFile(start, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e `
    + `'require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)'\n`);
  chmodSync(start, 0o755);
  // The worker owns a group with a plain child (the control) and hands the app
  // off through detach-gui.mjs, exactly as restart-gui.sh does.
  const worker = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process'),fs=require('node:fs');
    const plain=spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(plainPidFile)},String(plain.pid));
    spawn(process.execPath,[${JSON.stringify(detach)},${JSON.stringify(start)},${JSON.stringify(path.join(root, 'app.log'))}],{stdio:'ignore'});
    setInterval(()=>{},1000);
  `], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-worker.pid, 'SIGKILL'); } catch {} });
  const appPid = Number(await waitForJson(pidFile, (value) => value));
  const plainPid = Number(await waitForJson(plainPidFile, (value) => value));
  t.after(() => { if (alive(appPid)) { try { process.kill(appPid, 'SIGKILL'); } catch {} } });
  // The timeout path kills the updater's whole group. A child in that group dies
  // with it, so the relaunched app must have left the group.
  process.kill(-worker.pid, 'SIGKILL');
  await delay(300);
  assert.equal(alive(plainPid), false, 'control: a plain child of the updater dies with the group');
  assert.equal(alive(appPid), true, 'relaunched app must outlive the updater group');
});

test('real detached worker survives its parent process-group exit, relaunches and exits', async (t) => {
  const h = await fixture(t);
  const runner = path.join(h.root, 'runner.mjs');
  await writeFile(runner, `
    import {runUpdate} from ${JSON.stringify(pathToFileURL(workerModule).href)};
    const options=${JSON.stringify(h.options)};
    options.notify=async()=>{};
    const result=await runUpdate(options);
    process.exitCode=result.status==='succeeded'?0:1;
  `);
  const parent = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const fs=require('node:fs');
    const child=spawn(process.execPath,[${JSON.stringify(runner)}],{detached:true,stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(path.join(h.root, 'worker.json'))},JSON.stringify({pid:child.pid}));
    child.unref(); setInterval(()=>{},1000);
  `], { detached: true, stdio: 'ignore', env: h.env });
  t.after(() => { try { process.kill(-parent.pid, 'SIGTERM'); } catch {} });
  const worker = await waitForJson(path.join(h.root, 'worker.json'), (value) => value?.pid);
  t.after(() => { if (alive(worker.pid)) { try { process.kill(-worker.pid, 'SIGTERM'); } catch {} } });
  // Stop the parent group, not the worker's group.
  process.kill(-parent.pid, 'SIGTERM');
  await new Promise((resolve) => parent.once('exit', resolve));
  const result = await waitForJson(path.join(h.directory, 'result.json'), (value) => value?.status === 'succeeded');
  assert.ok(alive(result.appPid));
  await waitForJson(path.join(h.directory, 'lock.json'), (value) => value === null);
  assert.equal(await readJson(path.join(h.directory, 'lock.json')), null);
  const deadline = Date.now() + 3000;
  while (alive(worker.pid) && Date.now() < deadline) await delay(20);
  assert.equal(alive(worker.pid), false, 'one-shot worker must actually exit');
  assert.notEqual(worker.pid, result.appPid);
});

function uiHarness(t, h, responses = [1], overrides = {}) {
  const window = new EventEmitter();
  const bars = [];
  const dialogs = [];
  const launched = [];
  const notices = [];
  window.isDestroyed = () => false;
  window.setProgressBar = (value) => bars.push(value);
  const electron = {
    dialog: { showMessageBox: async (...args) => {
      dialogs.push(args.at(-1)); return { response: responses.shift() ?? 1 };
    } },
    shell: { openPath: async () => '' },
  };
  const options = {
    stateDir: h.directory, helper: '/unused', now: () => 1000,
    check: async () => ({ available: true, revision: 'revision-1', commits: 2 }),
    launch: async (token) => { launched.push(token); }, watchMs: 10_000,
    notify: async (notice) => { notices.push(notice); },
    ...overrides,
  };
  const controller = createRubatoUpdater(window, { ...options, message: electron.dialog.showMessageBox });
  t.after(() => controller.stop());
  return { controller, dialogs, launched, bars, notices };
}

test('in-app prompt: later never launches; repeated checks do not nag', async (t) => {
  const h = await fixture(t);
  const ui = uiHarness(t, h);
  await ui.controller.tick();
  await ui.controller.tick();
  assert.equal(ui.dialogs.length, 1);
  assert.deepEqual(ui.dialogs[0].buttons, ['업데이트', '나중에']);
  assert.deepEqual(ui.launched, []);
  assert.equal((await readJson(path.join(h.directory, 'later.json'))).revision, 'revision-1');
});

test('in-app prompt: update starts one job and shows progress without another window', async (t) => {
  const h = await fixture(t);
  const ui = uiHarness(t, h, [0]);
  await Promise.all([ui.controller.tick(), ui.controller.tick()]);
  assert.equal(ui.launched.length, 1);
  assert.equal(ui.dialogs.length, 1);
  assert.ok(ui.bars.includes(2));
});

test('update IPC rejects preview windows, child frames and foreign origins', { skip: process.platform !== 'darwin' }, async (t) => {
  const h = await fixture(t);
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = h.root;
  process.env.USERPROFILE = h.root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  });
  const handlers = new Map();
  const window = new EventEmitter();
  const mainFrame = { url: 'http://127.0.0.1:3773/' };
  window.webContents = { id: 7727, mainFrame, send() {}, isLoadingMainFrame: () => false };
  window.isDestroyed = () => false;
  window.isVisible = () => true;
  const electron = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
  attachRubatoUpdates(window, electron, path.join(h.root, 'missing-settings.json'), mainFrame.url);
  t.after(() => window.emit('closed'));
  const invoke = handlers.get('rubato:update:action');
  assert.ok(invoke);
  await handlers.get('rubato:update:get')({ sender: window.webContents, senderFrame: mainFrame });
  await assert.rejects(invoke({ sender: { id: 111 }, senderFrame: mainFrame }, {}), /Untrusted/);
  await assert.rejects(invoke({ sender: window.webContents, senderFrame: { url: mainFrame.url } }, {}), /Untrusted/);
  mainFrame.url = 'https://example.com/';
  await assert.rejects(invoke({ sender: window.webContents, senderFrame: mainFrame }, {}), /origin/);
  mainFrame.url = 'http://127.0.0.1:3773/';
  await assert.rejects(invoke({ sender: window.webContents, senderFrame: mainFrame }, { id: 'fake', action: 'update' }), /Expired/);
});

test('a failed job is visible once after reopening, with access to its log', async (t) => {
  const h = await fixture(t);
  const token = randomUUID();
  await writeFile(path.join(h.directory, 'result.json'), JSON.stringify({ token, status: 'failed', message: 'test failure' }));
  const ui = uiHarness(t, h);
  await ui.controller.tick();
  await ui.controller.tick();
  assert.equal(ui.dialogs.filter((dialog) => dialog.type === 'error').length, 1);
  assert.equal(ui.dialogs[0].detail, 'test failure');
  assert.equal((await readJson(path.join(h.directory, 'seen.json'))).token, token);
});

test('in-app prompt: closing without a choice does not snooze; the next launch asks again', async (t) => {
  const h = await fixture(t);
  const first = uiHarness(t, h, [-1]);
  await first.controller.tick();
  assert.equal(first.dialogs.length, 1);
  assert.equal(await readJson(path.join(h.directory, 'later.json')), null);
  first.controller.stop();
  const relaunched = uiHarness(t, h, [1]);
  await relaunched.controller.tick();
  assert.equal(relaunched.dialogs.length, 1);
});

test('menu check: skips the snooze and interval, and answers up-to-date and failures', async (t) => {
  const h = await fixture(t);
  const snoozed = uiHarness(t, h, [1, 1]);
  await snoozed.controller.tick();
  await snoozed.controller.tick();
  assert.equal(snoozed.dialogs.length, 1);
  await snoozed.controller.tick(true);
  assert.equal(snoozed.dialogs.length, 2);

  const current = uiHarness(t, h, [], { check: async () => ({ available: false }) });
  await current.controller.tick();
  assert.deepEqual(current.notices, []);
  await current.controller.tick(true);
  assert.equal(current.notices.length, 1);
  assert.equal(current.notices[0].type, 'info');

  const broken = uiHarness(t, h, [], { check: async () => { throw new Error('현재 브랜치는 dev 입니다.'); } });
  await broken.controller.tick();
  assert.deepEqual(broken.notices, []);
  await broken.controller.tick(true);
  assert.equal(broken.notices[0].type, 'error');
  assert.match(broken.notices[0].detail, /브랜치/);
});

test('menu check: a click during the startup check is carried, not dropped', async (t) => {
  const h = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let checks = 0;
  const ui = uiHarness(t, h, [], { check: async () => { checks++; await gate; return { available: false }; } });
  const startup = ui.controller.tick();
  await delay(0);
  await ui.controller.tick(true);
  release();
  await startup;
  assert.equal(checks, 1);
  assert.equal(ui.notices.length, 1);
});

test('menu check: a prompt already on screen answers it; closing it does not re-open it', async (t) => {
  const h = await fixture(t);
  let answer;
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  window.setProgressBar = () => {};
  const dialogs = [];
  const controller = createRubatoUpdater(window, {
    stateDir: h.directory, helper: '/unused', now: () => 1000,
    check: async () => ({ available: true, revision: 'revision-1', commits: 1 }),
    message: (prompt) => { dialogs.push(prompt); return new Promise((resolve) => { answer = resolve; }); },
  });
  t.after(() => controller.stop());
  const shown = controller.tick();
  await delay(0);
  await controller.tick(true);
  answer({ response: -1 });
  await shown;
  await delay(0);
  assert.equal(dialogs.length, 1);
});
