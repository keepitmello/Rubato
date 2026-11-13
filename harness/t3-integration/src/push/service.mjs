// Phone notifications, server half of the app's /rubato/push route (RubatoPush.ts). The Rubato app
// on a phone pairs its push with this Mac by handing over a grant it minted at the Rubato relay
// (harness/push-relay); the server then tells the phone when a thread needs it or is done.
//
//   POST register { relay, grant, grantId, deviceId, label? }   keep this phone's grant
//   POST unregister { grantId }                                 forget it (the phone also revokes it)
//   POST status                                                 { phones: [{ grantId, deviceId, label, addedAt }], preview }
//   POST settings { preview: 'full' | 'generic' }               what the lock screen may show
//
// RubatoPush.ts feeds every thread's awareness state (upstream's projectThreadAwarenessV2) into
// threadChanged; a thread that starts needing the person, or finishes, becomes one alert. 'full'
// shows the thread and project titles as T3's relay did; 'generic' sends a fixed line and the app
// shows the rest from this Mac once opened.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createGrantStore, PUSH_HOME } from '../../../push-relay/mac/grants.mjs';

/** An alert for something older than this is history (a replay after a restart), not news. */
export const FRESH_MS = 2 * 60_000;

const ATTENTION = new Set(['waiting_for_approval', 'waiting_for_input']);
const TERMINAL = new Set(['completed', 'failed']);
const GENERIC = {
  waiting_for_approval: 'A thread needs your approval',
  waiting_for_input: 'A thread is waiting for your answer',
  completed: 'A thread finished',
  failed: 'A thread failed',
};

export class PushRequestError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** The alert one thread's new state deserves, given the phase this server last saw for it. */
export function alertFor(state, previousPhase, { now = Date.now(), preview = 'full' } = {}) {
  if (!state) return null;
  const { phase } = state;
  const news = (ATTENTION.has(phase) && previousPhase !== phase) || (TERMINAL.has(phase) && !TERMINAL.has(previousPhase));
  if (!news) return null;
  const updatedAt = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAt) || now - updatedAt > FRESH_MS) return null;
  const text = preview === 'generic'
    ? { title: 'Rubato', body: GENERIC[phase] }
    : { title: state.threadTitle, body: `${state.headline}: ${state.projectTitle}` };
  return {
    kind: 'alert',
    ...text,
    threadId: `${state.environmentId}/${state.threadId}`,
    data: { environmentId: state.environmentId, threadId: state.threadId, deepLink: state.deepLink },
  };
}

export function createPushService({ home = PUSH_HOME, grants = createGrantStore({ home }), now = Date.now } = {}) {
  const phases = new Map();
  const settingsFile = path.join(home, 'settings.json');
  const readPreview = () => {
    try { return JSON.parse(readFileSync(settingsFile, 'utf8')).preview === 'generic' ? 'generic' : 'full'; }
    catch { return 'full'; }
  };
  const writePreview = preview => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const temporary = `${settingsFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ preview }) + '\n', { mode: 0o600 });
    renameSync(temporary, settingsFile);
  };

  const actions = {
    register(body) {
      try { return grants.add(body); }
      catch (error) { throw new PushRequestError(400, 'invalid', error.message); }
    },
    unregister({ grantId }) {
      if (typeof grantId !== 'string') throw new PushRequestError(400, 'invalid', 'grantId is required');
      return { removed: grants.remove(grantId) };
    },
    status: () => ({ phones: grants.list(), preview: readPreview() }),
    settings({ preview }) {
      if (preview !== 'full' && preview !== 'generic') throw new PushRequestError(400, 'invalid', 'preview must be full or generic');
      writePreview(preview);
      return { preview };
    },
  };

  return {
    async act(action, body) {
      const run = actions[action];
      if (!run) throw new PushRequestError(404, 'not-found', `Unknown push action: ${action}`);
      return run(body);
    },
    /**
     * One thread's awareness state after a relevant event; null when the thread has none (idle,
     * archived, deleted). Resolves with the delivery results when an alert went out.
     */
    async threadChanged(threadId, state) {
      const previous = phases.get(threadId);
      phases.set(threadId, state?.phase ?? null);
      const alert = alertFor(state, previous, { now: now(), preview: readPreview() });
      return alert ? grants.pushAll(alert) : null;
    },
  };
}

export async function handlePushRequest(service, request) {
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  if (request.method !== 'POST')
    return Response.json({ error: { code: 'method', message: 'Use POST.' } }, { status: 405 });
  const body = await request.json().catch(() => ({}));
  try {
    const value = await service.act(action, body && typeof body === 'object' ? body : {});
    return Response.json(value, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (!(error instanceof PushRequestError)) throw error;
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
}

let shared;
/** The instance the T3 server uses. */
export function pushService() {
  shared ??= createPushService();
  return shared;
}
