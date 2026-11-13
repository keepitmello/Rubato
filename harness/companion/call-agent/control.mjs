// The call service's control surface, on loopback only. The app reaches it through its own
// authenticated route (/rubato/call, route.mjs); a companion's call tool and the call worker reach
// it directly. It owns the call log and hands out room tokens; LiveKit and the worker do the audio.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CallError, createCallLog } from './calls.mjs';
import { callableCompanions } from './companion.mjs';
import { roomToken } from './livekit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BODY_BYTES = 64 * 1024;

async function body(request) {
  let size = 0; const parts = [];
  for await (const part of request) {
    size += part.length;
    if (size > BODY_BYTES) throw new CallError('request body too large', 413);
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); }
  catch { throw new CallError('invalid JSON', 400); }
}

/**
 * `livekit`: { key, secret, url } of the running server. `log`: a call log (calls.mjs).
 * `companions`: lists who can be called (companion.mjs callableCompanions), injectable for tests.
 */
export function createControl({ livekit, log, companions = () => callableCompanions() }) {
  const callable = (id, voice) => {
    const target = companions().find(item => item.id === id);
    if (!target) throw new CallError(`unknown companion: ${id}`, 404);
    if (!target.ready) throw new CallError(target.reason, 422);
    if (voice && !target.voices?.some(item => item.id === voice && item.ready)) throw new CallError('voice not ready', 422);
    return target;
  };
  const join = async (call, extra = {}) => ({ call, url: livekit.url, room: call.id,
    token: await roomToken(livekit, call.id, { companion: call.companion, voice: call.voice, callId: call.id, ...extra }) });

  const routes = {
    'GET /companions': () => companions(),
    'GET /live': () => log.live(),
    'GET /calls': (_input, url) => log.history({ companion: url.searchParams.get('companion') ?? undefined,
      since: Number(url.searchParams.get('since') ?? 0) }),
    // The person calls a companion.
    'POST /dial': async ({ companion, voice }) => { callable(companion, voice); return join(log.dial({ companion, voice: voice ?? null })); },
    // A companion calls the person; answers once the ring ends with how it ended.
    'POST /ring': async ({ companion, reason }) => {
      callable(companion);
      const call = log.ring({ companion, reason: typeof reason === 'string' ? reason.slice(0, 500) : null });
      return log.outcome(call.id);
    },
    'POST /answer': async ({ callId }) => {
      const call = log.answer(callId);
      return join(call, { calledBy: 'companion', reason: call.reason });
    },
    'POST /decline': ({ callId }) => log.decline(callId),
    'POST /hangup': ({ callId }) => log.end(callId),
    // The worker's reports: what each side said, and that the call ended.
    'POST /event': ({ callId, type, text }) => {
      if (type === 'heard') return log.say(callId, 'me', text);
      if (type === 'said') return log.say(callId, 'companion', text);
      if (type === 'ended') return log.end(callId);
      throw new CallError(`unknown event: ${type}`, 400);
    },
  };

  async function handle(request, response) {
    const reply = (status, value, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    try {
      const url = new URL(request.url, 'http://local');
      // The test page and its client library, for trying a call without the app.
      if (request.method === 'GET' && url.pathname === '/') return reply(200, readFileSync(path.join(here, 'page', 'index.html')), 'text/html; charset=utf-8');
      if (request.method === 'GET' && url.pathname === '/livekit-client.mjs')
        return reply(200, readFileSync(path.join(here, 'node_modules', 'livekit-client', 'dist', 'livekit-client.esm.mjs')), 'text/javascript');
      const route = routes[`${request.method} ${url.pathname}`];
      if (!route) return reply(404, { error: 'not found' });
      const input = request.method === 'POST' ? await body(request) : {};
      reply(200, await route(input, url));
    } catch (error) {
      reply(error instanceof CallError ? error.status : 500, { error: error.message });
    }
  }
  return { handle, routes };
}

export function listen(control, { port, host = '127.0.0.1' }) {
  const server = createServer((request, response) => { void control.handle(request, response); });
  // A ring waits up to its full length before it answers.
  server.requestTimeout = 0;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

export { createCallLog };
