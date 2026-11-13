// Voice calls with companions, server half of the app's /rubato/call route (RubatoServiceRoute.ts).
// The call service the engine keeps (harness/companion/call-agent) owns calls and rings; this only
// passes the person's own actions through to its loopback control surface. Ringing the person is the
// companion's (call_user) and reporting speech is the call worker's, so neither is reachable here.
//
//   POST companions                   who can be called, and why not
//   POST live                         calls ringing or on now
//   POST calls { companion, since }   finished and live calls, with what was said
//   POST dial { companion, voice? }   the person calls: { call, url, room, token }
//   POST answer { callId }            take a ringing call: { call, url, room, token }; 409 if taken
//
// `url` is where the asking device reaches LiveKit: loopback for this Mac's own app, the tailnet
// address (call-agent remote.mjs) for a phone or another Mac that came in through Tailscale Serve.
// A remote device with no tailnet address yet gets 503 with the reason instead of a loopback URL.
//   POST decline { callId }           decline a ringing call
//   POST hangup { callId }            end a call
export const CALL_CONTROL = 'http://127.0.0.1:18790';

const ACTIONS = {
  companions: { method: 'GET', path: () => '/companions' },
  live: { method: 'GET', path: () => '/live' },
  calls: { method: 'GET', path: body => `/calls?${new URLSearchParams({
    ...(typeof body.companion === 'string' ? { companion: body.companion } : {}),
    ...(Number.isFinite(body.since) ? { since: String(body.since) } : {}) })}` },
  dial: { method: 'POST', path: () => '/dial', body: ({ companion, voice }) => ({ companion, voice }) },
  answer: { method: 'POST', path: () => '/answer', body: ({ callId }) => ({ callId }) },
  decline: { method: 'POST', path: () => '/decline', body: ({ callId }) => ({ callId }) },
  hangup: { method: 'POST', path: () => '/hangup', body: ({ callId }) => ({ callId }) },
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Whether the request came from another device: Tailscale Serve forwards with X-Forwarded-For, and a
 * direct request names this Mac by a non-loopback host.
 */
export function isRemoteRequest(request) {
  const headers = request.headers;
  if (headers.get('x-forwarded-for') || headers.get('tailscale-user-login')) return true;
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!host) return false;
  try { return !LOOPBACK.has(new URL(`http://${host}`).hostname); } catch { return false; }
}

/** A join answer as the asking device should use it; null `url` when a remote device cannot reach LiveKit. */
export function joinFor(value, remote) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') return value;
  const { remoteUrl = null, remoteReason = null, ...join } = value;
  if (!remote) return join;
  return remoteUrl ? { ...join, url: remoteUrl } : null;
}

export function createCallService({ base = process.env.RUBATO_CALL_CONTROL || CALL_CONTROL, fetch: call = globalThis.fetch } = {}) {
  return {
    async act(action, body = {}, { remote = false } = {}) {
      const spec = ACTIONS[action];
      if (!spec) return { status: 404, value: { error: { code: 'not-found', message: `Unknown call action: ${action}` } } };
      let response;
      try {
        // A device that could not join must not start or take the call first.
        if (remote && (action === 'dial' || action === 'answer')) {
          const reach = await (await call(`${base}/reach`)).json().catch(() => null);
          if (reach && !reach.remoteUrl) return { status: 503, value: { error: { code: 'call-unreachable',
            message: `This Mac's call audio is not reachable from this device: ${reach.remoteReason ?? 'no tailnet address'}.` } } };
        }
        response = await call(`${base}${spec.path(body)}`, { method: spec.method,
          ...(spec.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec.body(body)) } : {}) });
      } catch {
        return { status: 503, value: { error: { code: 'call-service-down', message: 'The call service is not running on this Mac.' } } };
      }
      const value = await response.json().catch(() => null);
      if (response.ok) {
        const join = joinFor(value, remote);
        if (join === null) return { status: 503, value: { error: { code: 'call-unreachable',
          message: `This Mac's call audio is not reachable from this device: ${value.remoteReason ?? 'no tailnet address'}.` } } };
        return { status: 200, value: join };
      }
      return { status: response.status, value: { error: { code: response.status === 409 ? 'conflict' : 'failed',
        message: value?.error ?? `The call service answered HTTP ${response.status}.` } } };
    },
  };
}

export async function handleCallRequest(service, request) {
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  if (request.method !== 'POST')
    return Response.json({ error: { code: 'method', message: 'Use POST.' } }, { status: 405 });
  const body = await request.json().catch(() => ({}));
  const { status, value } = await service.act(action, body && typeof body === 'object' ? body : {}, { remote: isRemoteRequest(request) });
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

let shared;
/** The instance the T3 server uses. */
export function callService() {
  shared ??= createCallService();
  return shared;
}
