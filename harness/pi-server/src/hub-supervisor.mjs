// The remote hub runs as a child of the profile engine instead of its own LaunchAgent.
//
// The hub's release channel (scripts/remote-release) writes what to run into hub-service.json;
// this module runs it, starts it again with backoff when it exits, restarts it when the file
// changes (that is how install, update and `rubato-hub-restart.mjs` reach it) and stops it when
// the engine stops. The hub is a separate process, so its crash never reaches the engine; the
// engine runs this module in a resident-service thread (resident-services.mjs), so a fault here
// stays out of conversations too.
//
// An install from before this shape still has the hub's own LaunchAgent. The first supervisor
// that finds it takes the hub over: it keeps what the agent ran, boots the agent out and removes
// its plist, so an update needs no manual step.
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { defaultPaths, LEGACY_HUB_LABEL } from '../../../scripts/remote-release/constants.mjs';
import { HUB_SERVICE_SCHEMA, parseHubServiceSpec, readHubServiceSpec, writeHubServiceSpec } from '../../../scripts/remote-release/hub-service.mjs';

export { parseHubServiceSpec, readHubServiceSpec, writeHubServiceSpec };

const execFileAsync = promisify(execFile);
const TEST_LABEL_PREFIX = 'com.keepitmello.rubato.test.';
// launchd gives a LaunchAgent this PATH; the hub calls its tools by absolute path anyway.
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** The legacy label, or a test label a sandbox names; never another production label. */
export function legacyHubLabel(env = process.env) {
  const override = env.RUBATO_REMOTE_HUB_LEGACY_LABEL;
  return override && override.startsWith(TEST_LABEL_PREFIX) ? override : LEGACY_HUB_LABEL;
}

/** The hub's LaunchAgent as a supervisor spec: same program, environment and logs. */
export function specFromLaunchAgent(agent) {
  const [command, ...args] = Array.isArray(agent?.ProgramArguments) ? agent.ProgramArguments : [];
  return parseHubServiceSpec(JSON.stringify({ schemaVersion: HUB_SERVICE_SCHEMA, command, args,
    env: agent?.EnvironmentVariables ?? {}, stdout: agent?.StandardOutPath, stderr: agent?.StandardErrorPath,
    migratedFrom: agent?.Label ?? LEGACY_HUB_LABEL }));
}

async function plistAsJson(file) {
  const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 10_000 });
  return JSON.parse(stdout);
}

async function launchctl(args) {
  return execFileAsync('/bin/launchctl', args, { timeout: 10_000 }).then(() => true, () => false);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function commandLine(pid) {
  return execFileAsync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5_000 })
    .then(({ stdout }) => stdout.trim(), () => '');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The hub's socket for a spec: the hub puts it under its TMPDIR (packages/rubato-remote-hub config.ts). */
export function hubSocketFor(spec, uid = process.getuid?.() ?? 0) {
  return path.join(spec?.env?.TMPDIR || tmpdir(), `rubato-remote-${uid}`, 'hub.sock');
}

function socketAnswers(socketPath) {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

export function startHubSupervisor({
  paths = defaultPaths(),
  onError = console.error,
  log = () => {},
  spawn = nodeSpawn,
  label = legacyHubLabel(),
  // launchd is the account's, not HOME's: from another HOME (a test, a sandbox) only a test label
  // may be booted out, or the account's real hub would go down.
  accountHome = homedir() === userInfo().homedir,
  runLaunchctl = launchctl,
  readAgent = plistAsJson,
  isAlive = alive,
  socketBusy = socketAnswers,
  commandOf = commandLine,
  pollMs = 2_000,
  minBackoffMs = 250,
  maxBackoffMs = 30_000,
  stableMs = 30_000,
  stopTimeoutMs = 4_000,
  now = Date.now,
} = {}) {
  const legacyPlist = path.join(path.dirname(paths.legacyPlist), `${label}.plist`);
  let child = null;
  let childExit = null;
  let specText = null;
  let startedAt = 0;
  let failures = 0;
  let restarts = 0;
  let lastExit = null;
  let retry = null;
  let poll = null;
  let stopped = false;
  let reportedSpecError = null;
  let legacySkipped = false;
  let reportedLegacyError = null;
  // One step at a time: a spec change, an exit and a stop must not interleave.
  let queue = Promise.resolve();
  const serial = (step) => (queue = queue.then(step).catch(onError));

  async function retireLegacyAgent() {
    let agentFound = true;
    try { await stat(legacyPlist); } catch { agentFound = false; }
    if (!agentFound) return false;
    if (!accountHome && !label.startsWith(TEST_LABEL_PREFIX)) {
      if (!legacySkipped) log('hub.legacy-skipped', { reason: 'not the account home', label });
      legacySkipped = true;
      return false;
    }
    let current = await readHubServiceSpec(paths.service);
    if (current === null) {
      const spec = specFromLaunchAgent(await readAgent(legacyPlist));
      if (spec instanceof Error) throw new Error(`cannot take the hub over from ${label}: ${spec.message}`);
      await writeHubServiceSpec(paths.service, spec);
      current = await readHubServiceSpec(paths.service);
    }
    // Without a spec to run, booting the agent out would only leave the hub down.
    if (current instanceof Error || current === null) throw new Error(`hub stays on ${label}: ${current?.message ?? 'no spec'}`);
    await runLaunchctl(['bootout', `gui/${process.getuid()}/${label}`]);
    await rm(legacyPlist, { force: true });
    // The old hub removes its socket path as it closes. Starting ours before it has gone would let
    // it unlink the socket ours just bound.
    const socket = hubSocketFor(current.spec);
    for (let waited = 0; waited < 10_000 && await socketBusy(socket); waited += 200) await sleep(200);
    log('hub.legacy-retired', { label });
    return true;
  }

  // A hub this supervisor did not stop (the engine was killed, or an older hub bundle that does not
  // watch its parent) would keep running beside the next one and both would tend the same zmx
  // sessions. Stop it when the recorded pid still runs the same program.
  async function reapPrevious() {
    let record;
    try { record = JSON.parse(await readFile(paths.servicePid, 'utf8')); } catch { return; }
    const pid = Number(record?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !isAlive(pid)) return;
    const entry = record.args?.[0];
    if (typeof entry !== 'string' || !(await commandOf(pid)).includes(entry)) return;
    log('hub.reap', { pid });
    try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let waited = 0; waited < stopTimeoutMs && isAlive(pid); waited += 100) await sleep(100);
    if (isAlive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
    await rm(paths.servicePid, { force: true });
  }

  async function readSpec() {
    const read = await readHubServiceSpec(paths.service).catch((error) => error);
    if (read instanceof Error) {
      if (reportedSpecError !== read.message) { reportedSpecError = read.message; onError(read); }
      return null;
    }
    reportedSpecError = null;
    return read;
  }

  async function launch(spec, text) {
    specText = text;
    await mkdir(path.dirname(spec.stdout), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(spec.stderr), { recursive: true, mode: 0o700 });
    const out = await open(spec.stdout, 'a', 0o600);
    const err = await open(spec.stderr, 'a', 0o600);
    try {
      const user = userInfo();
      const env = { PATH: LAUNCHD_PATH, USER: user.username, LOGNAME: user.username, SHELL: user.shell ?? '/bin/zsh', ...spec.env };
      // The IPC channel is the hub's lifeline: when this engine (or its service thread) goes away,
      // the hub sees `disconnect` and exits instead of outliving it.
      const started = spawn(spec.command, spec.args, { cwd: env.HOME ?? homedir(), env,
        stdio: ['ignore', out.fd, err.fd, 'ipc'], detached: false });
      child = started;
      startedAt = now();
      childExit = new Promise((resolve) => {
        let settled = false;
        const done = (code, signal) => { if (settled) return; settled = true; resolve({ code, signal }); };
        started.once('exit', done);
        started.once('error', (error) => { onError(error); done(null, 'spawn-error'); });
      });
      void childExit.then((exit) => serial(() => exited(started, exit)));
      if (started.pid) {
        await writeFile(paths.servicePid, JSON.stringify({ pid: started.pid, args: spec.args, enginePid: process.pid,
          requestedAt: spec.requestedAt ?? null, startedAt: new Date(startedAt).toISOString() }) + '\n', { mode: 0o600 });
        log('hub.started', { pid: started.pid });
      }
    } finally {
      await out.close().catch(() => {}); await err.close().catch(() => {});
    }
  }

  async function exited(which, exit) {
    if (which !== child) return;
    child = null; childExit = null; lastExit = { ...exit, at: new Date(now()).toISOString() };
    if (stopped) return;
    if (now() - startedAt >= stableMs) failures = 0;
    const delay = Math.min(maxBackoffMs, minBackoffMs * 2 ** failures);
    failures += 1;
    log('hub.exited', { code: exit.code, signal: exit.signal, restartInMs: delay });
    retry = setTimeout(() => { retry = null; serial(startFromSpec); }, delay);
  }

  async function stopChild() {
    const running = child;
    const exit = childExit;
    if (!running) return;
    child = null; childExit = null;
    running.kill('SIGTERM');
    const done = await Promise.race([exit, sleep(stopTimeoutMs).then(() => null)]);
    if (!done) { running.kill('SIGKILL'); await exit; }
    await rm(paths.servicePid, { force: true });
  }

  async function startFromSpec() {
    if (stopped || child || retry) return;
    const read = await readSpec();
    if (!read) { specText = null; return; }
    restarts += startedAt ? 1 : 0;
    await launch(read.spec, read.text);
  }

  // Polling is the whole control channel: install, update and restart rewrite the spec.
  async function check() {
    if (stopped) return;
    // An old release update can register the agent again while this engine runs. Its hub then
    // owns or has unlinked the socket, so ours starts over once the agent is gone.
    const retired = await retireLegacyAgent().then((value) => { reportedLegacyError = null; return value; }, (error) => {
      if (reportedLegacyError !== error.message) { reportedLegacyError = error.message; onError(error); }
      return false;
    });
    if (retired) {
      await stopChild();
      specText = null;
    }
    const read = await readSpec();
    const text = read?.text ?? null;
    if (text === specText) {
      if (!child && !retry && read) await startFromSpec();
      return;
    }
    log(read ? 'hub.spec-changed' : 'hub.spec-removed', {});
    if (retry) { clearTimeout(retry); retry = null; }
    failures = 0;
    await stopChild();
    specText = null;
    if (read) await startFromSpec();
  }

  const ready = serial(async () => {
    await reapPrevious().catch(onError);
    await check();
    if (!stopped) poll = setInterval(() => serial(check), pollMs);
  });

  return {
    ready,
    status: () => ({ pid: child?.pid ?? null, startedAt: child ? new Date(startedAt).toISOString() : null, restarts, failures,
      lastExit, retrying: Boolean(retry), spec: specText !== null }),
    close: () => {
      stopped = true;
      if (poll) clearInterval(poll);
      if (retry) { clearTimeout(retry); retry = null; }
      return serial(stopChild);
    },
  };
}

/** Resident-service entry (resident-services.mjs): the engine runs this in its own thread. */
export async function start(ctx = {}) {
  const supervisor = startHubSupervisor({ onError: ctx.onError ?? console.error, log: ctx.log ?? (() => {}) });
  ctx.signal?.addEventListener?.('abort', () => { void supervisor.close(); }, { once: true });
  await supervisor.ready;
  return { close: () => supervisor.close(), status: () => supervisor.status() };
}
