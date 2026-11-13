// The relay's HTTP surface. Two kinds of caller, two credentials:
//
//   phone  ── device secret ──▶ register its tokens, mint and revoke grants
//   Mac    ── grant         ──▶ push to the one phone that minted it
//
// A phone mints a grant for each Mac it pairs with and hands it over the paired, authenticated
// connection; a Mac holding no grant for a phone cannot push to it. The phone's APNs and VoIP
// tokens go only to the relay, never to a Mac. The relay stores hashes of both secrets, the
// tokens, and nothing about what it pushed.
//
//   POST   /v1/devices                       { bundleId, environment, apnsToken?, voipToken? } → { deviceId, deviceSecret }
//   PUT    /v1/devices/:id          (phone)  { apnsToken?, voipToken? }   null clears a token
//   DELETE /v1/devices/:id          (phone)  forget the phone and every grant it made
//   POST   /v1/devices/:id/grants   (phone)  { label? } → { grantId, grant }
//   GET    /v1/devices/:id/grants   (phone)  → { grants: [{ grantId, label, createdAt, lastUsedAt }] }
//   DELETE /v1/devices/:id/grants/:grantId   (phone)
//   POST   /v1/push                 (Mac)    { kind: 'alert', title, body, threadId?, data?, rubato?, category?, mutableContent? }
//                                            { kind: 'call.ring', callId, uuid, companion, title, reason?, ringUntil }
//   GET    /v1/health                        → { ok, configured }
import { alertPayload, apnsRequest, base64url, PROVIDER_TOKEN_TTL_S, providerTokenIsStale, ringPayload, signProviderToken, tokenIsDead } from './apns.mjs';

const MAX_BODY = 8 * 1024;
const MAX_GRANTS_PER_DEVICE = 20;
const MAX_PAYLOAD = { alert: 4096, voip: 5120 };
const TOKEN = /^[0-9a-f]{64,200}$/i;

class HttpError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64url(new Uint8Array(digest));
}

function secret(prefix) {
  return `${prefix}_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function bearer(request) {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) throw new HttpError(401, 'unauthorized');
  return match[1];
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'too-large');
  try {
    const value = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'invalid-json'); }
}

function text(value, name, max, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'invalid', `${name} is required`);
  return value.trim().slice(0, max);
}

function token(value, name) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new HttpError(400, 'invalid', `${name} is not an APNs token`);
  return value.toLowerCase();
}

/** Flat string fields an alert carries to the app, e.g. environmentId, threadId, deepLink. */
function alertData(value, name = 'data') {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid', `${name} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > 8) throw new HttpError(400, 'invalid', 'data has too many fields');
  return Object.fromEntries(entries.map(([key, item]) => {
    if (key === 'aps' || key === 'rubato' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key) || typeof item !== 'string' || item.length > 512)
      throw new HttpError(400, 'invalid', `${name}.${key} is not allowed`);
    return [key, item];
  }));
}

/** The app's own notification categories only. */
function category(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^rubato\.[a-z][a-z.-]{0,47}$/.test(value)) throw new HttpError(400, 'invalid', 'category is not one of the app\'s');
  return value;
}

/**
 * `env`: DB (D1), APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY (secret), BUNDLE_IDS (comma list),
 * optional PUSH_LIMIT and REGISTER_LIMIT rate limiters. `fetch` reaches APNs; `now` is injectable for tests.
 */
export function createRelay(env, { fetch: send = globalThis.fetch, now = Date.now } = {}) {
  const db = env.DB;
  const bundles = new Set(String(env.BUNDLE_IDS ?? '').split(',').map(item => item.trim()).filter(Boolean));
  const configured = () => Boolean(env.APNS_TEAM_ID && env.APNS_KEY_ID && env.APNS_PRIVATE_KEY);

  async function limited(limiter, key) {
    if (!limiter) return;
    const { success } = await limiter.limit({ key });
    if (!success) throw new HttpError(429, 'rate-limited');
  }

  async function device(request, id) {
    const presented = bearer(request);
    const row = await db.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first();
    if (!row || row.secret_hash !== await sha256(presented)) throw new HttpError(401, 'unauthorized');
    return row;
  }

  // A token belongs to one phone. Re-registering it (a reinstall, a restored backup) moves it, and
  // that is safe because only the phone and the relay ever see it.
  async function setTokens(id, { apnsToken, voipToken }) {
    const statements = [];
    if (apnsToken) statements.push(db.prepare('UPDATE devices SET apns_token = NULL WHERE apns_token = ? AND id <> ?').bind(apnsToken, id));
    if (voipToken) statements.push(db.prepare('UPDATE devices SET voip_token = NULL WHERE voip_token = ? AND id <> ?').bind(voipToken, id));
    if (apnsToken !== undefined) statements.push(db.prepare('UPDATE devices SET apns_token = ?, updated_at = ? WHERE id = ?').bind(apnsToken, now(), id));
    if (voipToken !== undefined) statements.push(db.prepare('UPDATE devices SET voip_token = ?, updated_at = ? WHERE id = ?').bind(voipToken, now(), id));
    if (statements.length) await db.batch(statements);
  }

  async function providerToken({ fresh = false } = {}) {
    const issuedNow = Math.floor(now() / 1000);
    if (!fresh) {
      const cached = await db.prepare('SELECT issued_at, jwt FROM provider_tokens WHERE key_id = ?').bind(env.APNS_KEY_ID).first();
      if (cached && issuedNow - cached.issued_at < PROVIDER_TOKEN_TTL_S) return cached.jwt;
    }
    const jwt = await signProviderToken({ teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID, privateKey: env.APNS_PRIVATE_KEY, issuedAt: issuedNow });
    await db.prepare('INSERT INTO provider_tokens (key_id, issued_at, jwt) VALUES (?, ?, ?) ON CONFLICT (key_id) DO UPDATE SET issued_at = excluded.issued_at, jwt = excluded.jwt')
      .bind(env.APNS_KEY_ID, issuedNow, jwt).run();
    return jwt;
  }

  async function deliver(row, kind, payload, expiration) {
    const deviceToken = kind === 'voip' ? row.voip_token : row.apns_token;
    if (!deviceToken) return { ok: false, reason: kind === 'voip' ? 'no-voip-token' : 'no-apns-token' };
    if (JSON.stringify(payload).length > MAX_PAYLOAD[kind]) throw new HttpError(413, 'payload-too-large');
    const attempt = async jwt => {
      const { url, init } = apnsRequest({ environment: row.environment, bundleId: row.bundle_id, token: deviceToken, kind, payload, jwt, expiration });
      const response = await send(url, init);
      const reason = response.ok ? null : (await response.json().catch(() => null))?.reason ?? null;
      return { status: response.status, reason, apnsId: response.headers.get('apns-id') };
    };
    let result = await attempt(await providerToken());
    if (providerTokenIsStale(result.status, result.reason)) result = await attempt(await providerToken({ fresh: true }));
    if (result.status >= 200 && result.status < 300) return { ok: true, apnsId: result.apnsId };
    if (tokenIsDead(result.status, result.reason)) {
      const column = kind === 'voip' ? 'voip_token' : 'apns_token';
      await db.prepare(`UPDATE devices SET ${column} = NULL, updated_at = ? WHERE id = ? AND ${column} = ?`).bind(now(), row.id, deviceToken).run();
      return { ok: false, reason: 'token-unregistered', apnsStatus: result.status, apnsReason: result.reason };
    }
    if (result.status === 429 || result.status >= 500) throw new HttpError(502, 'apns-unavailable', result.reason ?? `APNs ${result.status}`);
    return { ok: false, reason: result.reason ?? `apns-${result.status}` };
  }

  async function push(request) {
    if (!configured()) throw new HttpError(503, 'not-configured');
    const grantHash = await sha256(bearer(request));
    const grant = await db.prepare('SELECT * FROM grants WHERE token_hash = ?').bind(grantHash).first();
    // The phone revoked it, or forgot itself: the Mac should drop the grant.
    if (!grant) throw new HttpError(410, 'grant-revoked');
    await limited(env.PUSH_LIMIT, grant.id);
    const row = await db.prepare('SELECT * FROM devices WHERE id = ?').bind(grant.device_id).first();
    if (!row) throw new HttpError(410, 'grant-revoked');
    const body = await readJson(request);
    let result;
    if (body.kind === 'alert') {
      const payload = alertPayload({ title: text(body.title, 'title', 120), body: text(body.body, 'body', 300),
        threadId: text(body.threadId, 'threadId', 128, { optional: true }), data: alertData(body.data),
        rubato: body.rubato === undefined || body.rubato === null ? null : alertData(body.rubato, 'rubato'),
        category: category(body.category), mutableContent: body.mutableContent === true });
      result = await deliver(row, 'alert', payload);
    } else if (body.kind === 'call.ring') {
      const ringUntil = Number(body.ringUntil);
      if (!Number.isFinite(ringUntil)) throw new HttpError(400, 'invalid', 'ringUntil is required');
      if (ringUntil <= now()) return json({ ok: false, reason: 'ring-over' });
      const payload = ringPayload({ callId: text(body.callId, 'callId', 128), uuid: text(body.uuid, 'uuid', 64),
        companion: text(body.companion, 'companion', 64), title: text(body.title, 'title', 80),
        reason: text(body.reason, 'reason', 300, { optional: true }), ringUntil });
      result = await deliver(row, 'voip', payload, Math.ceil(ringUntil / 1000));
    } else {
      throw new HttpError(400, 'invalid', 'unknown kind');
    }
    await db.prepare('UPDATE grants SET last_used_at = ? WHERE id = ?').bind(now(), grant.id).run();
    return json(result);
  }

  async function register(request) {
    await limited(env.REGISTER_LIMIT, request.headers.get('cf-connecting-ip') ?? 'unknown');
    const body = await readJson(request);
    const bundleId = text(body.bundleId, 'bundleId', 128);
    if (!bundles.has(bundleId)) throw new HttpError(403, 'unknown-app');
    if (!['sandbox', 'production'].includes(body.environment)) throw new HttpError(400, 'invalid', 'environment must be sandbox or production');
    const tokens = { apnsToken: token(body.apnsToken, 'apnsToken'), voipToken: token(body.voipToken, 'voipToken') };
    const deviceId = crypto.randomUUID();
    const deviceSecret = secret('rpd');
    await db.prepare('INSERT INTO devices (id, secret_hash, bundle_id, environment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(deviceId, await sha256(deviceSecret), bundleId, body.environment, now(), now()).run();
    await setTokens(deviceId, tokens);
    return json({ deviceId, deviceSecret }, 201);
  }

  async function update(request, id) {
    await device(request, id);
    const body = await readJson(request);
    await setTokens(id, { apnsToken: token(body.apnsToken, 'apnsToken'), voipToken: token(body.voipToken, 'voipToken') });
    return json({ ok: true });
  }

  async function forget(request, id) {
    await device(request, id);
    await db.batch([db.prepare('DELETE FROM grants WHERE device_id = ?').bind(id), db.prepare('DELETE FROM devices WHERE id = ?').bind(id)]);
    return json({ ok: true });
  }

  async function mint(request, id) {
    await device(request, id);
    const body = await readJson(request);
    const { count } = await db.prepare('SELECT COUNT(*) AS count FROM grants WHERE device_id = ?').bind(id).first();
    if (count >= MAX_GRANTS_PER_DEVICE) throw new HttpError(409, 'too-many-grants');
    const grantId = crypto.randomUUID();
    const grant = secret('rpg');
    await db.prepare('INSERT INTO grants (id, device_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(grantId, id, await sha256(grant), text(body.label, 'label', 80, { optional: true }), now()).run();
    return json({ grantId, grant }, 201);
  }

  async function list(request, id) {
    await device(request, id);
    const { results } = await db.prepare('SELECT id, label, created_at, last_used_at FROM grants WHERE device_id = ? ORDER BY created_at').bind(id).all();
    return json({ grants: results.map(row => ({ grantId: row.id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at })) });
  }

  async function revoke(request, id, grantId) {
    await device(request, id);
    await db.prepare('DELETE FROM grants WHERE id = ? AND device_id = ?').bind(grantId, id).run();
    return json({ ok: true });
  }

  return async function handle(request) {
    try {
      const { pathname } = new URL(request.url);
      const parts = pathname.split('/').filter(Boolean);
      const method = request.method;
      if (parts[0] !== 'v1') throw new HttpError(404, 'not-found');
      if (parts.length === 2 && parts[1] === 'health' && method === 'GET') return json({ ok: true, configured: configured() });
      if (parts.length === 2 && parts[1] === 'push' && method === 'POST') return await push(request);
      if (parts[1] === 'devices') {
        const [, , id, sub, grantId] = parts;
        if (parts.length === 2 && method === 'POST') return await register(request);
        if (parts.length === 3 && method === 'PUT') return await update(request, id);
        if (parts.length === 3 && method === 'DELETE') return await forget(request, id);
        if (parts.length === 4 && sub === 'grants' && method === 'POST') return await mint(request, id);
        if (parts.length === 4 && sub === 'grants' && method === 'GET') return await list(request, id);
        if (parts.length === 5 && sub === 'grants' && method === 'DELETE') return await revoke(request, id, grantId);
      }
      throw new HttpError(404, 'not-found');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
      // Never echo an internal error: it could carry key or token material.
      console.error('relay error', error?.name ?? 'Error');
      return json({ error: 'internal' }, 500);
    }
  };
}
