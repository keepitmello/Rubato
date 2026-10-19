#!/usr/bin/env node
// The person's profile engine as a launchd job: launchd starts it at login and starts it again
// whenever it ends, so the conversations, the companion and the scheduler inside it are there
// without the app or a terminal. One job, `com.keepitmello.rubato.engine`, per account.
//
// How the other starters live with it:
//   - Starting: every starter goes through ensureProfileEngine (discovery.mjs). When this job
//     manages the profile, it asks launchd to start the job instead of spawning its own engine.
//   - Restarting: a restart still sends SIGTERM; the engine drains and exits, and launchd starts
//     the next one (KeepAlive). A job whose definition changed is reloaded instead (bootout,
//     bootstrap) so the next engine runs the new definition.
//   - The profile lock: an engine launchd starts while another one holds the lock waits for the
//     lock (cli.mjs --launchd) instead of exiting, so launchd never loops on a lost start.
//
// The scheduler used to be its own launchd job; it now runs inside the engine. Registering this
// job removes that one.
//
// Sandboxes and tests name their own job with RUBATO_ENGINE_LAUNCHD_LABEL (only
// `com.keepitmello.rubato.test.*`), RUBATO_LAUNCH_AGENTS_DIR and RUBATO_LAUNCHCTL_BIN.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveLaunchAgentDir } from '../../rubato-pi/src/launch.mjs';

const execFileAsync = promisify(execFile);

export const ENGINE_LAUNCHD_LABEL = 'com.keepitmello.rubato.engine';
export const LEGACY_SCHEDULER_LABEL = 'com.keepitmello.rubato.scheduler';
export const TEST_LABEL_PREFIX = 'com.keepitmello.rubato.test.';
export const ENGINE_CLI = path.join(import.meta.dirname, 'cli.mjs');
/** The drain (drain.mjs DRAIN_TIMEOUT_MS) plus the close after it. */
export const EXIT_TIMEOUT_S = 150;
export const THROTTLE_S = 5;

/** Settings a sandbox engine needs to find its own profile, engine build and homes. */
const CARRIED_ENV = ['RUBATO_PI_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'RUBATO_PI_ENGINE_DIR',
  'RUBATO_STOCK_ENGINE_DIR', 'RUBATO_SCHEDULE_HOME', 'RUBATO_COMPANION_HOME', 'RUBATO_ENGINE_LAUNCHD_LABEL',
  'RUBATO_LAUNCH_AGENTS_DIR', 'RUBATO_LAUNCHCTL_BIN'];

const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unescapeXml = (value) => String(value).replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'").replaceAll('&amp;', '&');

/** Where this account's engine job lives, for `env`. */
export function engineJob(env = process.env, { uid = process.getuid?.() } = {}) {
  const home = env.HOME || homedir();
  const label = env.RUBATO_ENGINE_LAUNCHD_LABEL?.trim() || ENGINE_LAUNCHD_LABEL;
  if (label !== ENGINE_LAUNCHD_LABEL && !label.startsWith(TEST_LABEL_PREFIX)) {
    throw new Error(`RUBATO_ENGINE_LAUNCHD_LABEL must start with ${TEST_LABEL_PREFIX}`);
  }
  const agentsDir = env.RUBATO_LAUNCH_AGENTS_DIR?.trim() || path.join(home, 'Library', 'LaunchAgents');
  // A test job never reaches the account's real scheduler job either.
  const legacySchedulerLabel = label === ENGINE_LAUNCHD_LABEL ? LEGACY_SCHEDULER_LABEL : `${TEST_LABEL_PREFIX}scheduler`;
  return {
    label, home, agentsDir, uid, legacySchedulerLabel,
    plistPath: path.join(agentsDir, `${label}.plist`),
    legacySchedulerPlist: path.join(agentsDir, `${legacySchedulerLabel}.plist`),
    launchctl: env.RUBATO_LAUNCHCTL_BIN || '/bin/launchctl',
    domain: `gui/${uid}`,
    target: `gui/${uid}/${label}`,
  };
}

function isAccountHome(home) {
  try { return realpathSync(home) === realpathSync(userInfo().homedir); } catch { return false; }
}

/**
 * Whether this machine registers the engine with launchd for `env`: macOS, and either the account's
 * own home or a caller that named its own launchctl or test job. A test HOME never reaches the
 * account's launchd jobs.
 */
export function engineLaunchdApplies(env = process.env, { platform = process.platform } = {}) {
  if (platform !== 'darwin' || env.RUBATO_NO_ENGINE_LAUNCHD) return false;
  if (env.RUBATO_LAUNCHCTL_BIN || env.RUBATO_ENGINE_LAUNCHD_LABEL) return true;
  return isAccountHome(env.HOME || homedir());
}

const nodeMajor = (bin) => {
  try { return Number(String(execFileSync(bin, ['-v'], { encoding: 'utf8', timeout: 5000 })).trim().replace(/^v/, '').split('.')[0]); }
  catch { return 0; }
};

/**
 * A real Node 24+ for a launchd job. The T3 server runs under Electron, whose execPath is the app,
 * so look where `rubato` itself found Node (its cache), then the usual install places.
 */
export function resolveNodeBinary(env = process.env) {
  const home = env.HOME || homedir();
  const candidates = [];
  if (env.RUBATO_NODE) candidates.push(env.RUBATO_NODE);
  if (!process.versions.electron) candidates.push(process.execPath);
  try { candidates.push(readFileSync(path.join(home, '.rubato-pi', 'node-path'), 'utf8').trim()); } catch {}
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  try { candidates.push(...readdirSync(nvm).sort().reverse().map((version) => path.join(nvm, version, 'bin', 'node'))); } catch {}
  candidates.push('/opt/homebrew/opt/node@24/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node');
  for (const candidate of candidates) if (candidate && existsSync(candidate) && nodeMajor(candidate) >= 24) return candidate;
  return null;
}

/** The PATH written into the job: fixed, so the definition only changes when Node or the checkout does. */
export function baselinePath(nodePath, home) {
  return [...new Set([path.dirname(nodePath), path.join(home, '.bun', 'bin'), path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
}

/**
 * The PATH a login shell has, read once when launchd starts the engine. Conversations run their
 * tools with it, as they did when the app (which reads it the same way) started the engine.
 */
export function loginShellPath(env = process.env, { run = execFileSync } = {}) {
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  const start = '__RUBATO_PATH_START__';
  const end = '__RUBATO_PATH_END__';
  try {
    const output = String(run(shell, ['-ilc', `printf '%s%s%s' '${start}' "$PATH" '${end}'`],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, TERM: env.TERM ?? 'dumb' } }));
    const match = output.match(new RegExp(`${start}(.*?)${end}`, 's'));
    return match?.[1] || null;
  } catch { return null; }
}

export function mergePaths(...values) {
  return [...new Set(values.flatMap((value) => String(value ?? '').split(':')).filter((part) => part && path.isAbsolute(part)))].join(':');
}

export function renderEngineLaunchAgent({ label = ENGINE_LAUNCHD_LABEL, nodePath, cliPath = ENGINE_CLI, agentDir, home, pathEnv, logPath,
  env = {} }) {
  const vars = { HOME: home, PATH: pathEnv, NODE_OPTIONS: '--experimental-strip-types', ...env };
  const dict = Object.keys(vars).sort().map((key) => `<key>${escapeXml(key)}</key><string>${escapeXml(vars[key])}</string>`).join('');
  const args = [nodePath, cliPath, '--agent-dir', agentDir, '--launchd'].map((value) => `<string>${escapeXml(value)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(label)}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${escapeXml(agentDir)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>${THROTTLE_S}</integer>
<key>ExitTimeOut</key><integer>${EXIT_TIMEOUT_S}</integer>
<key>AbandonProcessGroup</key><true/>
<key>EnvironmentVariables</key><dict>${dict}</dict>
<key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
<key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
</dict></plist>
`;
}

/** The profile directory a written job starts the engine for, or undefined. */
export function plistAgentDir(plist) {
  const block = plist.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s)?.[1] ?? '';
  const args = [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => unescapeXml(match[1]));
  const at = args.indexOf('--agent-dir');
  return at >= 0 ? args[at + 1] : undefined;
}

const sameDir = (a, b) => {
  if (!a || !b) return false;
  const resolve = (value) => { try { return realpathSync(value); } catch { return path.resolve(value); } };
  return resolve(a) === resolve(b);
};

/**
 * Whether launchd keeps the engine for `agentDir`: this machine uses the job, it is written, and it
 * starts this very profile. Other profiles (tests, tools) keep starting their own engines.
 */
export function launchdManagesEngine({ agentDir, env = process.env, platform = process.platform } = {}) {
  if (!engineLaunchdApplies(env, { platform })) return false;
  let job;
  try { job = engineJob(env); } catch { return false; }
  let plist;
  try { plist = readFileSync(job.plistPath, 'utf8'); } catch { return false; }
  return sameDir(plistAgentDir(plist), agentDir);
}

const run = (job, args, env) => execFileAsync(job.launchctl, args, { env, timeout: (EXIT_TIMEOUT_S + 30) * 1000 });

export async function engineJobLoaded(job, env = process.env) {
  try { await run(job, ['print', job.target], env); return true; } catch { return false; }
}

/** The pid launchd runs the job as, or undefined. */
export async function engineJobPid({ env = process.env, job = engineJob(env) } = {}) {
  try {
    const { stdout } = await run(job, ['print', job.target], env);
    const pid = Number(/^\s*pid = (\d+)/m.exec(stdout)?.[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

/** Asks launchd to start the job now (nothing happens if it runs). Loads it first if it is not. */
export async function kickstartEngine({ env = process.env, job = engineJob(env) } = {}) {
  try { await run(job, ['kickstart', job.target], env); return true; } catch {}
  try {
    await run(job, ['enable', job.target], env).catch(() => {});
    await run(job, ['bootstrap', job.domain, job.plistPath], env);
    await run(job, ['kickstart', job.target], env).catch(() => {});
    return true;
  } catch { return false; }
}

/** Removes the scheduler's own launchd job: the scheduler runs inside the engine now. */
export async function removeLegacyScheduler({ env = process.env, job = engineJob(env) } = {}) {
  const present = existsSync(job.legacySchedulerPlist);
  const target = `${job.domain}/${job.legacySchedulerLabel}`;
  const loaded = await run(job, ['print', target], env).then(() => true, () => false);
  if (!present && !loaded) return false;
  // The file goes first: removing the job ends the old scheduler, and the scheduler itself may be
  // the caller (daemon.mjs moves a machine over when launchd starts it).
  rmSync(job.legacySchedulerPlist, { force: true });
  if (loaded) await run(job, ['bootout', target], env).catch(() => {});
  return true;
}

/**
 * Writes and loads this account's engine job for the person's profile, and removes the old
 * scheduler job. A job that is already loaded keeps running: when its definition changed it is
 * reported `stale`, and the next restart reloads it (restart-profile-engine.mjs).
 * @returns {Promise<{ label: string, plistPath: string, changed: boolean, bootstrapped: boolean, stale: boolean, removedLegacy: boolean }>}
 */
export async function ensureEngineLaunchAgent({ env = process.env, agentDir = path.resolve(resolveLaunchAgentDir(env)),
  nodePath = resolveNodeBinary(env), cliPath = ENGINE_CLI } = {}) {
  const job = engineJob(env);
  if (job.uid === undefined) throw new Error('launchd needs a user id');
  if (!nodePath) throw new Error('Could not find Node.js 24 or newer to run the engine.');
  const logPath = path.join(agentDir, 'logs', 'pi-server.log');
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  mkdirSync(job.agentsDir, { recursive: true });
  const carried = Object.fromEntries(CARRIED_ENV.filter((key) => env[key]?.trim()).map((key) => [key, env[key]]));
  const plist = renderEngineLaunchAgent({ label: job.label, nodePath, cliPath, agentDir, home: job.home,
    pathEnv: baselinePath(nodePath, job.home), logPath, env: carried });
  let previous;
  try { previous = readFileSync(job.plistPath, 'utf8'); } catch {}
  const changed = previous !== plist;
  if (changed) {
    const temporary = `${job.plistPath}.${process.pid}.tmp`;
    writeFileSync(temporary, plist);
    renameSync(temporary, job.plistPath);
  }
  const loaded = await engineJobLoaded(job, env);
  let bootstrapped = false;
  if (!loaded) {
    await run(job, ['enable', job.target], env).catch(() => {});
    await run(job, ['bootstrap', job.domain, job.plistPath], env);
    bootstrapped = true;
  }
  const removedLegacy = await removeLegacyScheduler({ env, job });
  return { label: job.label, plistPath: job.plistPath, changed, bootstrapped, stale: loaded && changed, removedLegacy };
}

/** Reloads the job so launchd runs its current definition. Ends the running engine (SIGTERM, drain). */
export async function reloadEngineJob({ env = process.env, job = engineJob(env) } = {}) {
  await run(job, ['bootout', job.target], env).catch(() => {});
  await run(job, ['enable', job.target], env).catch(() => {});
  await run(job, ['bootstrap', job.domain, job.plistPath], env);
}

/** Unloads and deletes the job (the engine stops; the next starter spawns one on demand again). */
export async function removeEngineLaunchAgent({ env = process.env, job = engineJob(env) } = {}) {
  await run(job, ['bootout', job.target], env).catch(() => {});
  rmSync(job.plistPath, { force: true });
  return { plistPath: job.plistPath };
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  // `ensure` registers the job; `--reload` also reloads a running job whose definition changed,
  // which restarts its engine (the drain lets running tool calls finish first).
  const [command = 'ensure', ...flags] = process.argv.slice(2);
  try {
    if (command === 'ensure') {
      if (!engineLaunchdApplies()) { process.stdout.write('skipped\n'); }
      else {
        const result = await ensureEngineLaunchAgent();
        let state = result.bootstrapped ? 'registered' : result.stale ? 'stale' : 'current';
        if (result.stale && flags.includes('--reload')) { await reloadEngineJob(); state = 'reloaded'; }
        process.stdout.write(`${state}${result.removedLegacy ? ' legacy-scheduler-removed' : ''}\n`);
      }
    } else if (command === 'remove') {
      process.stdout.write(`${JSON.stringify(await removeEngineLaunchAgent())}\n`);
    } else {
      process.stderr.write('usage: launchd.mjs [ensure|remove]\n');
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`rubato engine launchd: ${error?.stderr || error?.message || error}\n`);
    process.exitCode = 1;
  }
}
