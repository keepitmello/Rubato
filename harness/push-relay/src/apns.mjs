// Talking to APNs: the provider token signed with the relay's key, and the request for each kind of
// push. Only this module reads the key, and only to sign; it never leaves the function that signs.

const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };

/** APNs accepts a provider token for an hour and refuses one refreshed more often than every 20 minutes. */
export const PROVIDER_TOKEN_TTL_S = 45 * 60;

const encoder = new TextEncoder();

export function base64url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemBody(pem) {
  const text = String(pem).replace(/\\n/g, '\n');
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(text);
  if (!match) throw new Error('APNs key is not a PKCS#8 PEM');
  const binary = atob(match[1].replace(/\s+/g, ''));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** ES256 JWT for APNs: `{ alg, kid }` . `{ iss: team, iat }`. WebCrypto signs P-256 as raw r||s, as JWS wants. */
export async function signProviderToken({ teamId, keyId, privateKey, issuedAt }) {
  const key = await crypto.subtle.importKey('pkcs8', pemBody(privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = base64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: keyId })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: teamId, iat: issuedAt })));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${head}.${claims}`));
  return `${head}.${claims}.${base64url(new Uint8Array(signature))}`;
}

/**
 * An alert on the lock screen. `data` lands at the top level (upstream's thread navigation reads it
 * there), `rubato` under its own key; `category` picks the app's notification category, and
 * `mutableContent` lets the app's service extension redraw it (a companion message as a message).
 */
export function alertPayload({ title, body, threadId, data = {}, rubato = null, category = null, mutableContent = false }) {
  return {
    ...data,
    ...(rubato ? { rubato } : {}),
    aps: {
      alert: { title, body },
      sound: 'default',
      ...(threadId ? { 'thread-id': threadId } : {}),
      ...(category ? { category } : {}),
      ...(mutableContent ? { 'mutable-content': 1 } : {}),
    },
  };
}

/** A companion ringing: the app must report it to CallKit, so the payload carries everything the ring shows. */
export function ringPayload({ callId, uuid, companion, title, reason, ringUntil }) {
  return { rubato: { kind: 'call.ring', callId, uuid, companion, title, reason: reason ?? null, ringUntil } };
}

/**
 * The HTTP/2 request APNs expects. `kind` is 'alert' or 'voip'; a VoIP push goes to `<bundle>.voip` and
 * expires when the ring would end, so a phone that comes online late does not ring for a finished call.
 */
export function apnsRequest({ environment, bundleId, token, kind, payload, jwt, expiration = 0 }) {
  const host = HOSTS[environment];
  if (!host) throw new Error(`unknown APNs environment: ${environment}`);
  const voip = kind === 'voip';
  return {
    url: `${host}/3/device/${token}`,
    init: {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': voip ? `${bundleId}.voip` : bundleId,
        'apns-push-type': voip ? 'voip' : 'alert',
        'apns-priority': '10',
        'apns-expiration': String(expiration),
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  };
}

/** APNs answers that mean the token is dead for this app, so the relay forgets it. */
export function tokenIsDead(status, reason) {
  return status === 410 || (status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason));
}

/** APNs answers that mean the provider token must be signed again. */
export function providerTokenIsStale(status, reason) {
  return status === 403 && ['ExpiredProviderToken', 'InvalidProviderToken'].includes(reason);
}
