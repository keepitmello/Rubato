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

export function createCallService({ base = process.env.RUBATO_CALL_CONTROL || CALL_CONTROL, fetch: call = globalThis.fetch } = {}) {
  return {
    async act(action, body = {}) {
      const spec = ACTIONS[action];
      if (!spec) return { status: 404, value: { error: { code: 'not-found', message: `Unknown call action: ${action}` } } };
      let response;
      try {
        response = await call(`${base}${spec.path(body)}`, { method: spec.method,
          ...(spec.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec.body(body)) } : {}) });
      } catch {
        return { status: 503, value: { error: { code: 'call-service-down', message: 'The call service is not running on this Mac.' } } };
      }
      const value = await response.json().catch(() => null);
      if (response.ok) return { status: 200, value };
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
  const { status, value } = await service.act(action, body && typeof body === 'object' ? body : {});
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

let shared;
/** The instance the T3 server uses. */
export function callService() {
  shared ??= createCallService();
  return shared;
}
