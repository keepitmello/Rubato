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
//   POST sounds                                       { sounds: [{ kind, id, file }] } the chimes the desktop plays,
//                                                     and the file names thread alerts ask the phone to play
//   POST activity                                     { state } what this Mac's Live Activity card shows now, or null
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
//
// A thread alert rings with the chime the desktop plays for it (Settings > General > Behavior, in the
// desktop's client-settings.json): the finish chime for a finish or failure, the input chime when it
// needs the person. The phone keeps those chimes as files (rubato-push/sounds.ts) and the alert names one.
//
// Live Activity: the phone opens one card per Mac on its lock screen and Dynamic Island while it is in
// front (rubato-push/liveActivity.ts) and hands the card's token to the relay. This Mac keeps the card
// current with every thread's state (activityCard, the summary upstream's relay makes for the T3 app)
// and ends it when nothing runs any more.
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

/** A run changes in bursts; the card waits this long for the burst to settle before it goes out. */
export const ACTIVITY_SETTLE_MS = 1500;
/** The relay dims a card after 10 minutes without news (ACTIVITY_STALE_S); while work runs it hears sooner. */
export const ACTIVITY_REFRESH_MS = 8 * 60_000;
/** The card's rows: the lock screen shows up to five, the expanded Dynamic Island three. */
export const ACTIVITY_ROWS = 5;
/** A finished thread keeps its Done or Failed row this long while others still run. */
export const ACTIVITY_DONE_MS = 15 * 60_000;
/** APNs carries 4 KB for a card, the props travel as a JSON string inside JSON: rows go before that. */
const ACTIVITY_MAX_BYTES = 3000;
// A thread whose Mac died mid-run never reports an end; running rows expire, waiting ones last longer.
const ACTIVITY_RUNNING_TTL_MS = 2 * 60 * 60_000;
const ACTIVITY_WAITING_TTL_MS = 24 * 60 * 60_000;

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

/** Where the desktop app keeps its own settings, among them the chimes it plays (start-gui.sh's T3CODE_HOME). */
export function desktopSettingsFile(env = process.env) {
  return path.join(env.T3CODE_HOME || path.join(os.homedir(), '.rubato', 't3-home'), 'userdata', 'client-settings.json');
}

const SOUND_ID = /^(builtin:(completion|input)|mac:(system|local|user)\/[^/]+)$/;
const DEFAULT_SOUNDS = { completion: 'builtin:completion', input: 'builtin:input' };

/** The chimes the desktop plays: { completion, input }, each a sound id of rubatoNotificationSounds.ts. */
export function readDesktopSounds(file = desktopSettingsFile()) {
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { /* the desktop's defaults */ }
  const pick = (value, fallback) => (typeof value === 'string' && SOUND_ID.test(value) ? value : fallback);
  return {
    completion: pick(settings.notificationCompletionSound, DEFAULT_SOUNDS.completion),
    input: pick(settings.notificationInputSound, DEFAULT_SOUNDS.input),
  };
}

/** The file a sound id is on the phone, in its Library/Sounds (rubato-push/sounds.ts writes the same names). */
export function phoneSoundFile(id) {
  if (id === 'builtin:completion') return 'rubato-completion.caf';
  if (id === 'builtin:input') return 'rubato-input.caf';
  if (typeof id === 'string' && SOUND_ID.test(id)) return `rubato-mac-${createHash('sha256').update(id).digest('hex').slice(0, 12)}.caf`;
  return null;
}

const ACTIVITY_STATUS = {
  waiting_for_approval: 'Approval', waiting_for_input: 'Input', completed: 'Done', failed: 'Failed',
  starting: 'Connecting', running: 'Working', stale: 'Waiting',
};
const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const phaseOrder = phase => (ATTENTION.has(phase) ? 0 : phase === 'failed' ? 1 : phase === 'starting' || phase === 'running' ? 2 : 3);

function expired(state, now) {
  const at = Date.parse(state.updatedAt);
  if (!Number.isFinite(at)) return true;
  return now - at > (state.phase === 'running' || state.phase === 'starting' ? ACTIVITY_RUNNING_TTL_MS : ACTIVITY_WAITING_TTL_MS);
}

/**
 * What this Mac's Live Activity card shows (upstream's AgentActivity widget props), from every
 * thread's latest awareness state: threads that need the person first, then running ones, then those
 * that finished in the last 15 minutes. null when nothing ran lately. `activeCount` 0 means all done.
 */
export function activityCard(states, { now = Date.now(), environmentId = null, preview = 'full' } = {}) {
  const all = [...states].filter(Boolean);
  const active = all.filter(state => !TERMINAL.has(state.phase) && !expired(state, now))
    .sort((a, b) => phaseOrder(a.phase) - phaseOrder(b.phase) || b.updatedAt.localeCompare(a.updatedAt));
  const done = all.filter(state => TERMINAL.has(state.phase) && now - Date.parse(state.updatedAt) <= ACTIVITY_DONE_MS)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = [...active, ...done];
  if (!shown.length) return null;
  const newest = shown.reduce((latest, state) => (state.updatedAt > latest.updatedAt ? state : latest));
  const subtitle = active.length ? 'Agent work in progress' : done[0].phase === 'failed' ? 'Agent work failed' : 'Agent work completed';
  const row = state => ({
    environmentId: state.environmentId, threadId: state.threadId,
    // 'generic': the lock screen says only that threads run, as the alerts do.
    projectTitle: preview === 'generic' ? '' : clip(state.projectTitle, 40),
    threadTitle: preview === 'generic' ? 'A thread' : clip(state.threadTitle, 60),
    modelTitle: clip(state.modelTitle, 32),
    phase: state.phase, status: ACTIVITY_STATUS[state.phase] ?? 'Working', updatedAt: state.updatedAt,
    deepLink: String(state.deepLink ?? '').startsWith('/') ? state.deepLink : '/',
  });
  const card = {
    title: 'Rubato', subtitle, activeCount: active.length, updatedAt: newest.updatedAt,
    environmentId: environmentId ?? newest.environmentId,
    activities: shown.slice(0, ACTIVITY_ROWS).map(row),
  };
  while (card.activities.length > 1 && Buffer.byteLength(JSON.stringify(JSON.stringify(card))) > ACTIVITY_MAX_BYTES) card.activities.pop();
  return card;
}

/** What a card says, without the times that change on every event: the same card is not sent twice. */
const cardSignature = card => (card ? JSON.stringify([card.activeCount, card.subtitle,
  card.activities.map(item => [item.threadId, item.phase, item.threadTitle, item.projectTitle, item.modelTitle])]) : 'none');

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
  onCall = inCall, telegram = createTelegramSwitch(), companionTitle = registryTitle, desktopSounds = () => readDesktopSounds(),
  setTimer = (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; }, clearTimer = clearTimeout } = {}) {
  const phases = new Map();
  /** Every thread's latest awareness state, for the Live Activity card. */
  const states = new Map();
  const activity = { timer: null, sent: 'none', sentAt: 0, active: false, attention: new Set(), sending: Promise.resolve() };
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
  const readSettings = () => {
    let settings;
    try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { /* first use */ }
    return {
      preview: settings?.preview === 'generic' ? 'generic' : 'full',
      desktopCompanionThreads: settings?.desktopCompanionThreads !== false,
    };
  };
  const readPreview = () => readSettings().preview;
  const writeSettings = patch => {
    const settings = { ...readSettings(), ...patch };
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const temporary = `${settingsFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(settings) + '\n', { mode: 0o600 });
    renameSync(temporary, settingsFile);
    return settings;
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
    status: () => ({ phones: grants.list(), ...readSettings(), telegram: telegram.read() }),
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
      return { preview: writeSettings({ preview }).preview };
    },
    'desktop-companion-threads'({ enabled }) {
      if (typeof enabled !== 'boolean') throw new PushRequestError(400, 'invalid', 'enabled must be true or false');
      return { enabled: writeSettings({ desktopCompanionThreads: enabled }).desktopCompanionThreads };
    },
    async 'desktop-thread-muted'({ threadId }) {
      if (typeof threadId !== 'string' || !threadId) throw new PushRequestError(400, 'invalid', 'threadId is required');
      return { muted: !readSettings().desktopCompanionThreads && await companionOpened(threadId) };
    },
    sounds() {
      const chosen = desktopSounds();
      return { sounds: ['completion', 'input'].map(kind => ({ kind, id: chosen[kind], file: phoneSoundFile(chosen[kind]) })) };
    },
    activity: () => ({ state: currentCard() }),
  };

  const currentCard = () => activityCard([...states].filter(([threadId]) => !rooms.has(threadId)).map(([, state]) => state),
    { now: now(), preview: readPreview() });

  /**
   * Sends the card when it says something new, or when iOS would dim it otherwise; ends it when
   * nothing runs any more. A phone with no card open for this Mac answers no-activity at the relay.
   */
  function sendActivity() {
    activity.timer = null;
    activity.sending = activity.sending.then(async () => {
      const card = currentCard();
      const active = Boolean(card && card.activeCount > 0);
      const signature = cardSignature(card);
      const attention = new Set((card?.activities ?? []).filter(item => ATTENTION.has(item.phase)).map(item => item.threadId));
      const urgent = [...attention].some(threadId => !activity.attention.has(threadId));
      activity.attention = attention;
      if (active) {
        if (signature !== activity.sent || now() - activity.sentAt >= ACTIVITY_REFRESH_MS) {
          activity.sent = signature;
          activity.sentAt = now();
          await grants.pushAll({ kind: 'activity', state: card, ...(urgent ? { urgent: true } : {}) }, { preference: 'liveActivity' });
        }
        activity.active = true;
        activity.timer = setTimer(sendActivity, ACTIVITY_REFRESH_MS);
      } else if (activity.active) {
        activity.active = false;
        activity.sent = 'none';
        await grants.pushAll({ kind: 'activity', state: card, end: true }, { preference: 'liveActivity' });
      }
    }).catch(error => log('live activity not sent', { error: String(error?.message ?? error) }));
    return activity.sending;
  }
  const scheduleActivity = () => {
    if (activity.timer) clearTimer(activity.timer);
    activity.timer = setTimer(sendActivity, ACTIVITY_SETTLE_MS);
  };
  const remember = (threadId, state) => {
    if (state) states.set(threadId, state);
    else states.delete(threadId);
    scheduleActivity();
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
      remember(threadId, state);
      const previous = phases.get(threadId);
      phases.set(threadId, state?.phase ?? null);
      const at = now();
      if (!isNews(state, previous, at)) return null;
      // Only routine outcomes are optional. An ask for approval or an answer still uses
      // the normal thread preference: only the person can give it.
      const preference = TERMINAL.has(state.phase) && await companionOpened(threadId) ? 'companionThreads' : 'threads';
      const preview = readPreview();
      const reply = preview === 'full' && TERMINAL.has(state.phase) ? await lastReply(threadId) : null;
      const sound = phoneSoundFile(desktopSounds()[TERMINAL.has(state.phase) ? 'completion' : 'input']) ?? 'default';
      return grants.pushAll({ ...alertFor(state, previous, { now: at, preview, run, reply }), sound }, { preference });
    },
    /**
     * A thread's state as the server found it on start: the card shows it, and no alert follows for a
     * state that is older than this server.
     */
    threadSeen(threadId, state) {
      if (!state || rooms.has(threadId)) return;
      phases.set(threadId, state.phase);
      remember(threadId, state);
    },
    /** The card's next send, now (tests, and a server that is about to stop). */
    flushActivity() {
      if (activity.timer) clearTimer(activity.timer);
      return sendActivity();
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
      if (typeof threadId !== 'string' || typeof companionId !== 'string') return;
      rooms.set(threadId, companionId);
      if (states.delete(threadId)) scheduleActivity();
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
