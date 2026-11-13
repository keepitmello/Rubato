// Runs everything a companion call needs on this Mac: the LiveKit server, the call worker and a
// small local page that hands out room tokens. Everything listens on loopback only.
//
//   node run.mjs            start all three; Ctrl-C stops them
//
// The LiveKit key pair is made once and kept in ~/.rubato/call/livekit.yaml (0600); the rest of
// that file is rewritten on every start.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { AGENT_NAME } from './agent.mjs';
import { callableCompanions } from './companion.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.RUBATO_CALL_HOME ?? path.join(os.homedir(), '.rubato', 'call');
const LIVEKIT_PORT = Number(process.env.RUBATO_CALL_LIVEKIT_PORT ?? 7880);
const PAGE_PORT = Number(process.env.RUBATO_CALL_PAGE_PORT ?? 18790);
const HOST = '127.0.0.1';

export function livekitConfig(file = path.join(home, 'livekit.yaml')) {
  const kept = existsSync(file) ? readFileSync(file, 'utf8').match(/^keys:\n\s+(\S+):\s*(\S+)/m) : null;
  const key = kept?.[1] ?? `rubato${randomBytes(6).toString('hex')}`;
  const secret = kept?.[2] ?? randomBytes(32).toString('base64url');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Signalling stays on loopback. Media advertises this Mac's own interface addresses (Wi-Fi,
  // Tailscale): browsers never pair a loopback ICE candidate, so 127.0.0.1 leaves a page stuck
  // connecting, and a phone reaches the Mac only through a real address.
  writeFileSync(file, [
    `port: ${LIVEKIT_PORT}`,
    `bind_addresses: ["${HOST}"]`,
    'rtc:',
    `  tcp_port: ${LIVEKIT_PORT + 1}`,
    '  port_range_start: 50000',
    '  port_range_end: 50100',
    '  use_external_ip: false',
    'keys:',
    `  ${key}: ${secret}`,
    'logging:',
    '  level: info',
    '',
  ].join('\n'), { mode: 0o600 });
  return { file, key, secret, url: `ws://${HOST}:${LIVEKIT_PORT}` };
}

async function token({ key, secret }, companion) {
  const room = `call-${companion}-${Date.now().toString(36)}`;
  const grant = new AccessToken(key, secret, { identity: 'caller', ttl: '2h' });
  grant.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
  grant.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata: JSON.stringify({ companion }) })],
  });
  return { room, token: await grant.toJwt() };
}

function page(livekit) {
  const client = path.join(here, 'node_modules', 'livekit-client', 'dist', 'livekit-client.esm.mjs');
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://local');
    const send = (status, type, body) => { response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); response.end(body); };
    try {
      if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', readFileSync(path.join(here, 'page', 'index.html')));
      if (url.pathname === '/livekit-client.mjs') return send(200, 'text/javascript', readFileSync(client));
      if (url.pathname === '/companions') return send(200, 'application/json', JSON.stringify(callableCompanions()));
      if (url.pathname === '/token') {
        const companion = url.searchParams.get('companion');
        if (!callableCompanions().some(item => item.id === companion && item.ready)) return send(422, 'application/json', '{"error":"not callable"}');
        return send(200, 'application/json', JSON.stringify({ url: livekit.url, ...await token(livekit, companion) }));
      }
      send(404, 'text/plain', 'not found');
    } catch (error) { send(500, 'text/plain', String(error?.message ?? error)); }
  });
}

function child(name, command, args, env = {}) {
  const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  for (const stream of [proc.stdout, proc.stderr])
    stream.on('data', chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) console.log(`[${name}] ${line}`); });
  proc.on('exit', code => { console.log(`[${name}] exited ${code}`); shutdown(1); });
  return proc;
}

const children = [];
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  for (const proc of children) proc.kill('SIGINT');
  setTimeout(() => process.exit(code), 1500).unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const livekit = livekitConfig();
  children.push(child('livekit', 'livekit-server', ['--config', livekit.file]));
  children.push(child('agent', process.execPath, [path.join(here, 'agent.mjs'), 'start'],
    { LIVEKIT_URL: livekit.url, LIVEKIT_API_KEY: livekit.key, LIVEKIT_API_SECRET: livekit.secret }));
  page(livekit).listen(PAGE_PORT, HOST, () => console.log(`[page] http://${HOST}:${PAGE_PORT}/`));
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}
