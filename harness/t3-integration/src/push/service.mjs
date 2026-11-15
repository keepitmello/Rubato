// Phone notifications, server half of the app's /rubato/push route (RubatoPush.ts). The Rubato app
// on a phone pairs its push with this Mac by handing over a grant it minted at the Rubato relay
// (harness/push-relay); the server then tells the phone when a thread needs it or is done.
//
//   POST register { relay, grant, grantId, deviceId, label?, preferences? }   keep this phone's grant
//   POST unregister { grantId }                       forget it (the phone also revokes it)
//   POST status                                       { phones: [{ grantId, deviceId, label, preferences, addedAt }], preview, telegram }
//   POST settings { preview: 'full' | 'generic' }     what the lock screen may show of a thread
//   POST preferences { deviceId, preferences }        { threads, companionMessages, companionCalls }, each on or off
//   POST telegram { enabled }                         companions' words to Telegram, for every companion here
//
// Three kinds reach a phone, each of which it can turn off here, before anything leaves this Mac:
//   thread             RubatoPush.ts feeds every thread's awareness state (upstream's
//                      projectThreadAwarenessV2) into threadChanged; a thread that starts needing the
//                      person, or finishes, becomes one alert, and it replaces that thread's earlier
//                      alert on the phone (collapseId), so a thread is one card showing where it is
//                      now, and every thread's card sits in one stack (THREAD_STACK). 'full' shows
//                      the thread title, the project and how long the run took, and the start of
//                      the agent's last answer (a failure: its error); 'generic' a fixed line. A
//                      finish of a run a companion opened (its session_send) is not one: the
//                      companion tells the person itself.
//   companion message  every reply or say of a companion (the items its room gets, rpc-connection.mjs),
//                      shown like a message; none while that companion is on a call with the person.
//   companion call     the call service's VoIP ring (push-relay/mac/sender.mjs).
// A companion's room is not a thread here: its runs never become thread alerts.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrantStore, PUSH_HOME } from '../../../push-relay/mac/grants.mjs';
import { inCall } from '../../../companion/call-window.mjs';
import { listCompanions } from '../../../companion/registry.mjs';
import { readMessengerSettings, writeMessengerSettings, messengerPaths } from '../../../companion/messenger/store.mjs';

/** An alert for something older than this is history (a replay after a restart), not news. */
export const FRESH_MS = 2 * 60_000;
/** A companion message shows this much of what was said; the room has the rest. */
export const MESSAGE_PREVIEW = 200;
/** A thread alert shows this much of the agent's last answer; the lock screen fits about four lines. */
export const REPLY_PREVIEW = 180;

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

/** Why a failed push went nowhere, beside the bridge's own log. */
function pushLog(message, detail) {
  try {
    const dir = path.join(os.homedir(), '.rubato-pi', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 't3-bridge.log'), `${new Date().toISOString()} push: ${message}${detail ? ` ${JSON.stringify(detail)}` : ''}\n`);
  } catch { /* ignore */ }
}

/** Whether a thread's new state is something to tell the person, given the phase this server last saw. */
export function isNews(state, previousPhase, now = Date.now()) {
  if (!state) return false;
  const { phase } = state;
  const news = (ATTENTION.has(phase) && previousPhase !== phase) || (TERMINAL.has(phase) && !TERMINAL.has(previousPhase));
  if (!news) return false;
  const updatedAt = Date.parse(state.updatedAt);
  return Number.isFinite(updatedAt) && now - updatedAt <= FRESH_MS;
}

/**
 * The start of an answer as plain words for a lock screen: markdown marks, code blocks and table
 * rows dropped, lines run together, cut at `max`. Empty when nothing is left.
 */
export function replySummary(text, max = REPLY_PREVIEW) {
  const words = String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split('\n')
    .filter(line => !/^\s*\|/.test(line) && !/^\s*([-*_]\s*){3,}$/.test(line))
    .map(line => line
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/(^|[\s(])[*_](\S[^*_]*?)[*_](?=[\s).,!?:;]|$)/g, '$1$2'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words;
}

/** How long a run took, short enough for a subtitle: 40s, 14m, 1h 5m. */
export function runLength(startedAt, endedAt) {
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`;
}

/**
 * Every thread alert sits in one stack on the phone (APNs thread-id), the way a messenger stacks one
 * chat; inside it each thread is one card (threadCollapseId). Companions stack one per companion.
 */
export const THREAD_STACK = 'rubato.threads';

/** One tag per thread, within APNs's 64 bytes: the phone keeps only the newest alert carrying it. */
export function threadCollapseId(environmentId, threadId) {
  return `thread:${createHash('sha256').update(`${environmentId}/${threadId}`).digest('base64url').slice(0, 40)}`;
}

/**
 * The alert one thread's new state deserves, given the phase this server last saw for it.
 * `run` is what the thread's shell knows of its latest run ({ startedAt, lastError }, RubatoPush.ts),
 * `reply` the agent's last answer in the thread; either may be missing.
 */
export function alertFor(state, previousPhase, { now = Date.now(), preview = 'full', run = null, reply = null } = {}) {
  if (!isNews(state, previousPhase, now)) return null;
  const { phase } = state;
  const text = preview === 'generic' ? { title: 'Rubato', body: GENERIC[phase] } : fullText(state, run, reply);
  return {
    kind: 'alert',
    ...text,
    threadId: THREAD_STACK,
    collapseId: threadCollapseId(state.environmentId, state.threadId),
    category: 'rubato.thread',
    rubato: { kind: 'thread' },
    data: { environmentId: state.environmentId, threadId: state.threadId, deepLink: state.deepLink },
  };
}

function fullText(state, run, reply) {
  const length = TERMINAL.has(state.phase) && run?.startedAt ? runLength(run.startedAt, state.updatedAt) : null;
  const subtitle = [state.projectTitle, length].filter(Boolean).join(' · ');
  const said = replySummary(reply);
  const body = state.phase === 'failed'
    ? `⚠︎ ${replySummary(String(run?.lastError ?? '').split('\n')[0]) || said || state.headline}`
    : state.phase === 'completed' ? said || state.headline : state.headline;
  return { title: state.threadTitle, ...(subtitle ? { subtitle } : {}), body };
}

/** What one thing a companion said becomes on the phone: its name, its words, its room. */
export function companionAlert({ companionId, title, text, threadId, environmentId }) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!words) return null;
  return {
    kind: 'alert',
    title: title || companionId,
    body: words.length > MESSAGE_PREVIEW ? `${words.slice(0, MESSAGE_PREVIEW - 1)}…` : words,
    threadId: `companion:${companionId}`,
    category: 'rubato.companion.message',
    mutableContent: true,
    rubato: { kind: 'companion-message', companionId, ...(threadId ? { threadId } : {}), ...(environmentId ? { environmentId } : {}) },
  };
}

/** Telegram delivery of companions' words, one switch over every companion that has a messenger here. */
export function createTelegramSwitch({ env = process.env } = {}) {
  const messengers = () => {
    let companions;
    try { companions = listCompanions(env); } catch { return []; }
    return companions.map(companion => ({ id: companion.id, env: { ...env, RUBATO_COMPANION_HOME: companion.home } }))
      .filter(companion => existsSync(messengerPaths(companion.env).home));
  };
  return {
    /** null when no companion here uses Telegram. */
    read() {
      const found = messengers();
      return found.length ? { enabled: found.every(item => readMessengerSettings(item.env).outbound) } : null;
    },
    write(enabled) {
      for (const item of messengers()) writeMessengerSettings({ outbound: enabled }, item.env);
      return this.read();
    },
  };
}

const registryTitle = (companionId) => {
  try { return listCompanions().find(companion => companion.id === companionId)?.title ?? companionId; }
  catch { return companionId; }
};

export function createPushService({ home = PUSH_HOME, log = pushLog, grants = createGrantStore({ home, log }), now = Date.now,
  onCall = inCall, telegram = createTelegramSwitch(), companionTitle = registryTitle } = {}) {
  const phases = new Map();
  /** Rooms of companions: threadId -> companion id. */
  const rooms = new Map();
  /** Who answers whether a thread's newest run is one a companion opened (the bridge, companionRuns). */
  const openers = new Set();
  const companionOpened = async (threadId) => {
    for (const answer of openers) {
      try { if (await answer(threadId) === true) return true; } catch { /* unknown counts as the person's */ }
    }
    return false;
  };
  /** Who answers with a thread's last agent answer (the bridge, threadReplies). */
  const readers = new Set();
  const lastReply = async (threadId) => {
    for (const read of readers) {
      try { const text = await read(threadId); if (typeof text === 'string' && text.trim()) return text; }
      catch (error) { log('last answer not read', { threadId, error: String(error?.message ?? error) }); }
    }
    return null;
  };
  const told = new Set();
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
    status: () => ({ phones: grants.list(), preview: readPreview(), telegram: telegram.read() }),
    preferences({ deviceId, preferences }) {
      if (typeof deviceId !== 'string' || !preferences || typeof preferences !== 'object')
        throw new PushRequestError(400, 'invalid', 'deviceId and preferences are required');
      const saved = grants.setPreferences(deviceId, preferences);
      if (!saved) throw new PushRequestError(404, 'not-paired', 'This phone is not paired for push with this Mac yet.');
      return { preferences: saved };
    },
    telegram({ enabled }) {
      if (typeof enabled !== 'boolean') throw new PushRequestError(400, 'invalid', 'enabled must be true or false');
      return { telegram: telegram.write(enabled) };
    },
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
     * archived, deleted). `run`: { startedAt, lastError } of its latest run, when the server has
     * them. Resolves with the delivery results when an alert went out.
     */
    async threadChanged(threadId, state, run = null) {
      if (rooms.has(threadId)) return null;
      const previous = phases.get(threadId);
      phases.set(threadId, state?.phase ?? null);
      const at = now();
      if (!isNews(state, previous, at)) return null;
      // A run a companion opened ends in the companion's own words (companionSaid). An ask for
      // approval or an answer still comes: only the person can give it.
      if (TERMINAL.has(state.phase) && await companionOpened(threadId)) return null;
      const preview = readPreview();
      const reply = preview === 'full' && TERMINAL.has(state.phase) ? await lastReply(threadId) : null;
      return grants.pushAll(alertFor(state, previous, { now: at, preview, run, reply }), { preference: 'threads' });
    },
    /**
     * `answer(threadId)` resolves true when the thread's newest run is one a companion opened, not
     * the person. Returns the call that takes the answer back.
     */
    companionRuns(answer) {
      if (typeof answer !== 'function') return () => {};
      openers.add(answer);
      return () => openers.delete(answer);
    },
    /**
     * `read(threadId)` resolves with the text of the thread's last agent answer, or null. Returns the
     * call that takes the reader back.
     */
    threadReplies(read) {
      if (typeof read !== 'function') return () => {};
      readers.add(read);
      return () => readers.delete(read);
    },
    /** A thread is a companion's room: its runs are not thread alerts, its words are messages. */
    companionRoom(threadId, companionId) {
      if (typeof threadId === 'string' && typeof companionId === 'string') rooms.set(threadId, companionId);
    },
    /**
     * Something a companion said reached its room (`id` once per thing said, `at` when it was
     * said). Resolves with the delivery results, or null when nothing went out.
     */
    async companionSaid({ id, threadId, companionId = rooms.get(threadId), title, text, at = now(), environmentId }) {
      if (!companionId || !id || told.has(id)) return null;
      told.add(id);
      if (told.size > 500) told.delete(told.values().next().value);
      // The call card has what was said on a call.
      if (onCall(companionId, at)) return null;
      const alert = companionAlert({ companionId, title: title ?? companionTitle(companionId), text, threadId, environmentId });
      return alert ? grants.pushAll(alert, { preference: 'companionMessages' }) : null;
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
