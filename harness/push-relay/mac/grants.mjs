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

/**
 * What a phone can turn off, each on its own: a Mac sends nothing of a kind its phone turned off.
 * `liveActivity` is the lock-screen and Dynamic Island card of this Mac's running threads.
 */
export const PUSH_KINDS = Object.freeze(['threads', 'companionThreads', 'companionMessages', 'companionCalls', 'liveActivity']);

/** Answers that are no failure: the phone has no card open for this Mac right now. */
const QUIET = new Set(['no-activity']);

/** A phone's choices. Companion work was silent by default before it got its own switch. */
export function normalizePreferences(value, base = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const preferences = Object.fromEntries(PUSH_KINDS.map(kind => [kind,
    typeof input[kind] === 'boolean' ? input[kind] : typeof base[kind] === 'boolean' ? base[kind] : kind !== 'companionThreads']));
  const soundChoices = ['mac', 'default', 'builtin:completion', 'builtin:input'];
  for (const key of ['threadSound', 'companionMessageSound']) {
    if (soundChoices.includes(input[key])) preferences[key] = input[key];
    else if (soundChoices.includes(base[key])) preferences[key] = base[key];
  }
  return preferences;
}

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
    list: () => read().map(({ grant: _grant, ...rest }) => ({ ...rest, preferences: normalizePreferences(rest.preferences) })),
    /** A phone hands this Mac a grant; a newer one from the same phone replaces the old. */
    add({ relay, grant, grantId, deviceId, label, preferences }) {
      const origin = validRelay(relay);
      if (!origin) throw new TypeError('relay must be an https URL');
      for (const [name, value] of Object.entries({ grant, grantId, deviceId }))
        if (typeof value !== 'string' || !value || value.length > 200) throw new TypeError(`${name} is required`);
      const previous = read().find(item => item.deviceId === deviceId);
      const entry = { relay: origin, grant, grantId, deviceId, label: typeof label === 'string' ? label.slice(0, 80) : null,
        preferences: normalizePreferences(preferences, previous?.preferences), addedAt: Date.now() };
      write([...read().filter(item => item.deviceId !== deviceId), entry]);
      return { grantId, deviceId, label: entry.label, preferences: entry.preferences };
    },
    /** A phone changes which kinds it wants from this Mac. */
    setPreferences(deviceId, preferences) {
      const grants = read();
      const entry = grants.find(item => item.deviceId === deviceId);
      if (!entry) return null;
      entry.preferences = normalizePreferences(preferences, entry.preferences);
      write(grants);
      return entry.preferences;
    },
    remove,
    /**
     * Send one message to every paired phone that wants its kind (`preference`, one of PUSH_KINDS). Never
     * throws: a phone that cannot be reached is reported, a grant the relay says is revoked is dropped.
     */
    async pushAll(message, { preference, soundOverride } = {}) {
      if (!PUSH_KINDS.includes(preference)) throw new TypeError(`preference must be one of ${PUSH_KINDS.join(', ')}`);
      const wanted = read().map(entry => ({ ...entry, preferences: normalizePreferences(entry.preferences) }))
        .filter(entry => entry.preferences[preference]);
      const results = await Promise.all(wanted.map(async entry => {
        try {
          const sound = soundOverride?.(entry.preferences);
          const response = await send(`${entry.relay}/v1/push`, {
            method: 'POST',
            headers: { authorization: `Bearer ${entry.grant}`, 'content-type': 'application/json' },
            body: JSON.stringify(sound ? { ...message, sound } : message),
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
      const failed = results.filter(item => !item.ok && !QUIET.has(item.reason));
      if (failed.length) log('push not delivered', { kind: message.kind, failed: failed.map(item => item.reason) });
      return results;
    },
  };
}
