// Settings > General > About, server half. The T3 server loads this module from
// the Rubato checkout (next to bridge.mjs): the checkout that runs the sessions
// is the one whose version the page shows and whose `rubato restart` it runs.
//
//   version   the checkout's commit, the pinned stock Pi, T3's upstream pin
//   check     rubato update --check (via gui-update.mjs) and what the update brings
//   restart   `rubato restart`, detached: it quits and reopens this very app
//
// Updating is not here: the desktop updater owns it (token, ready handshake, the
// in-app confirm), and the page asks it over IPC.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const integration = path.resolve(here, '..', '..');
const CHANGES_SHOWN = 20;
const RESTART_GRACE_MS = 10 * 60_000;

export class AppRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, root?: string, rubato?: readonly string[],
 *   checkForUpdate?: (options: { root: string, env: NodeJS.ProcessEnv }) => Promise<{ available: boolean, revision?: string, commits?: number }> }} [options]
 */
export function createAppService(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const root = options.root ?? repoRoot;
  const rubato = options.rubato ?? ['/bin/sh', path.join(root, 'harness', 'scripts', 'rubato-pi.sh')];
  // The app is often launched from the Dock with a PATH of /usr/bin:/bin.
  const childEnv = { ...env, PATH: [
    path.join(home, '.bun', 'bin'), path.join(home, '.local', 'share', 'vite-plus', 'bin'), path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin',
  ].join(path.delimiter) };
  let restartStartedAt = 0;

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
      ?? (await import(pathToFileURL(path.join(integration, 'gui-update.mjs')).href)).checkForUpdate;
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

  // Detached into its own session: the restart quits this app (and this server)
  // before it reopens it, and must outlive both.
  function restart() {
    if (Date.now() - restartStartedAt < RESTART_GRACE_MS)
      throw new AppRequestError(409, 'restarting', 'A restart is already running.');
    const logDir = path.join(home, '.rubato-pi', 'logs');
    mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, 'rubato-restart-gui.log');
    const fd = openSync(log, 'a', 0o600);
    try {
      const child = spawn(rubato[0], [...rubato.slice(1), 'restart'], {
        cwd: root, env: childEnv, detached: true, stdio: ['ignore', fd, fd],
      });
      child.unref();
    } finally { closeSync(fd); }
    restartStartedAt = Date.now();
    return { startedAt: new Date(restartStartedAt).toISOString(), log };
  }

  const actions = { version, check, restart };
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
