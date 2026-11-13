// The LiveKit side every caller shares: the server's config file and room tokens. The key pair is
// made once and kept in ~/.rubato/call/livekit.yaml (0600); the rest of that file is rewritten on
// every start so a change here reaches the next start.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';

export const AGENT_NAME = 'rubato-companion-call';
export const CALL_HOME = process.env.RUBATO_CALL_HOME ?? path.join(os.homedir(), '.rubato', 'call');
export const LIVEKIT_PORT = Number(process.env.RUBATO_CALL_LIVEKIT_PORT ?? 7880);
export const CONTROL_PORT = Number(process.env.RUBATO_CALL_CONTROL_PORT ?? 18790);
export const HOST = '127.0.0.1';

export function livekitConfig(file = path.join(CALL_HOME, 'livekit.yaml')) {
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

/** A token for the person's device in `room`; joining it sends the call worker in with `job`. */
export async function roomToken({ key, secret }, room, job) {
  const grant = new AccessToken(key, secret, { identity: 'caller', ttl: '2h' });
  grant.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
  grant.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata: JSON.stringify(job) })],
  });
  return grant.toJwt();
}

/** livekit-server by absolute path: the engine runs under launchd, whose PATH has no Homebrew. */
export function livekitServerPath(env = process.env) {
  const candidates = [env.RUBATO_LIVEKIT_SERVER, ...String(env.PATH ?? '').split(':').map(dir => path.join(dir, 'livekit-server')),
    '/opt/homebrew/bin/livekit-server', '/usr/local/bin/livekit-server'].filter(Boolean);
  return candidates.find(file => existsSync(file)) ?? null;
}
