// LiveKit for a phone or another Mac on the person's tailnet. LiveKit's signalling listens on
// loopback only (livekit.mjs); Tailscale Serve carries one HTTPS port of this Mac's tailnet name to
// it, so a device on the tailnet joins over wss with a real certificate and nothing is reachable
// from outside the tailnet (Serve, never Funnel). Media already goes straight to the Mac's
// interface addresses, the Tailscale one included.
//
// The mapping is made once Tailscale runs, retried until then, and left in place when the service
// stops: Serve keeps it, and the next start finds it already there. A port another tool holds is
// never taken over; the reason says so instead.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const REMOTE_PORT = Number(process.env.RUBATO_CALL_REMOTE_PORT ?? 7443);
export const RETRY_MS = 15_000;

/** The Tailscale CLI by absolute path: the engine runs under launchd, whose PATH has no Homebrew. */
export function tailscalePath(env = process.env) {
  const candidates = [env.RUBATO_TAILSCALE, ...String(env.PATH ?? '').split(':').filter(Boolean).map(dir => path.join(dir, 'tailscale')),
    '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'].filter(Boolean);
  return candidates.find(file => existsSync(file)) ?? null;
}

const runCli = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).trim().split('\n')[0]));
    else resolve(stdout);
  });
});

/**
 * One attempt: the wss URL a tailnet device uses for LiveKit, or why there is none yet.
 * `run(args)` runs the Tailscale CLI and resolves its stdout.
 */
export async function exposeOnTailnet({ run, localPort, httpsPort = REMOTE_PORT }) {
  const status = JSON.parse(await run(['status', '--json']));
  if (status.BackendState !== 'Running') return { url: null, reason: `Tailscale is ${status.BackendState ?? 'not running'}` };
  const host = String(status.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!host) return { url: null, reason: 'this Mac has no tailnet name (MagicDNS off?)' };
  const target = `http://127.0.0.1:${localPort}`;
  const serve = JSON.parse((await run(['serve', 'status', '--json'])) || '{}');
  const held = serve.Web?.[`${host}:${httpsPort}`]?.Handlers?.['/']?.Proxy;
  if (held && held !== target) return { url: null, reason: `tailnet port ${httpsPort} already serves ${held}` };
  if (serve.TCP?.[String(httpsPort)] && !serve.TCP[String(httpsPort)].HTTPS) return { url: null, reason: `tailnet port ${httpsPort} is in use` };
  if (serve.AllowFunnel?.[`${host}:${httpsPort}`]) return { url: null, reason: `tailnet port ${httpsPort} is open to the internet (Funnel)` };
  if (!held) await run(['serve', '--bg', `--https=${httpsPort}`, target]);
  return { url: `wss://${host}:${httpsPort}`, reason: null };
}

/**
 * Keeps trying until LiveKit is reachable on the tailnet. `state()` answers { url, reason } as of
 * the last attempt; `url` is null until one succeeds.
 */
export function startTailnetExposure({ localPort, httpsPort = REMOTE_PORT, env = process.env, run, every = RETRY_MS, log = () => {} }) {
  const cli = run ? null : tailscalePath(env);
  const exec = run ?? (cli ? args => runCli(cli, args) : null);
  let state = { url: null, reason: exec ? 'checking Tailscale' : 'Tailscale is not installed' };
  let timer = null, closed = false, said = null;
  async function attempt() {
    if (closed || !exec) return;
    try { state = await exposeOnTailnet({ run: exec, localPort, httpsPort }); }
    catch (error) { state = { url: null, reason: `Tailscale: ${error.message}` }; }
    if (closed) return;
    const line = state.url ?? state.reason;
    if (line !== said) { said = line; log(state.url ? 'call audio reachable on the tailnet' : 'call audio not on the tailnet yet', state); }
    if (!state.url) timer = setTimeout(attempt, every);
  }
  const ready = attempt();
  return {
    ready,
    state: () => state,
    close() { closed = true; clearTimeout(timer); },
  };
}
