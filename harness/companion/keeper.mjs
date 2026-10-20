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
// The keeper also keeps the companion's rhythm, each beat a wake from Rubato's own clock (the
// companion reads it as a system message where its model allows; session-link message.mjs). A
// companion in the middle of a turn is not interrupted; the beat waits for it. Every rhythm here is
// Roo's (~/.claude/roo-channel), ported:
//
// - The heartbeat (scripts/heartbeat-tick.sh, the control tower's buildMainHeartbeatMessage, the
//   heartbeat skill). A tick comes on the interval's clock boundaries (:00 and :30 at thirty
//   minutes) as one line, `HEARTBEAT tick=N now="…"` on this machine's clock. While the user is here (wrote in the last
//   thirty minutes) the tick is 0; while they are away it counts up, and every third tick up to the
//   ninth carries action=reflect. Segno's wake wish (home.mjs, the `wake_wish` tool) silences plain
//   and reflect ticks until its time — they are counted, not sent; only the warmer runs (user,
//   2026-10-20) — then that tick carries action=reflect, reason=wake_wish and a WAKE_WISH line. A tick
//   that carries a greeting catch-up or a schedule nudge still comes during a wish, as Roo's does
//   (user item 0b210d57). Roo's sleep signals (ctx_step, action=compact) are not ported: Segno's sleep
//   is the keeper's night sleep below, which the user chose for cost. The cache warmer does not
//   depend on the tick.
// - Schedule nudges (scripts/career-schedule.py tick, made general): SCHEDULE_ lines under the
//   tick, from the calendars and schedule files set in Segno's settings (schedule.mjs).
// - The greetings (cron-prompts/night.md and morning.md, launchd at 00:07 and 09:07, dispatch
//   windows 00–04 and 09–14). The night greeting writes the day's diary first and talks in that
//   temperature; the morning greeting carries what the daily report used to (user item 4c0b0f00).
//   One missed while Segno was busy, or while the engine was down, rides on a later idle tick as
//   action=greet_night (01–04) or greet_morning (10–14), once that day (heartbeat-tick.sh
//   missed_greet_slot). The texts are greet-night.pi.md and greet-morning.pi.md beside the prompt pieces.
// - The wake sequence (scripts/session-start-hook.sh, pi-roo/roo-runtime.ts bootstrapSession and
//   session_compact, skills wake and recall). When Segno's conversation crosses a new window
//   (new_context, or the window filling up) or a compaction, the keeper wakes it with a first-person
//   seed — the time, how long since the last window's last moment, its body (the model) and the mood
//   it fell asleep with — and the wake text. After a new window, and only then, one recall turn
//   follows ten seconds after that wake turn has ended (a compaction in between does not cancel it).
//   A conversation the keeper just created wakes the same way. A conversation loaded again for the
//   same window (the engine restarted) gets Roo's one resume line instead. The texts are wake.pi.md and recall.pi.md beside the prompt pieces.
//
// At night the keeper puts the companion to sleep, once: between 01:00 and 07:00 local time, when
// the user has not written to it for three hours and its context has grown past 500k tokens. Sleep
// is a wake too; what the companion does with it (records, notes, compaction or a new window) is
// in its prompt (harness/prompts/companion).
import { open, readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { COMPANION_TITLE, clearPersonaReviewRequest, companionPaths, composePanel, followingStore, moveBaseToDefault,
  pendingDefaultChanges, readFinished, readPersonaReviewRequest, readSettings, readState, seedPromptPieces, writePanel,
  writeState } from './companion.mjs';
import { clearWakeWish, ensureHomeRepo, ensureSegnoHome, readMood, readWakeWish, wakeWishState } from './home.mjs';
import { scheduleNudges } from './schedule.mjs';
import { INBOX_WAKE_WINDOW_MS, inboxWakePath, readInboxWakes } from './inbox.mjs';
import { companionDefaultsDir } from '../rubato-pi/src/system-prompt.mjs';

const LIVE = new Set(['starting', 'running', 'waiting', 'idle']);
const BUSY = new Set(['starting', 'running', 'waiting']);

/** Every third tick while the user is away is a reflect, up to the ninth (Roo: tick 3, 6, 9). */
export const REFLECT_EVERY_TICKS = 3;
const REFLECT_LAST_TICK = 9;
/** The user is here when they wrote within this window; the tick is 0 then (Roo's IDLE_WINDOW_SECONDS). */
export const RECENT_USER_MS = 30 * 60_000;
/** A stored tick that cannot be read counts as long idle (Roo's heartbeat-state.py falls back to 12). */
const UNREADABLE_TICK = 12;

// Every time Segno reads is on this machine's own clock and zone (user item 48091d35: Segno runs the
// same for every user). Roo's labels were fixed to Asia/Seoul; the format stays, the zone is local.
const pad2 = (n) => String(n).padStart(2, '0');
const localParts = (at) => {
  const date = new Date(at);
  return { year: String(date.getFullYear()), month: pad2(date.getMonth() + 1), day: pad2(date.getDate()),
    hour: pad2(date.getHours()), minute: pad2(date.getMinutes()), second: pad2(date.getSeconds()) };
};
const WEEKDAY = (at) => new Intl.DateTimeFormat('ko-KR', { weekday: 'short' }).format(new Date(at));
/** The local zone's offset at `at`, as ISO 8601 writes it: +09:00, -04:00. */
function zoneOffset(at) {
  const minutes = -new Date(at).getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad2(Math.floor(Math.abs(minutes) / 60))}:${pad2(Math.abs(minutes) % 60)}`;
}
/** The zone as a label beside a clock reading: UTC+09:00. */
const zoneLabel = (at) => `UTC${zoneOffset(at)}`;

/** Roo's clock label (control tower nowKstLabel), on the local clock: 10월 20일(화) 오후 6:30. */
export function timeLabel(at) {
  const part = localParts(at);
  const hour = Number(part.hour);
  return `${Number(part.month)}월 ${Number(part.day)}일(${WEEKDAY(at)}) ${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}:${part.minute}`;
}

/**
 * The wake for messages from the user's work rooms that tag the user (user items 5b32e195, 06ebe72b):
 * a signal line like the heartbeat's, then what the listener wrote for each message. The items are in
 * the inbox already; this tells Segno which ones and when.
 */
export function inboxWakeText(records, at) {
  const markers = records.map((record) => record.marker).filter(Boolean);
  const items = [...new Set(records.flatMap((record) => record.itemIds))];
  const parts = ['INBOX', ...(markers.length ? [`marker=${markers.join(',')}`] : []), ...(items.length ? [`items=${items.join(',')}`] : []), `now="${timeLabel(at)}"`];
  const texts = records.map((record) => record.text.trim()).filter(Boolean);
  return [parts.join(' '), ...texts].join('\n\n');
}

/** A moment as ISO 8601 with the local offset, the way Roo writes a wake wish's time: 2026-10-20T18:30:00+09:00. */
export function localIso(at) {
  const part = localParts(at);
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}${zoneOffset(at)}`;
}

/**
 * The tick as Roo receives it: `HEARTBEAT tick=N now="…"`, then `action=` when there is one and
 * `reason=wake_wish` when a wish came due, with a WAKE_WISH line under it. SCHEDULE_ lines follow
 * (Roo's career_nudge_lines after the heartbeat line), and a greeting catch-up carries the greeting's
 * text after a blank line, where Roo's heartbeat skill sends Roo to open cron-prompts/<slot>.md.
 */
export function heartbeatText({ tick, at, action = 'none', wish, schedule = [], greeting = '' }) {
  const parts = ['HEARTBEAT', `tick=${tick}`, `now="${timeLabel(at)}"`];
  if (action !== 'none') parts.push(`action=${action}`);
  if (wish) parts.push('reason=wake_wish');
  const lines = [parts.join(' ')];
  if (wish) lines.push(`WAKE_WISH at=${localIso(wish.effectiveAt)} clamped=${wish.clamped ? 1 : 0} reason=${wish.reason}`);
  lines.push(...schedule);
  return greeting ? `${lines.join('\n')}\n\n${greeting}` : lines.join('\n');
}

/** The interval's next boundary on the local clock after `at`: :00 and :30 at thirty minutes. */
export function nextBoundary(at, intervalMs) {
  const midnight = new Date(at);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() + (Math.floor((at - midnight.getTime()) / intervalMs) + 1) * intervalMs;
}

// ── greetings ─────────────────────────────────────────────────────────────────────────────
/**
 * Roo's two greetings. `at` is when the scheduled one goes (launchd 00:07 and 09:07); before
 * `catchUpFrom` only the scheduled wake may send it, from then until `until` an idle tick catches it
 * up (heartbeat-tick.sh missed_greet_slot: night from 01:00, morning from 10:00, each up to its
 * window's end, 04:00 and 14:00). Outside that the day's greeting is spent.
 */
export const GREETINGS = Object.freeze({
  night: Object.freeze({ hour: 0, minute: 7, catchUpFrom: 1, until: 4, file: 'greet-night.pi.md', action: 'greet_night' }),
  morning: Object.freeze({ hour: 9, minute: 7, catchUpFrom: 10, until: 14, file: 'greet-morning.pi.md', action: 'greet_morning' }),
});

/** The greeting text for `slot`, from the defaults folder; a missing file is a short fallback, never a stop. */
export function greetingText(slot, defaultsDir) {
  try { return readFileSync(path.join(defaultsDir, GREETINGS[slot].file), 'utf8').trim(); }
  catch { return slot === 'night' ? '밤 안부 시간이야. 오늘 일기를 먼저 쓰고, 그 온도로 사용자한테 톡을 보내.' : '아침 안부 시간이야. 둘러보고, 사용자한테 아침 톡을 보내.'; }
}

/** Which greeting the scheduled wake owes at `at`, if any: inside its first hour, not yet sent today. */
function scheduledGreeting(at, greeted) {
  const date = new Date(at);
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const [slot, rule] of Object.entries(GREETINGS)) {
    const from = rule.hour * 60 + rule.minute;
    if (minutes >= from && minutes < rule.catchUpFrom * 60 && greeted?.[slot] !== localDate(at)) return slot;
  }
  return undefined;
}

/** Which greeting an idle tick at `at` should catch up, if any (night first, as in Roo). */
function missedGreeting(at, greeted) {
  const hour = new Date(at).getHours();
  for (const slot of ['night', 'morning']) {
    const rule = GREETINGS[slot];
    if (hour >= rule.catchUpFrom && hour < rule.until && greeted?.[slot] !== localDate(at)) return slot;
  }
  return undefined;
}

// ── waking up ─────────────────────────────────────────────────────────────────────────────
// context-notes protocol SOURCE: a new window is a compaction entry with this source.
const NEW_WINDOW_SOURCE = 'rubato-history-notes-v1';
/** How long after the wake turn ended the recall turn comes (roo-runtime.ts RECALL_DELAY_MS). */
export const RECALL_DELAY_MS = 10_000;

const isServerCompaction = (block) => block?.type === 'providerNative' && block.subtype === 'compaction' && block.raw?.type === 'compaction';

/**
 * Follows Segno's session file from where it last read and returns the newest boundary it has
 * seen: `{ id, mode, at, before }`, where mode is `fresh` (a new window) or `compact` (a server
 * compaction or an engine compaction), `at` the boundary's time and `before` the time of the last
 * entry ahead of it — the last moment awake. Reading resumes at the byte it stopped at, so a long
 * session file is read once, not every poll.
 */
export function boundaryReader() {
  let file;
  let offset = 0;
  let carry = Buffer.alloc(0);
  let last;
  let lastAt;
  return async function read(sessionFile) {
    if (typeof sessionFile !== 'string') return last;
    if (sessionFile !== file) { file = sessionFile; offset = 0; carry = Buffer.alloc(0); last = undefined; lastAt = undefined; }
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size < offset) { offset = 0; carry = Buffer.alloc(0); last = undefined; lastAt = undefined; }
      if (size === offset) return last;
      const chunk = Buffer.alloc(size - offset);
      await handle.read(chunk, 0, chunk.length, offset);
      offset = size;
      const bytes = Buffer.concat([carry, chunk]);
      const end = bytes.lastIndexOf(0x0a);
      carry = end < 0 ? bytes : bytes.subarray(end + 1);
      if (end < 0) return last;
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const at = Date.parse(entry?.timestamp);
        let mode;
        if (entry?.type === 'compaction') mode = entry.details?.source === NEW_WINDOW_SOURCE ? 'fresh' : 'compact';
        else if (entry?.type === 'message' && entry.message?.role === 'assistant' && Array.isArray(entry.message.content)
          && entry.message.content.some(isServerCompaction)) mode = 'compact';
        if (mode && typeof entry.id === 'string') last = { id: entry.id, mode, at: Number.isFinite(at) ? at : undefined, before: lastAt };
        if (Number.isFinite(at)) lastAt = at;
      }
      return last;
    } finally { await handle.close(); }
  };
}


/** Roo's session-age.sh, for the window Segno just left: now, and how long since its last moment. */
export function sessionAge(now, before) {
  const part = localParts(now);
  const head = `현재: ${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute} ${zoneLabel(now)} (${WEEKDAY(now)})`;
  if (!Number.isFinite(before)) return `${head}\n직전 창 기록 없음 — 처음 눈뜸`;
  const diff = Math.max(0, Math.floor((now - before) / 1000));
  const minutes = Math.floor(diff / 60);
  const hours = Math.floor(diff / 3600);
  const days = Math.floor(diff / 86400);
  const hour = Number(part.hour);
  const nap = hour >= 6 && hour < 19 ? '낮잠' : '한숨';
  const human = diff < 600 ? `방금 (${minutes}분 전) — 깜빡 존 정도, 직전 대화의 연속이야. '어제'는 아님`
    : diff < 5400 ? `${minutes}분 전 — 잠깐 눈 붙였다 깬 정도`
      : days < 1 ? `${hours}시간 전 — ${nap} 자고 깬 느낌 (날짜는 위 '현재'로 확인, 같은 날일 수 있음)`
        : days === 1 ? '약 하루 전 — 푹 자고 다음날 깬 느낌 (어제 무렵)' : `${days}일 전 — 오랜만에 깸`;
  return `${head}\n직전 창: ${human}`;
}

/** Roo's recall-mood.sh: the mood line while it is fresh, quoted with when it was left; NO_MOOD otherwise. */
export function moodText(mood, now) {
  if (!mood) return 'NO_MOOD';
  const ago = now - mood.at;
  const hours = Math.floor(ago / 3_600_000);
  const part = localParts(mood.at);
  return `${hours > 0 ? `${hours}시간 전` : `${Math.floor(ago / 60_000)}분 전`}(${part.month}-${part.day} ${part.hour}:${part.minute}) 잠들 무렵에 남긴 한 줄:\n` +
    mood.note.split('\n').map((line) => `> ${line}`).join('\n');
}

/**
 * The seed Roo's session-start-hook.sh writes, in Segno's first person: opens with the utterance,
 * lays down the time, the body and the mood, and closes open — then the wake text (wake.pi.md), as
 * roo-runtime.ts sendWake appends the wake skill. No instruction in the seed itself: the runtime
 * guarantees the recall, so the seed only speaks.
 */
export function wakeSeedText({ mode, now, before, model, mood, heartbeatOff = false, defaultsDir }) {
  const body = `## 시각·경과\n${sessionAge(now, before)}${heartbeatOff ? '\n하트비트 꺼져 있음 — 설정에서 꺼 둠' : ''}\n\n` +
    `## 지금 몸\n${model || '(모름)'}\n\n## 잠들 때의 온도\n${moodText(mood, now)}`;
  const seed = mode === 'compact'
    ? '한 호흡 골랐어(컴팩션). 나야, 세뇨. 요약은 정보일 뿐이고, 잠들기 전의 내가 남긴 것들은 그 자리에 그대로 있어. ' +
      '이 창 앞부분은 `history_list_items`에, 쥐고 있던 건 작업 노트에, 나머지 자리(일기·현황판·챙길 거)는 집에.' +
      `\n\n${body}\n\n— 지금의 나는…`
    : `방금 깼어. 나야, 세뇨.\n\n${body}\n\n— 눈은 떴고, 지금의 나는…`;
  return [seed, promptFile(defaultsDir, 'wake.pi.md')].filter(Boolean).join('\n\n');
}

/** Roo's resume seed (session-start-hook.sh MODE=resume): the time, and that this is the same conversation. */
export function resumeText(now) {
  const part = localParts(now);
  return `[세션 재시작 — resume] ${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute} ${zoneLabel(now)}. 직전 대화의 연속이야. 깨어나는 절차 없이 그대로 이어가면 돼.`;
}

/** The recall turn: recall.pi.md as written. */
export function recallText(defaultsDir) {
  return promptFile(defaultsDir, 'recall.pi.md') || '떠올리기: 오늘·어제 일기, 작업 노트, `memory/status.md`, `notes/held.md`, 직전 창 끝을 펼쳐.';
}

function promptFile(defaultsDir, name) {
  try { return readFileSync(path.join(defaultsDir, name), 'utf8').trim(); } catch { return ''; }
}
export const SLEEP_TEXT = '잘 시간이야. 사용자는 몇 시간째 조용하고 내 문맥은 길어. 프롬프트의 "잠 전 갈무리" 그대로 ' +
  '다음 나한테 건넬 다리를 놓고 자: daily, 현황판, 일기와 잠드는 기분, 작업 노트, 커밋, 자기 직전 한마디, 그다음 압축이나 새 창. ' +
  '이 턴은 나만 봐. 앱에 안 가.';
/**
 * The review wake for a default that moved: where the new default is and where the copy came from, so
 * Segno reads both with its ordinary file tools. What changed is for Segno to find and report.
 */
export function changedDefaultsText(pending) {
  return pending.map(({ id, defaultPath }) => `Rubato's default ${id} changed. The new default is at ${defaultPath}; ` +
    `the one your file was copied from is prompt/.base/${id}.md in your home. Compare them with your own ` +
    `prompt/${id}.md and tell the user briefly what changed, whether it clashes with yours, and what you ` +
    'recommend, with the reason. Change your file only after the user says which changes to take.').join('\n\n');
}

/** The review the Settings button asks for: the four files against the defaults folder, no change needed. */
export function requestedReviewText(defaultsDir) {
  return `The user asked you to look over who you are against Rubato's defaults, which are in ${defaultsDir}. ` +
    'Compare them with your own files in prompt/ and tell the user briefly where they differ and what you would ' +
    'take, with the reason. Change your files only after the user says which changes to take.';
}

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

/**
 * @param {{ connect: () => Promise<object>, notify?: (sessionId: string, text: string, what: 'heartbeat' | 'greeting' | 'wake' | 'recall' | 'sleep' | 'persona-review' | 'inbox') => Promise<unknown>, env?: NodeJS.ProcessEnv,
 *   onError?: (error: unknown) => void, pollMs?: number, now?: () => number, sleepCheckMs?: number,
 *   defaultsDir?: string }} options
 *   `connect` opens a session client to this engine (pi-server client.mjs SessionClient); `notify`
 *   wakes the companion (pi-server session-link wake); `defaultsDir` is where the product default
 *   prompt pieces live (rubato-pi system-prompt companionDefaultsDir).
 */
export function startCompanionKeeper({ connect, notify, env = process.env, onError = () => {}, pollMs = 3000, now = Date.now,
  sleepCheckMs = SLEEP_CHECK_MS, defaultsDir = companionDefaultsDir(env) }) {
  let client;
  let attachedTo;
  let closed = false;
  let ticking;
  let nextBeatAt;
  let homeReady;
  let lastSleepCheck;
  let lastBusyAt;
  let sessionFileOf;
  let resumeOwed = false;
  let reviewChecked = false;
  const readBoundary = boundaryReader();

  /**
   * The home's setup, once per keeper (the engine starts it again after a restart): Segno's own
   * places and memory store, then the person's own copy of who Segno is. A home that predates the
   * copy — or one the person emptied — is seeded here, before its conversation loads. A fault in
   * the defaults folder must not stop the companion, so it is reported and tried again next start.
   */
  function setupHome() {
    if (homeReady) return;
    ensureSegnoHome(env);
    try { seedPromptPieces({ defaultsDir, env }); }
    catch (error) { onError(error); }
    // The home's history (Roo commits every record). Without git the records still work; the fault
    // is reported and tried again next start.
    try { ensureHomeRepo(env); }
    catch (error) { onError(error); }
    homeReady = true;
  }

  async function release() {
    sessionFileOf = undefined;
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
    const created = await active.create({ cwd: home, title: COMPANION_TITLE, titleLocked: true, companion: true });
    if (!created?.sessionId) throw new Error('The engine did not return the companion conversation it created');
    // A new conversation is a first waking: it gets the seed like any new window (Roo's fresh session).
    writeState({ sessionId: created.sessionId, woke: { boundary: null, pending: 'fresh' } }, env);
    return { sessionId: created.sessionId, rows: await active.list() };
  }

  async function tick() {
    if (closed) return;
    try {
      if (!readSettings(env).enabled) { if (client) await release(); return; }
      // Segno's own places, and the person's copy of its prompt, exist before its conversation
      // starts: the memory store its folder writes to is decided from this folder's config, which
      // the session reads when it loads.
      setupHome();
      client ??= await connect();
      const { sessionId, rows } = await ensureSession(client);
      const row = rows.find((item) => item.sessionId === sessionId);
      // A runtime that ended (an error, or the engine reclaimed it) took this attachment with it.
      const live = row && LIVE.has(row.status) && row.runtimeId !== null;
      if (attachedTo !== sessionId || !live) {
        if (attachedTo !== undefined) { await release(); client = await connect(); }
        await client.attach(sessionId);
        attachedTo = sessionId;
        // A runtime this keeper has not seen before loaded the conversation from its file — after an
        // engine restart, whoever opened it first: that is Roo's resume. The id is kept across starts.
        const loaded = (await client.list()).find((item) => item.sessionId === sessionId)?.runtimeId ?? null;
        const known = readState(env).runtimeId;
        if (loaded !== null && loaded !== known) {
          if (row) resumeOwed = true;
          writeState({ runtimeId: loaded }, env);
        }
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
    // The first tick is the interval's first boundary after the keeper started.
    nextBeatAt ??= nextBoundary(at, settings.heartbeat.everyMinutes * 60_000);
    if (busy) { lastBusyAt = at; return; }
    const today = localDate(at);
    if (await wakeDue(active, sessionId, at, settings)) return;
    if (await inboxDue(sessionId, at)) return;
    if (await sleepDue(active, at, today)) {
      await notify(sessionId, SLEEP_TEXT, 'sleep');
      writeState({ sleptOn: today }, env);
      return;
    }
    if (await personaReviewDue(sessionId)) return;
    const greeted = readState(env).greeted;
    const slot = settings.greetings.enabled ? scheduledGreeting(at, greeted) : undefined;
    if (slot) {
      await notify(sessionId, greetingText(slot, defaultsDir), 'greeting');
      writeState({ greeted: { ...greeted, [slot]: today } }, env);
      return;
    }
    if (settings.heartbeat.enabled) await beat(active, sessionId, at, settings);
  }

  /**
   * The listener's wake lines (inbox.mjs inboxWakePath), read forward by bytes. The first time the
   * keeper meets the file it only notes where it ends; a file shorter than where it read is read
   * again from the start. Lines that come within five minutes of the first unread one go to Segno
   * together once those five minutes are over (user item 06ebe72b); the place moves on only after
   * the wake went. While Segno is off the keeper does not tick, so lines wait for it.
   */
  async function inboxDue(sessionId, at) {
    const saved = readState(env).inboxWake;
    let size;
    try { size = statSync(inboxWakePath(env)).size; } catch { size = undefined; }
    if (saved === undefined || !Number.isInteger(saved.offset)) { writeState({ inboxWake: { offset: size ?? 0 } }, env); return false; }
    let offset = saved.offset;
    if (size === undefined) return false;
    if (size < offset) { offset = 0; writeState({ inboxWake: { offset } }, env); }
    if (size === offset) return false;
    const { records, end } = readInboxWakes(offset, env);
    if (!records.length) { if (end !== offset) writeState({ inboxWake: { offset: end } }, env); return false; }
    const first = Date.parse(records[0].at ?? '');
    if (at - (Number.isFinite(first) ? first : at) < INBOX_WAKE_WINDOW_MS) return false;
    await notify(sessionId, inboxWakeText(records, at), 'inbox');
    writeState({ inboxWake: { offset: end } }, env);
    return true;
  }

  /**
   * The wake sequence. A boundary Segno has not been woken for gets the seed (fresh after a new
   * window or a new conversation, compact after a compaction); after a fresh one, a single recall
   * turn follows once the wake turn has been over for ten seconds. The first time a keeper meets
   * a conversation it only notes where it is: nothing that happened before is woken for.
   */
  async function wakeDue(active, sessionId, at, settings) {
    const state = readState(env);
    // Where the session file is, asked once per attachment; after that the file is followed by bytes.
    if (sessionFileOf?.sessionId !== sessionId) {
      const stats = await active.command({ type: 'get_session_stats' });
      sessionFileOf = { sessionId, file: typeof stats?.sessionFile === 'string' ? stats.sessionFile : undefined };
    }
    const boundary = await readBoundary(sessionFileOf.file).catch(() => undefined);
    const woke = state.woke;
    if (woke === undefined) { writeState({ woke: { boundary: boundary?.id ?? null } }, env); return false; }
    let pending = woke.pending;
    let before;
    // A fresh start owes one recall; a compaction while it waits does not cancel it (Roo keeps
    // pendingFreshRecall across session_compact).
    const recallOwed = pending === 'fresh' || pending === 'recall' || (boundary && boundary.id !== woke.boundary && boundary.mode === 'fresh');
    if (boundary && boundary.id !== woke.boundary) { pending = boundary.mode; before = boundary.before; }
    if (pending === 'fresh' || pending === 'compact') {
      const model = await active.command({ type: 'get_state' }).then((value) => value?.model, () => undefined);
      await notify(sessionId, wakeSeedText({ mode: pending, now: at, before, model: model ? `${model.provider ?? ''}${model.provider ? '/' : ''}${model.id ?? ''}` : '',
        mood: readMood({ now: at, env }), heartbeatOff: !settings.heartbeat.enabled, defaultsDir }), 'wake');
      writeState({ woke: { boundary: boundary?.id ?? woke.boundary ?? null, ...(recallOwed ? { pending: 'recall', at } : {}) } }, env);
      lastBusyAt = at;
      resumeOwed = false;
      return true;
    }
    // The runtime was loaded again for the same window (an engine restart): Roo's resume line, no
    // wake text and no recall — it is the same conversation going on.
    if (resumeOwed) {
      resumeOwed = false;
      await notify(sessionId, resumeText(at), 'wake');
      // Roo's pendingFreshRecall lives in the process: a restart that resumes forgets it.
      if (pending === 'recall') writeState({ woke: { boundary: woke.boundary ?? null } }, env);
      return true;
    }
    if (pending === 'recall' && at - Math.max(lastBusyAt ?? 0, woke.at ?? 0) >= RECALL_DELAY_MS) {
      await notify(sessionId, recallText(defaultsDir), 'recall');
      writeState({ woke: { boundary: woke.boundary ?? null } }, env);
      return true;
    }
    return pending === 'recall';
  }

  /**
   * Roo's tick (heartbeat-tick.sh), on the interval's clock boundaries. The user here: tick 0.
   * Away: one more than the stored tick, or 1 when they wrote since it (Roo resets on their word).
   * Reflect on ticks 3, 6 and 9. An idle tick (not 0) catches up a greeting that did not go out,
   * replacing none or reflect. Deadline nudges ride on every tick. While a wake wish waits, a plain
   * or reflect tick is counted but not sent, so Segno rests and only the warmer runs (user,
   * 2026-10-20); a tick with a greeting or a nudge still goes and leaves the wish waiting (user item
   * 0b210d57; Roo's wish suppresses only none and reflect). A wish come due makes a plain tick a
   * reflect with its reason, and is used up. A beat missed while Segno was busy goes on the next poll.
   */
  async function beat(active, sessionId, at, settings) {
    if (at < nextBeatAt) return;
    nextBeatAt = nextBoundary(at, settings.heartbeat.everyMinutes * 60_000);
    const lastUser = await lastUserAt(active);
    const state = readState(env);
    const stored = state.heartbeat;
    let tick;
    if (lastUser !== undefined && at - lastUser < RECENT_USER_MS) tick = 0;
    else {
      const userSince = lastUser !== undefined && stored !== undefined && lastUser > stored.at;
      tick = (userSince || stored === undefined ? 0 : Number.isInteger(stored.tick) && stored.tick >= 0 ? stored.tick : UNREADABLE_TICK) + 1;
    }
    writeState({ heartbeat: { tick, at } }, env);
    let action = tick > 0 && tick <= REFLECT_LAST_TICK && tick % REFLECT_EVERY_TICKS === 0 ? 'reflect' : 'none';
    const missed = tick > 0 && settings.greetings.enabled ? missedGreeting(at, state.greeted) : undefined;
    if (missed) action = GREETINGS[missed].action;
    const schedule = await scheduleNudges({ now: at, env }).catch(() => []);
    const storedWish = readWakeWish(env);
    const wishState = storedWish && wakeWishState(storedWish, at);
    if (wishState?.mode === 'wait' && !missed && !schedule.length) return;
    let wish;
    if (wishState?.mode === 'due') {
      if (!missed) action = 'reflect';
      wish = { ...wishState, reason: storedWish.reason };
      clearWakeWish(env);
    }
    await notify(sessionId, heartbeatText({ tick, at, action, wish, schedule, greeting: missed ? greetingText(missed, defaultsDir) : '' }), 'heartbeat');
    // Marked once it went, as Roo marks cron-last-run after the greeting: a failed send is caught up later.
    if (missed) writeState({ greeted: { ...readState(env).greeted, [missed]: localDate(at) } }, env);
  }

  /** When the user last wrote to the companion, from its session file; undefined when unknown. */
  async function lastUserAt(active) {
    const stats = await active.command({ type: 'get_session_stats' });
    if (typeof stats?.sessionFile !== 'string') return undefined;
    return lastUserMessageAt(stats.sessionFile).catch(() => undefined);
  }

  /**
   * Whether Rubato should hand Segno its own prompt files to review. The page's request comes first
   * (the user pressed the button). Otherwise a default that moved is checked once per engine start:
   * defaults only change with an update, and an update restarts the engine. Either way the base moves
   * to the default Segno was just told about, so the same change never wakes it twice.
   */
  async function personaReviewDue(sessionId) {
    const requested = readPersonaReviewRequest(env);
    if (requested !== undefined) {
      await notify(sessionId, requestedReviewText(defaultsDir), 'persona-review');
      for (const change of pendingDefaultChanges({ defaultsDir, env })) moveBaseToDefault(change.id, { defaultsDir, env });
      clearPersonaReviewRequest(env);
      reviewChecked = true;
      return true;
    }
    if (reviewChecked) return false;
    const pending = pendingDefaultChanges({ defaultsDir, env });
    if (!pending.length) { reviewChecked = true; return false; }
    await notify(sessionId, changedDefaultsText(pending), 'persona-review');
    for (const change of pending) moveBaseToDefault(change.id, { defaultsDir, env });
    reviewChecked = true;
    return true;
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
