// Keeps the companion's conversation loaded in the engine while the person has it turned on.
//
// The engine unloads a runtime a minute after its last attachment goes (pi-server host.mjs). The
// keeper is one more attachment that never leaves: it attaches to the companion's conversation
// like any window would, so the companion stays loaded, its warmer keeps running and a message
// reaches a live runtime. Turning the companion off in Settings › Companion releases it, and the
// engine's ordinary idle rule takes over. The engine starts the keeper itself
// (profile-server.mjs), so the companion comes back whenever the engine does.
//
// The first time the companion is on, the keeper creates its conversation in the companion's
// home folder and records which one it is (state.json). That record is how the app finds it.
//
// The keeper also keeps the companion's rhythm, as the person set it in Settings › Companion: a
// heartbeat every so many minutes and a daily report at a set time, each a wake from Rubato's own
// clock (the companion reads it as a system message where its model allows; session-link
// message.mjs). A companion in the middle of a turn is not interrupted; the beat waits for it.
//
// At night the keeper puts the companion to sleep, once: between 01:00 and 07:00 local time, when
// the user has not written to it for three hours and its context has grown past 500k tokens. Sleep
// is a wake too; what the companion does with it (records, notes, compaction or a new window) is
// in its prompt (harness/prompts/companion).
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { COMPANION_TITLE, companionPaths, composePanel, followingStore, readFinished, readSettings, readState, writePanel, writeState } from './companion.mjs';
import { ensureSegnoHome } from './home.mjs';

const LIVE = new Set(['starting', 'running', 'waiting', 'idle']);
const BUSY = new Set(['starting', 'running', 'waiting']);

export const HEARTBEAT_TEXT = 'Heartbeat. Look over the conversations you follow and anything that came in, and move stalled work forward. ' +
  'End your turn with a short note here; that note stays in the app. If something needs the user, say it to them with telegram_send instead of putting it in the note.';
export const DAILY_REPORT_TEXT = 'Daily report time. Send the user today\'s report: what came in, what was finished, ' +
  'what is still running and what waits for them. Keep it short.';
export const SLEEP_TEXT = 'Time to sleep. The user has been quiet for hours and your context is long. ' +
  'Get ready for sleep as your instructions say: today\'s records, your notes rewritten to the current state, ' +
  'then compaction or a new window. This turn is not for the user; nothing goes to their phone.';

/** The local hours the companion may be put to sleep in: from 01:00 up to 07:00. */
export const SLEEP_HOURS = Object.freeze({ from: 1, to: 7 });
/** How long the user has been quiet before the companion may sleep. */
export const SLEEP_QUIET_MS = 3 * 60 * 60_000;
/** The context the companion carries before sleep is worth it. */
export const SLEEP_CONTEXT_TOKENS = 500_000;
/** How often, at night, the keeper asks the engine whether the companion is ready to sleep. */
const SLEEP_CHECK_MS = 10 * 60_000;

// session-link message.mjs SESSION_MESSAGE_TYPE: a message from another conversation, a messenger or Rubato.
const SESSION_MESSAGE_TYPE = 'rubato-session-message';

/**
 * When the user last wrote to the conversation stored in `file`, in epoch ms, or undefined when
 * they never did. The user writes in the app (a user message) or in a messenger (a channel
 * message from the user). Rubato's clock, notices about other conversations and other people's
 * words are not the user.
 */
export async function lastUserMessageAt(file) {
  const lines = (await readFile(file, 'utf8')).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"user"') && !line.includes('"channel"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const fromUser = (entry?.type === 'message' && entry.message?.role === 'user')
      || (entry?.type === 'custom_message' && entry.customType === SESSION_MESSAGE_TYPE
        && entry.details?.kind === 'channel' && entry.details.from?.isUser === true);
    if (!fromUser) continue;
    const at = typeof entry.message?.timestamp === 'number' ? entry.message.timestamp : Date.parse(entry.timestamp);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

function nightAt(at) {
  const hour = new Date(at).getHours();
  return hour >= SLEEP_HOURS.from && hour < SLEEP_HOURS.to;
}

/** A local date as YYYY-MM-DD. */
export function localDate(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Today's report time on the local clock, in epoch ms. */
function reportTimeOn(at, time) {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(at);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

/**
 * @param {{ connect: () => Promise<object>, notify?: (sessionId: string, text: string, what: 'heartbeat' | 'daily-report' | 'sleep') => Promise<unknown>, env?: NodeJS.ProcessEnv,
 *   onError?: (error: unknown) => void, pollMs?: number, now?: () => number, sleepCheckMs?: number }} options
 *   `connect` opens a session client to this engine (pi-server client.mjs SessionClient); `notify`
 *   wakes the companion (pi-server session-link wake).
 */
export function startCompanionKeeper({ connect, notify, env = process.env, onError = () => {}, pollMs = 3000, now = Date.now, sleepCheckMs = SLEEP_CHECK_MS }) {
  let client;
  let attachedTo;
  let closed = false;
  let ticking;
  let lastBeat;
  let lastSleepCheck;

  async function release() {
    const held = client;
    client = undefined;
    attachedTo = undefined;
    await held?.close().catch(onError);
  }

  async function ensureSession(active) {
    const { sessionId } = readState(env);
    const rows = await active.list();
    if (sessionId && rows.some((row) => row.sessionId === sessionId)) return { sessionId, rows };
    const { home } = companionPaths(env);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // Segno's own places exist before its conversation starts: the memory store its folder writes to
    // is decided from this folder's config, which the session reads when it loads.
    ensureSegnoHome(env);
    const created = await active.create({ cwd: home, title: COMPANION_TITLE, titleLocked: true, companion: true });
    if (!created?.sessionId) throw new Error('The engine did not return the companion conversation it created');
    writeState({ sessionId: created.sessionId }, env);
    return { sessionId: created.sessionId, rows: await active.list() };
  }

  async function tick() {
    if (closed) return;
    try {
      if (!readSettings(env).enabled) { if (client) await release(); return; }
      client ??= await connect();
      const { sessionId, rows } = await ensureSession(client);
      const row = rows.find((item) => item.sessionId === sessionId);
      // A runtime that ended (an error, or the engine reclaimed it) took this attachment with it.
      const live = row && LIVE.has(row.status) && row.runtimeId !== null;
      if (attachedTo !== sessionId || !live) {
        if (attachedTo !== undefined) { await release(); client = await connect(); }
        await client.attach(sessionId);
        attachedTo = sessionId;
      }
      await keepRhythm(client, sessionId, row && BUSY.has(row.status));
      // The space beside the companion's chat lists what it follows (the app reads panel.json).
      writePanel(composePanel({ following: followingStore(env).load(), finished: readFinished(env), rows }), env);
    } catch (error) {
      onError(error);
      await release();
    }
  }

  /**
   * Whether tonight is the night to put the companion to sleep. The attached runtime answers for
   * its context and its session file; the file says when the user last wrote. Asked at most every
   * ten minutes, and only at night before tonight's sleep.
   */
  async function sleepDue(active, at, today) {
    if (!nightAt(at) || readState(env).sleptOn === today) return false;
    if (lastSleepCheck !== undefined && at - lastSleepCheck < sleepCheckMs) return false;
    lastSleepCheck = at;
    const stats = await active.command({ type: 'get_session_stats' });
    // Unknown right after a compaction, until the next answer: not long, then.
    if (!(Number(stats?.contextUsage?.tokens) >= SLEEP_CONTEXT_TOKENS)) return false;
    if (typeof stats.sessionFile !== 'string') return false;
    const lastUser = await lastUserMessageAt(stats.sessionFile);
    return lastUser === undefined || at - lastUser >= SLEEP_QUIET_MS;
  }

  async function keepRhythm(active, sessionId, busy) {
    if (!notify) return;
    const settings = readSettings(env);
    const at = now();
    const { dailyReportOn } = readState(env);
    const today = localDate(at);
    const pastReportTime = at >= reportTimeOn(at, settings.dailyReport.time);
    // A companion that starts after today's report time begins with tomorrow's.
    if (dailyReportOn === undefined) { writeState({ dailyReportOn: pastReportTime ? today : '' }, env); lastBeat ??= at; return; }
    const reportDue = settings.dailyReport.enabled && pastReportTime && dailyReportOn !== today;
    lastBeat ??= at;
    if (busy) return;
    if (await sleepDue(active, at, today)) {
      await notify(sessionId, SLEEP_TEXT, 'sleep');
      writeState({ sleptOn: today }, env);
      lastBeat = at;
      return;
    }
    if (reportDue) {
      await notify(sessionId, DAILY_REPORT_TEXT, 'daily-report');
      writeState({ dailyReportOn: today }, env);
      lastBeat = at;
      return;
    }
    if (settings.heartbeat.enabled && at - lastBeat >= settings.heartbeat.everyMinutes * 60_000) {
      lastBeat = at;
      await notify(sessionId, HEARTBEAT_TEXT, 'heartbeat');
    }
  }

  const run = () => ticking ??= tick().finally(() => { ticking = undefined; });
  const timer = setInterval(() => { void run(); }, pollMs);
  timer.unref?.();
  const ready = run();
  return {
    ready,
    /** Checks now instead of at the next poll (settings were just saved). */
    poke: run,
    get sessionId() { return attachedTo; },
    async close() {
      closed = true;
      clearInterval(timer);
      await ticking;
      await release();
    },
  };
}
