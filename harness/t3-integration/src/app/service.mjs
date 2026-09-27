// Settings > General > About, server half. The T3 server loads this module from
// the Rubato checkout (next to bridge.mjs): the checkout that runs the sessions
// is the one whose version the page shows and whose `rubato restart` it runs.
//
//   version   the checkout's commit, the pinned stock Pi, T3's upstream pin
//   check     rubato update --check (via gui-update.mjs) and what the update brings
//   restart   `rubato restart` through the one-shot updater (gui-update.mjs), detached:
//             it quits and reopens this very app, under the updater's lock
//   restart-status  that job's result, so the page can tell a failed restart
//
// Updating is not here: the desktop updater owns it (token, ready handshake, the
// in-app confirm), and the page asks it over IPC.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const integration = path.resolve(here, '..', '..');
const CHANGES_SHOWN = 20;

export class AppRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * runner: the updater's entry, given `restart TOKEN APP_PID`. appPid: the desktop app
 * this server runs under, 0 when there is none.
 * @param {{ env?: NodeJS.ProcessEnv, root?: string, runner?: readonly string[], appPid?: number,
 *   checkForUpdate?: (options: { root: string, env: NodeJS.ProcessEnv }) => Promise<{ available: boolean, revision?: string, commits?: number }> }} [options]
 */
export function createAppService(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const root = options.root ?? repoRoot;
  const runner = options.runner ?? ['/bin/bash', path.join(integration, 'gui-update.sh')];
  // The desktop app starts this server as Electron in Node mode. That is the app
  // the restart replaces; anywhere else (a remote server) there is none.
  const appPid = options.appPid ?? (env.ELECTRON_RUN_AS_NODE === '1' ? process.ppid : 0);
  // The app is often launched from the Dock with a PATH of /usr/bin:/bin.
  const childEnv = { ...env, PATH: [
    path.join(home, '.bun', 'bin'), path.join(home, '.local', 'share', 'vite-plus', 'bin'), path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin',
  ].join(path.delimiter) };

  function git(args, timeout = 5000) {
    return new Promise((resolve) => {
      execFile('git', ['-C', root, ...args], { env: childEnv, timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        resolve(error ? null : String(stdout).trim());
      });
    });
  }

  function readText(file) {
    try { return readFileSync(file, 'utf8'); } catch { return null; }
  }

  async function piVersion() {
    try {
      const module = await import(pathToFileURL(path.join(root, 'harness', 'pi-runtime', 'pi-version.mjs')).href);
      return typeof module.PI_VERSION === 'string' ? module.PI_VERSION : null;
    } catch { return null; }
  }

  async function version() {
    const [head, branch, status, pi] = await Promise.all([
      git(['log', '-1', '--format=%H%x00%h%x00%s%x00%cI']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['status', '--porcelain', '--untracked-files=no']),
      piVersion(),
    ]);
    const [revision, short, subject, committedAt] = (head ?? '').split('\0');
    let t3 = null;
    try { t3 = JSON.parse(readText(path.join(integration, 'upstream.json')) ?? 'null')?.upstreamCommit ?? null; } catch {}
    return {
      revision: revision || null,
      short: short || null,
      subject: subject || null,
      committedAt: committedAt || null,
      branch: branch || null,
      localChanges: status === null ? null : status.split('\n').filter(Boolean).length,
      pi,
      t3: typeof t3 === 'string' ? t3.slice(0, 9) : null,
    };
  }

  async function check() {
    const checkForUpdate = options.checkForUpdate
      ?? (await updater()).checkForUpdate;
    let result;
    try { result = await checkForUpdate({ root, env: childEnv }); }
    catch (error) { throw new AppRequestError(502, 'check-failed', error instanceof Error ? error.message : String(error)); }
    if (!result.available) return { available: false, commits: 0, changes: [] };
    const log = await git(['log', `--max-count=${CHANGES_SHOWN}`, '--format=%h%x00%s%x00%cI', 'HEAD..origin/rubato/base']);
    const changes = (log ?? '').split('\n').filter(Boolean).map((line) => {
      const [short, subject, committedAt] = line.split('\0');
      return { short, subject, committedAt };
    });
    return { available: true, commits: result.commits ?? changes.length, changes };
  }

  const updater = () => import(pathToFileURL(path.join(integration, 'gui-update.mjs')).href);

  // Detached into its own session: the restart quits this app (and this server)
  // before it reopens it, and must outlive both. The updater's lock is the one
  // guard against a second restart or an update at the same time; checking it
  // here only turns the common case into an answer instead of a silent no-op.
  async function restart() {
    const { stateDirectory, readJson, alive } = await updater();
    const directory = stateDirectory(env);
    const owner = await readJson(path.join(directory, 'lock.json'));
    if (owner && alive(owner.pid))
      throw new AppRequestError(409, 'restarting', 'An update or restart is already running.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const log = path.join(directory, 'update.log');
    const token = randomUUID();
    // ELECTRON_RUN_AS_NODE belongs to this server alone. Handed down, it would
    // reach the bundle rebuild and anything else that runs the Electron binary.
    const { ELECTRON_RUN_AS_NODE: _serverOnly, ...restartEnv } = childEnv;
    const fd = openSync(log, 'a', 0o600);
    try {
      const child = spawn(runner[0], [...runner.slice(1), 'restart', token, String(appPid)], {
        cwd: root, env: restartEnv, detached: true, stdio: ['ignore', fd, fd],
      });
      child.unref();
    } finally { closeSync(fd); }
    return { token, startedAt: new Date().toISOString(), log };
  }

  // The updater's last result and whether a job holds its lock. The page matches
  // the token it got from restart; a result for another token is not its answer.
  async function restartStatus() {
    const { stateDirectory, readJson, alive } = await updater();
    const directory = stateDirectory(env);
    const owner = await readJson(path.join(directory, 'lock.json'));
    const result = await readJson(path.join(directory, 'result.json'));
    return {
      busy: Boolean(owner && alive(owner.pid)),
      result: result ? { token: result.token ?? null, kind: result.kind ?? 'update', status: result.status ?? null,
        message: result.message ?? null } : null,
      log: path.join(directory, 'update.log'),
    };
  }

  const actions = { version, check, restart, 'restart-status': restartStatus };
  return {
    async handle(action) {
      const handler = Object.hasOwn(actions, action) ? actions[action] : undefined;
      if (!handler) throw new AppRequestError(404, 'unknown-action', `Unknown action: ${action}`);
      return handler();
    },
  };
}

export async function handleAppRequest(service, request) {
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  if (request.method !== 'POST' && request.method !== 'GET')
    return Response.json({ error: { code: 'method', message: 'Use GET or POST.' } }, { status: 405 });
  try {
    return Response.json(await service.handle(action));
  } catch (error) {
    const status = error instanceof AppRequestError ? error.status : 500;
    const code = error instanceof AppRequestError ? error.code : 'failed';
    return Response.json({ error: { code, message: error instanceof Error ? error.message : String(error) } }, { status });
  }
}

let shared;
/** The instance the T3 server uses. */
export function appService() {
  shared ??= createAppService();
  return shared;
}
