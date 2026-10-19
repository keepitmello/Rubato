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
// heartbeat every so many minutes and a daily report at a set time, each a notice that wakes the
// companion. A companion in the middle of a turn is not interrupted; the beat waits for it.
import { mkdirSync } from 'node:fs';
import { COMPANION_TITLE, companionPaths, readSettings, readState, writeState } from './companion.mjs';
import { ensureSegnoHome } from './home.mjs';

const LIVE = new Set(['starting', 'running', 'waiting', 'idle']);
const BUSY = new Set(['starting', 'running', 'waiting']);

export const HEARTBEAT_TEXT = 'Heartbeat. Look over the conversations you follow and anything that came in, and move stalled work forward. ' +
  'Write to the user only if something needs them; otherwise end your turn with a one-line note to yourself.';
export const DAILY_REPORT_TEXT = 'Daily report time. Send the user today\'s report: what came in, what was finished, ' +
  'what is still running and what waits for them. Keep it short.';

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
 * @param {{ connect: () => Promise<object>, notify?: (sessionId: string, text: string) => Promise<unknown>, env?: NodeJS.ProcessEnv,
 *   onError?: (error: unknown) => void, pollMs?: number, now?: () => number }} options
 *   `connect` opens a session client to this engine (pi-server client.mjs SessionClient); `notify`
 *   wakes the companion with a notice (pi-server session-link notice).
 */
export function startCompanionKeeper({ connect, notify, env = process.env, onError = () => {}, pollMs = 3000, now = Date.now }) {
  let client;
  let attachedTo;
  let closed = false;
  let ticking;
  let lastBeat;

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
      await keepRhythm(sessionId, row && BUSY.has(row.status));
    } catch (error) {
      onError(error);
      await release();
    }
  }

  async function keepRhythm(sessionId, busy) {
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
    if (reportDue) {
      await notify(sessionId, DAILY_REPORT_TEXT);
      writeState({ dailyReportOn: today }, env);
      lastBeat = at;
      return;
    }
    if (settings.heartbeat.enabled && at - lastBeat >= settings.heartbeat.everyMinutes * 60_000) {
      lastBeat = at;
      await notify(sessionId, HEARTBEAT_TEXT);
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
