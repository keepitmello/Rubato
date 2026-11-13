// This Mac's push grants: one per paired phone, each the right to push to that phone through the
// Rubato relay (../src/relay.mjs). The phone mints it and hands it over its authenticated connection
// (t3-integration/src/push/service.mjs); the GUI server's thread alerts and the call service's rings
// both send with it. The phone's APNs tokens never come here.
//
// One file, ~/.rubato/push/grants.json (0600), read on every send so both processes see the same set.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PUSH_HOME = process.env.RUBATO_PUSH_HOME ?? path.join(os.homedir(), '.rubato', 'push');
const SEND_TIMEOUT_MS = 10_000;

/** A relay must be HTTPS; plain HTTP only on this machine, for tests and a local relay. */
export function validRelay(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

export function createGrantStore({ home = PUSH_HOME, fetch: send = globalThis.fetch, log = () => {} } = {}) {
  const file = path.join(home, 'grants.json');

  function read() {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(value?.grants) ? value.grants : [];
    } catch { return []; }
  }
  function write(grants) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ grants }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  }

  function remove(grantId) {
    const grants = read();
    const left = grants.filter(item => item.grantId !== grantId);
    if (left.length !== grants.length) write(left);
    return grants.length - left.length;
  }

  return {
    /** Paired phones, without their grants. */
    list: () => read().map(({ grant: _grant, ...rest }) => rest),
    /** A phone hands this Mac a grant; a newer one from the same phone replaces the old. */
    add({ relay, grant, grantId, deviceId, label }) {
      const origin = validRelay(relay);
      if (!origin) throw new TypeError('relay must be an https URL');
      for (const [name, value] of Object.entries({ grant, grantId, deviceId }))
        if (typeof value !== 'string' || !value || value.length > 200) throw new TypeError(`${name} is required`);
      const entry = { relay: origin, grant, grantId, deviceId, label: typeof label === 'string' ? label.slice(0, 80) : null, addedAt: Date.now() };
      write([...read().filter(item => item.deviceId !== deviceId), entry]);
      return { grantId, deviceId, label: entry.label };
    },
    remove,
    /**
     * Send one message to every paired phone. Never throws: a phone that cannot be reached is
     * reported, a grant the relay says is revoked is dropped.
     */
    async pushAll(message) {
      const results = await Promise.all(read().map(async entry => {
        try {
          const response = await send(`${entry.relay}/v1/push`, {
            method: 'POST',
            headers: { authorization: `Bearer ${entry.grant}`, 'content-type': 'application/json' },
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
          const value = await response.json().catch(() => null);
          if (response.status === 410) {
            remove(entry.grantId);
            log('push grant revoked by the phone', { label: entry.label });
            return { deviceId: entry.deviceId, ok: false, reason: 'grant-revoked' };
          }
          if (!response.ok) return { deviceId: entry.deviceId, ok: false, reason: value?.error ?? `relay-${response.status}` };
          return { deviceId: entry.deviceId, ok: Boolean(value?.ok), ...(value?.ok ? {} : { reason: value?.reason ?? 'unknown' }) };
        } catch (error) {
          return { deviceId: entry.deviceId, ok: false, reason: error?.name === 'TimeoutError' ? 'relay-timeout' : 'relay-unreachable' };
        }
      }));
      const failed = results.filter(item => !item.ok);
      if (failed.length) log('push not delivered', { kind: message.kind, failed: failed.map(item => item.reason) });
      return results;
    },
  };
}
