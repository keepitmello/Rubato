// The settings "Providers" tab's server half. The T3 server loads this module from
// the Rubato checkout (next to bridge.mjs) and forwards one action per request.
//
// It stands on the `rubato auth --json` contract (harness/scripts/rubato-auth.mjs),
// not on credential files: the CLI that owns auth.json, the setup-token file and the
// pool state answers for them. A login is a child process that talks JSON lines; the
// page polls its state and answers its prompts. Secrets pass through the child's
// stdin and are never kept in a job snapshot.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const METHODS = new Set(['oauth', 'api_key', 'setup-token']);
const FINISHED_JOB_TTL_MS = 10 * 60_000;
const CANCEL_GRACE_MS = 3_000;

export class AuthRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (message) => new AuthRequestError(400, 'bad-request', message);

function need(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw bad(`${name} is missing or malformed.`);
  return value;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, auth?: readonly string[] }} [options]
 *   `auth` is the argv prefix that runs `rubato auth`; default: this checkout's script.
 */
export function createAuthService(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const auth = options.auth ?? ['/bin/sh', path.join(repoRoot, 'harness', 'scripts', 'rubato-auth.sh')];
  // The app is often launched from the Dock with a PATH of /usr/bin:/bin.
  const childEnv = { ...env, PATH: [
    path.join(home, '.bun', 'bin'), path.join(home, '.local', 'share', 'vite-plus', 'bin'), path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin',
  ].join(path.delimiter) };
  const jobs = new Map();

  function runJson(args, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const child = spawn(auth[0], [...auth.slice(1), ...args, '--json'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new AuthRequestError(500, 'auth-unavailable', `rubato auth could not start: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = stdout.trim().split('\n').at(-1) ?? '';
        let value;
        try { value = JSON.parse(line); } catch { value = undefined; }
        if (value?.error) {
          reject(new AuthRequestError(value.error.code === 'usage' ? 400 : 500, value.error.code ?? 'failed', value.error.message ?? 'rubato auth failed.'));
        } else if (value === undefined) {
          reject(new AuthRequestError(500, 'failed', (stderr.trim() || `rubato auth exited with ${code}`).slice(-2000)));
        } else resolve(value);
      });
    });
  }

  function snapshot(job) {
    return {
      id: job.id,
      provider: job.provider,
      method: job.method,
      status: job.status,
      authUrl: job.authUrl,
      deviceCode: job.deviceCode,
      info: job.info,
      prompt: job.prompt,
      message: job.message,
    };
  }

  function finish(job, status, message) {
    if (job.status !== 'running') return;
    job.status = status;
    job.prompt = null;
    job.message = message ?? null;
    clearTimeout(job.killTimer);
    setTimeout(() => jobs.delete(job.id), FINISHED_JOB_TTL_MS).unref?.();
  }

  function onEvent(job, event) {
    if (event.type === 'auth_url') job.authUrl = { url: event.url, instructions: event.instructions ?? null };
    else if (event.type === 'device_code') job.deviceCode = { userCode: event.userCode, verificationUri: event.verificationUri };
    else if (event.type === 'info' && typeof event.message === 'string') job.info = [...job.info, event.message].slice(-8);
    else if (event.type === 'prompt') {
      job.prompt = {
        id: event.id,
        kind: event.kind,
        message: event.message ?? '',
        placeholder: event.placeholder ?? null,
        options: event.options ?? null,
      };
    } else if (event.type === 'prompt_closed' && job.prompt?.id === event.id) job.prompt = null;
    else if (event.type === 'done') finish(job, 'done', event.message);
    else if (event.type === 'cancelled') finish(job, 'cancelled', null);
    else if (event.type === 'error') finish(job, 'error', event.message);
  }

  function startLogin(provider, method) {
    // One login at a time: a second one would race the first for the same callback port.
    for (const job of jobs.values()) if (job.status === 'running') cancelJob(job);
    const child = spawn(auth[0], [...auth.slice(1), 'login', provider, method, '--json'], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const job = {
      id: randomUUID(), provider, method, status: 'running',
      authUrl: null, deviceCode: null, info: [], prompt: null, message: null,
      child, stderr: '', killTimer: undefined,
    };
    jobs.set(job.id, job);
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        try { onEvent(job, JSON.parse(line)); } catch { /* not ours: engines sometimes print */ }
      }
    });
    child.stderr.on('data', (chunk) => { job.stderr = (job.stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish(job, 'error', `rubato auth could not start: ${error.message}`));
    child.on('close', (code) => finish(job, 'error', job.stderr.trim() || `rubato auth exited with ${code}`));
    return job;
  }

  function jobOf(input) {
    const job = jobs.get(input?.job);
    if (!job) throw new AuthRequestError(404, 'no-job', 'That login is gone. Start it again.');
    return job;
  }

  function send(job, message) {
    if (job.child.stdin.writable) job.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function cancelJob(job) {
    if (job.status !== 'running') return;
    send(job, { type: 'cancel' });
    job.killTimer = setTimeout(() => job.child.kill('SIGTERM'), CANCEL_GRACE_MS);
    job.killTimer.unref?.();
  }

  async function handle(action, input = {}) {
    if (action === 'status') return runJson(['status']);
    if (action === 'check') {
      return runJson(['check', need(input.provider, PROVIDER, 'provider'), need(input.account, ACCOUNT, 'account')], 120_000);
    }
    if (action === 'pin') {
      const provider = need(input.provider, PROVIDER, 'provider');
      if (input.account === null) return runJson(['unpin', provider]);
      return runJson(['pin', provider, need(input.account, ACCOUNT, 'account')]);
    }
    if (action === 'remove') {
      return runJson(['remove', need(input.provider, PROVIDER, 'provider'), need(input.account, ACCOUNT, 'account')]);
    }
    if (action === 'login') {
      const provider = need(input.provider, PROVIDER, 'provider');
      if (!METHODS.has(input.method)) throw bad('method is missing or malformed.');
      return snapshot(startLogin(provider, input.method));
    }
    if (action === 'login-state') return snapshot(jobOf(input));
    if (action === 'answer') {
      const job = jobOf(input);
      if (job.status !== 'running' || job.prompt?.id !== input.prompt) throw new AuthRequestError(409, 'stale-prompt', 'That question is no longer open.');
      if (typeof input.value !== 'string') throw bad('value must be a string.');
      send(job, { id: job.prompt.id, value: input.value });
      job.prompt = null;
      return snapshot(job);
    }
    if (action === 'cancel') {
      const job = jobOf(input);
      cancelJob(job);
      return snapshot(job);
    }
    throw new AuthRequestError(404, 'unknown-action', `Unknown action: ${action}`);
  }

  return { handle };
}

export async function handleAuthRequest(service, request) {
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  let input = {};
  if (request.method === 'POST') {
    try { input = await request.json(); } catch { return Response.json({ error: { code: 'bad-request', message: 'Request body must be JSON.' } }, { status: 400 }); }
  } else if (request.method === 'GET') {
    input = Object.fromEntries(new URL(request.url).searchParams);
  } else {
    return Response.json({ error: { code: 'method', message: 'Use GET or POST.' } }, { status: 405 });
  }
  try {
    return Response.json(await service.handle(action, input));
  } catch (error) {
    const status = error instanceof AuthRequestError ? error.status : 500;
    const code = error instanceof AuthRequestError ? error.code : 'failed';
    return Response.json({ error: { code, message: error instanceof Error ? error.message : String(error) } }, { status });
  }
}

let shared;
/** The instance the T3 server uses. */
export function authService() {
  shared ??= createAuthService();
  return shared;
}
