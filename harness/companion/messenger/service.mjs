// The Telegram messenger, resident in the engine: it carries the person's own Telegram chat to
// Segno and Segno's words back, and it holds every message addressed to anyone else until the
// person approves it.
//
// What it does, in one pass:
//   - a message from the person's chat goes into Segno's conversation as the person's own message,
//     with Telegram named as where it came from;
//   - a message from another chat (a group where bug reports arrive) goes in as another person's
//     words, with no authority over Segno's settings;
//   - photos, files and voice messages arrive with it: a photo as an image Segno sees, a file
//     saved where Segno can open it, a voice message transcribed (media.mjs, Roo's daemon);
//   - the app and Telegram show the same conversation: every word of Segno's the app shows goes
//     to the person's Telegram, and a run the app hides stays out of it (sync.mjs); the answer to
//     another person is held;
//   - Segno's Telegram tools send text, files and voice notes, react and edit (Roo's
//     telegram_reply, react, edit_message); anything addressed to another chat is held until the
//     person approves it, from the Telegram card or from Settings › Companion;
//   - "typing…" shows while Segno works on a Telegram turn, and /context and /heartbeat are
//     answered without a turn (commands.mjs, Roo's control commands).
//
// The service is the only thing that talks to Telegram, and the only writer of its own files.
// Everything it needs from the engine arrives through `deliver`; everything it needs from the app
// is a file in the companion's home (store.mjs). A failure here ends this service, not the engine
// and not a running conversation.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createBotApi, BotApiError } from './bot-api.mjs';
import {
  MESSENGER_LIMITS, clearDecision, describeRow, enqueueMessage, listDecisions, listOutbox, messengerPaths, newPairingCode,
  pairedChatId, readBot, readDecision, readHandoff, readIntent, readMessengerSettings, readPairing, readSecret,
  readOutboxRow, readState, recordSent, updateOutboxRow, writeBotIdentity, writeDecision, writeHandoff, writeIntent, writePairing,
  writeSecret, writeState,
} from './store.mjs';
import { freshRun, locateTranscript, readEntriesFrom, runAt, stepRun } from './sync.mjs';
import { mediaOf, saveMedia, transcribeMedia } from './media.mjs';
import { prepareReplyPayload, telegramText } from './reply-text.mjs';
import { synthesizeVoice } from './voice.mjs';
import { SEGNO_OFF_TEXT, contextText, heartbeatText, parseControlCommand, segnoText } from './commands.mjs';
import { botUsernameCandidates } from './scripts/create-bot.mjs';
import { readSettings as readCompanionSettings, readState as readCompanionState, writeSettings as writeCompanionSettings } from '../companion.mjs';
import { openInbox } from '../inbox.mjs';

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/**
 * "typing…" in the chat Segno works on a message from, the person's or another's (Roo's
 * telegram-tools.ts scheduleTelegramTyping, daemon.ts handleInbound):
 * it starts after a short, varied pause, Telegram is told again every four seconds, and it stops
 * when the turn's answer is written, after ten minutes, or when the service closes.
 */
export const TYPING = Object.freeze({ refreshMs: 4000, maxMs: 10 * 60 * 1000, fastStartMaxMs: 1500,
  slowStartMinMs: 5000, slowStartMaxMs: 15000, fastStartProbability: 0.6 });
const typingDelay = (random = Math.random) => (random() < TYPING.fastStartProbability
  ? Math.floor(random() * TYPING.fastStartMaxMs)
  : TYPING.slowStartMinMs + Math.floor(random() * (TYPING.slowStartMaxMs - TYPING.slowStartMinMs)));

/** How a voice message reaches the conversation as words: OpenAI transcription with the Mac's voice-input key. */
const STT_PROMPT = [
  'A voice message the person sent their companion Segno on Telegram.',
  'Write what was said. Do not summarize, translate, reorder or polish it.',
  'The primary language is Korean. Keep English technical terms and names in their original spelling.',
].join(' ');

/** Transcribes with the key and model the person set for voice input (~/.rubato/voice.json), as Roo's daemon does with its own key. */
export function defaultTranscriber(env = process.env) {
  return async ({ bytes, ext, mime }) => {
    const settings = await import('../../t3-integration/src/voice/settings.mjs');
    const { transcribeAudio } = await import('../../t3-integration/src/voice/transcribe.mjs');
    const { config } = settings.createVoiceConfigReader(settings.voiceConfigPath(env))();
    const model = typeof config?.model === 'string' && config.model.trim() ? config.model.trim() : settings.DEFAULT_VOICE_MODEL;
    const { text } = await transcribeAudio({ apiKey: settings.voiceApiKey(config, env), model, audio: bytes,
      filename: `voice.${ext}`, contentType: mime || 'audio/ogg', prompt: STT_PROMPT, hints: ['Segno', '세뇨', 'Rubato', '루바토'] });
    return { text, engine: `openai/${model}` };
  };
}

const BUTTON_APPROVE = '✅ 보내기';
const BUTTON_REJECT = '❌ 그만두기';

/** A sleep that ends early when the service closes, and never by itself keeps the process alive. */
/** How many passes one update may fail before it is given up on (a minute and a half at the default pace). */
export const MAX_UPDATE_TRIES = 50;

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  timer.unref?.();
  function done() { signal?.removeEventListener('abort', done); clearTimeout(timer); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * One message's text cut to what one Telegram message may hold (Roo's chunk, newline mode): at a
 * paragraph, else a line, past the middle; else at a space; else at the limit.
 */
export function splitText(text, limit = MESSENGER_LIMITS.textChars) {
  const whole = String(text ?? '').trim();
  if (whole.length <= limit) return whole ? [whole] : [];
  const parts = [];
  let rest = whole;
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit);
    const line = rest.lastIndexOf('\n', limit);
    const space = rest.lastIndexOf(' ', limit);
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

const CREATE_BOT_SCRIPT = fileURLToPath(new URL('./scripts/create-bot.mjs', import.meta.url));

/** Makes the bot over MTProto from the person's own account (`scripts/create-bot.mjs`). */
export function createBotOverMtproto({ name = 'Segno', username } = {}) {
  // A name the person gave is tried first; otherwise each try carries a fresh suffix, because a
  // fixed default belongs to whoever installed it first.
  const usernames = [...new Set([...(username ? [username] : []), ...botUsernameCandidates({ base: 'segno' })])];
  const args = [CREATE_BOT_SCRIPT, '--name', name, ...usernames.flatMap((value) => ['--username', value])];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) { reject(new Error(`making the bot failed: ${String(stderr || error.message).trim().split('\n')[0]}`)); return; }
        try { resolve(JSON.parse(String(stdout).trim().split('\n').at(-1))); }
        catch { reject(new Error('making the bot returned no token')); }
      });
  });
}

/** `'user'` for the person's own chat, otherwise a chat the message is addressed to. */
export function targetOf(to, name) {
  return to === undefined || to === null || to === '' || to === 'user'
    ? 'user'
    : { chatId: String(to), ...(name ? { name: String(name) } : {}) };
}

/** A person's display name from a Telegram message. */
function nameOf(user, chat) {
  const parts = [user?.first_name, user?.last_name].filter(Boolean).join(' ');
  return parts || user?.username || chat?.title || String(chat?.id ?? '');
}

/** The words of a message with no attachment; one with an attachment reads as media.mjs says. */
function plainText(message) {
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  return '(empty message)';
}


/**
 * @param {{
 *   deliver: (args: { to: string, channel: string, from: object, text: string, attachments?: object[] }) => Promise<unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   agentDir?: string,
 *   onError?: (error: unknown) => void,
 *   log?: (event: string, details?: object) => void,
 *   createApi?: (token: string) => object,
 *   createBot?: (args: { name?: string, username?: string }) => Promise<{ token: string, username?: string, name?: string }>,
 *   transcribe?: (audio: { path: string, bytes: Buffer, ext: string, mime?: string }) => Promise<{ text: string, engine?: string }>,
 *   synthesize?: (text: string) => Promise<{ path: string, durationSec?: number }>,
 *   sessionStats?: (sessionId: string) => Promise<{ contextUsage?: { tokens: number|null, contextWindow: number, percent: number|null } }>,
 *   typingDelay?: () => number,
 *   signal?: AbortSignal,
 *   pollMs?: number,
 *   longPollSeconds?: number,
 *   now?: () => number,
 * }} options
 *   `deliver` is the engine's `host.channel` (pi-server resident-services): it puts the text and
 *   the saved files in Segno's conversation as a channel message. `sessionStats` answers /context
 *   from the engine. The other functions are seams for tests.
 */
export function startCompanionMessenger({
  deliver, env = process.env, agentDir, onError = () => {}, log = () => {},
  createApi = (token) => createBotApi({ token, baseUrl: env.RUBATO_TELEGRAM_API_BASE || undefined }),
  createBot = createBotOverMtproto, transcribe = defaultTranscriber(env), synthesize = (text) => synthesizeVoice(text, { env }),
  sessionStats, typingDelay: delayTyping = typingDelay,
  signal, pollMs = 1000, longPollSeconds = 25, now = Date.now,
} = {}) {
  if (typeof deliver !== 'function') throw new TypeError('deliver is required');
  const sessionsDir = agentDir ? path.join(agentDir, 'sessions') : undefined;
  let closed = false;
  let api;
  let apiToken;
  let webhookCleared = false;
  let inboundLoop;
  let outboundLoop;
  let inboundPass;
  let outboundPass;
  let inboundSeen = new Map();
  /** Updates whose delivery failed, so one that always fails cannot wedge the rest forever. */
  const failures = new Map();
  /** Since when updates wait for Segno's conversation to exist. */
  let waitingSince;
  const notReady = () => Object.assign(new Error("Segno's conversation is not running yet"), { code: 'not-ready' });
  const stop = new AbortController();
  if (signal) signal.addEventListener('abort', () => stop.abort(), { once: true });

  const aborted = () => closed || stop.signal.aborted;

  /**
   * Everything that sends to Telegram, one at a time and in order: the sync's answers, the tools'
   * messages, approvals. A tool's message is never sent twice by a pass running beside it.
   */
  let outboundChain = Promise.resolve();
  function serial(work) {
    const run = outboundChain.then(work);
    outboundChain = run.catch(() => {});
    return run;
  }

  function bot() {
    const secret = readSecret(env);
    if (!secret) return undefined;
    if (apiToken !== secret.token) {
      api = createApi(secret.token);
      apiToken = secret.token;
      webhookCleared = false;
    }
    return api;
  }

  /** Updates already let through the cap: a retry of one (waiting, a failed delivery) is not new traffic. */
  const admitted = new Set();
  /** Telegram refuses a band of messages from one chat in one minute; these are generous. */
  function allowedInbound(chatId, updateId) {
    if (updateId !== undefined && admitted.has(updateId)) return true;
    const at = now();
    const recent = (inboundSeen.get(chatId) ?? []).filter((time) => at - time < 60_000);
    if (recent.length >= 30) { inboundSeen.set(chatId, recent); return false; }
    recent.push(at);
    inboundSeen.set(chatId, recent);
    if (updateId !== undefined) {
      admitted.add(updateId);
      if (admitted.size > 1000) admitted.delete(admitted.values().next().value);
    }
    return true;
  }

  // ── typing… ──────────────────────────────────────────────────────────────────────────────

  const typing = new Map(); // chatId -> { start, interval, max }
  function stopTyping(chatId) {
    const state = typing.get(chatId);
    if (!state) return;
    clearTimeout(state.start); clearInterval(state.interval); clearTimeout(state.max);
    typing.delete(chatId);
  }
  const stopAllTyping = () => { for (const chatId of [...typing.keys()]) stopTyping(chatId); };
  function startTyping(client, chatId) {
    stopTyping(chatId);
    const state = {};
    const ping = () => { client.sendChatAction({ chatId, action: 'typing' }).catch(() => {}); };
    state.start = setTimeout(() => {
      if (typing.get(chatId) !== state) return;
      ping();
      state.interval = setInterval(ping, TYPING.refreshMs);
      state.interval.unref?.();
    }, delayTyping());
    state.max = setTimeout(() => stopTyping(chatId), TYPING.maxMs);
    state.start.unref?.(); state.max.unref?.();
    typing.set(chatId, state);
  }

  // ── the app's requests ───────────────────────────────────────────────────────────────────

  async function handleIntent() {
    const intent = readIntent(env);
    if (!intent) return;
    const handoff = readHandoff(env);
    if (handoff.intentAt === intent.at) return;
    try {
      if (intent.action === 'pair') {
        const pairing = readPairing(env);
        if (pairing.status === 'paired') writeHandoff({ intentAt: intent.at, result: 'already-paired' }, env);
        else {
          writePairing({ status: 'pending', code: newPairingCode(), requestedAt: new Date(now()).toISOString() }, env);
          writeHandoff({ intentAt: intent.at, result: 'pairing-code' }, env);
        }
      } else if (intent.action === 'unpair') {
        writePairing({ status: 'unpaired' }, env);
        writeHandoff({ intentAt: intent.at, result: 'unpaired' }, env);
      } else if (intent.action === 'set-token') {
        // The path for everyone without the person's MTProto client: a token from @BotFather,
        // checked before it is kept.
        if (typeof intent.token !== 'string' || !intent.token.trim()) throw new Error('no bot token was handed over');
        const candidate = createApi(intent.token.trim());
        let me;
        try { me = await candidate.getMe(); }
        catch (error) { throw new Error(`Telegram did not accept that token: ${error?.message ?? error}`); }
        if (!me?.is_bot) throw new Error('that token does not belong to a bot');
        writeSecret(intent.token.trim(), env);
        writeBotIdentity({ username: me.username, name: me.first_name }, env);
        writeHandoff({ intentAt: intent.at, result: 'token-saved' }, env);
        // The request file is not a second copy of the secret.
        writeIntent({ action: 'token-saved' }, env, { at: intent.at });
        log('token-saved', { username: me.username });
      } else if (intent.action === 'create-bot') {
        if (!createBot) throw new Error('making a bot is not available in this build');
        const made = await createBot({ name: intent.name, username: intent.username });
        writeSecret(made.token, env);
        if (made.username || made.name) writeBotIdentity({ username: made.username, name: made.name }, env);
        writeHandoff({ intentAt: intent.at, result: 'bot-created' }, env);
        log('bot-created', { username: made.username });
      } else {
        throw new Error(`unknown action: ${intent.action}`);
      }
    } catch (error) {
      writeHandoff({ intentAt: intent.at, result: 'failed', error: error instanceof Error ? error.message : String(error) }, env);
      onError(error);
    }
  }

  // ── Telegram, in ─────────────────────────────────────────────────────────────────────────

  /**
   * A message's words and saved files, as they go into the conversation: a voice message as its
   * transcript, a photo or file saved under the companion's home. A file that cannot be fetched
   * is named in the words instead, so Segno knows something arrived and why it cannot see it.
   */
  async function contentOf(client, message) {
    const media = mediaOf(message);
    if (!media) return { text: plainText(message), attachments: [] };
    if (media.kind === 'voice' || media.kind === 'audio') {
      const heard = await transcribeMedia(client, media, { env, transcribe, chatId: message.chat?.id, messageId: message.message_id,
        receivedAt: new Date((message.date ?? now() / 1000) * 1000).toISOString(), reportError: onError });
      if (heard.status === 'failed') log('voice-not-transcribed', { why: heard.error });
      return { text: heard.text, attachments: [] };
    }
    try {
      const saved = await saveMedia(client, media, { env, now });
      return { text: media.text, attachments: [saved] };
    } catch (error) {
      log('attachment-not-saved', { kind: media.kind, why: error?.message });
      return { text: `${media.text}\n(${media.kind} could not be downloaded: ${error?.message ?? error})`, attachments: [] };
    }
  }

  async function handleUpdate(client, update) {
    if (update.callback_query) return handleCallback(client, update.callback_query);
    const message = update.message;
    if (!message || message.from?.is_bot) return;
    const chatId = String(message.chat?.id ?? '');
    if (!chatId) return;
    const pairing = readPairing(env);
    const userChat = pairedChatId(env);

    if (userChat === chatId) {
      // The person's own chat has no cap, as in Roo; only other chats are rate-limited.
      const command = mediaOf(message) ? undefined : parseControlCommand(message.text);
      if (command) { await answerCommand(client, chatId, command); return; }
      // Segno is off: its conversation is not woken; the person hears how to turn it back on.
      if (!readCompanionSettings(env).enabled) {
        await serial(() => client.sendMessage({ chatId, text: SEGNO_OFF_TEXT }));
        log('inbound-while-off', { chatId });
        return;
      }
      const to = readCompanionState(env).sessionId;
      // Segno's conversation is not there yet (the engine is starting, the companion was just
      // turned on): the person's words wait in Telegram until it is.
      if (!to) throw notReady();
      const { text, attachments } = await contentOf(client, message);
      await deliver({
        to,
        channel: 'telegram',
        from: { channel: 'telegram', chatId, name: nameOf(message.from, message.chat), isUser: true, messageId: message.message_id },
        text,
        ...(attachments.length ? { attachments } : {}),
      });
      // What a reaction lands on when Segno names no message: the person's latest (Roo's reply target).
      writeState({ lastIncoming: { chatId, messageId: message.message_id } }, env);
      startTyping(client, chatId);
      log('inbound-user', { chatId, messageId: message.message_id, ...(attachments.length ? { attachments: attachments.length } : {}) });
      return;
    }
    if (pairing.status === 'pending' && message.chat?.type === 'private') {
      const typed = plainText(message).trim().replace(/^\/pair\s*/i, '').toUpperCase();
      if (pairing.code && typed === pairing.code) {
        writePairing({ status: 'paired', chat: { chatId, name: nameOf(message.from, message.chat),
          ...(message.from?.username ? { username: message.from.username } : {}), pairedAt: new Date(now()).toISOString() } }, env);
        await client.sendMessage({ chatId, text: '연결됐습니다. 이제 여기서 세뇨와 이야기하면 됩니다.' });
        log('paired', { chatId });
        return;
      }
    }
    if (message.chat?.type === 'group' || message.chat?.type === 'supergroup') {
      if (!allowedInbound(chatId, update.update_id)) { log('inbound-dropped', { chatId }); return; }
      // Someone else's report belongs in Segno's inbox whether or not its conversation is up: the
      // list is what the person reads, and a message must not be lost to a restarting engine.
      // Segno is off: the report is kept in its inbox, where it finds it once it is on again, and
      // nothing wakes it now.
      if (!readCompanionSettings(env).enabled) {
        fileReport({ chatId, message, text: mediaOf(message)?.text ?? plainText(message) });
        log('inbound-while-off', { chatId });
        return;
      }
      const to = readCompanionState(env).sessionId;
      if (!to) { fileReport({ chatId, message, text: mediaOf(message)?.text ?? plainText(message) }); throw notReady(); }
      const { text, attachments } = await contentOf(client, message);
      fileReport({ chatId, message, text });
      await deliver({
        to,
        channel: 'telegram',
        from: { channel: 'telegram', chatId, name: nameOf(message.from, message.chat), isUser: false, messageId: message.message_id },
        text: `${text}\n\n(보낸 곳: ${message.chat.title ?? chatId})`,
        ...(attachments.length ? { attachments } : {}),
      });
      // Roo shows "typing…" in every chat it works on a message from (daemon.ts handleInbound).
      startTyping(client, chatId);
      log('inbound-other', { chatId, messageId: message.message_id });
    }
  }

  /** /context and /heartbeat, answered here and now; Segno's conversation never sees them. */
  async function answerCommand(client, chatId, { command, enable }) {
    let text;
    if (command === 'context') {
      const sessionId = readCompanionState(env).sessionId;
      try {
        if (!sessionId) throw new Error('세뇨 대화가 아직 없음');
        if (typeof sessionStats !== 'function') throw new Error('이 엔진은 세션 통계를 주지 않음');
        const stats = await sessionStats(sessionId);
        text = contextText({ usage: stats?.contextUsage });
      } catch (error) { text = contextText({ error: error?.message ?? String(error) }); }
    } else if (command === 'segno') {
      try {
        const before = readCompanionSettings(env).enabled;
        if (enable === undefined) text = segnoText({ enabled: before, changed: false });
        else { writeCompanionSettings({ enabled: enable }, env); text = segnoText({ enabled: enable, changed: before !== enable }); }
      } catch (error) { text = segnoText({ error: error?.message ?? String(error) }); }
    } else {
      try { writeCompanionSettings({ heartbeat: { enabled: enable } }, env); text = heartbeatText({ enabled: enable }); }
      catch (error) { text = heartbeatText({ error: error?.message ?? String(error) }); }
    }
    await serial(() => client.sendMessage({ chatId, text }));
    log('command', { command, ...(enable === undefined ? {} : { enable }) });
  }

  async function handleCallback(client, query) {
    const chatId = String(query.message?.chat?.id ?? query.from?.id ?? '');
    const data = typeof query.data === 'string' ? query.data : '';
    const [action, id] = data.split(':');
    const isUser = pairedChatId(env) === chatId;
    if (!isUser) { await client.answerCallbackQuery({ callbackQueryId: query.id, text: '이 대화에서는 쓸 수 없습니다.' }).catch(onError); return; }
    if ((action === 'approve' || action === 'reject') && id) {
      writeDecision(id, action === 'approve' ? 'approve' : 'reject', { by: 'telegram' }, env);
      const word = action === 'approve' ? '보냅니다.' : '보내지 않습니다.';
      await client.answerCallbackQuery({ callbackQueryId: query.id, text: word }).catch(onError);
      const row = listOutbox(env).find((item) => item.id === id);
      if (row && query.message?.message_id !== undefined) {
        const target = row.target === 'user' ? '사용자' : row.target.name ?? row.target.chatId;
        await client.editMessageText({ chatId, messageId: query.message.message_id,
          text: `${action === 'approve' ? '✅ 보냄' : '❌ 보내지 않음'} — ${target}\n\n${preview(describeRow(row))}` }).catch(onError);
      }
      return;
    }
    await client.answerCallbackQuery({ callbackQueryId: query.id }).catch(onError);
  }

  async function receive(client) {
    const state = readState(env);
    const updates = await client.getUpdates({ offset: state.offset, timeout: longPollSeconds }, { signal: stop.signal });
    if (!Array.isArray(updates) || updates.length === 0) return;
    for (const update of updates) {
      if (aborted()) return;
      try { await handleUpdate(client, update); }
      catch (error) {
        if (error?.code === 'not-ready') {
          // Not a failure: nothing is counted, and this update and those after it wait in Telegram.
          if (!waitingSince) { waitingSince = now(); log('inbound-waiting', { why: 'no companion conversation yet' }); }
          return 'waiting';
        }
        onError(error);
        // The offset stays where it is, so Telegram hands this update back and the message is not
        // lost to a failure in the engine. Order is kept: later updates wait behind it.
        const tries = (failures.get(update.update_id) ?? 0) + 1;
        failures.set(update.update_id, tries);
        if (tries < MAX_UPDATE_TRIES) return;
        log('inbound-dropped', { updateId: update.update_id, tries, why: 'the engine refused it every time' });
      }
      failures.delete(update.update_id);
      waitingSince = undefined;
      if (typeof update.update_id === 'number') writeState({ offset: update.update_id + 1 }, env);
    }
  }

  /** One report from another chat as one inbox item; a re-delivered Telegram message is one item. */
  function fileReport({ chatId, message, text }) {
    try {
      const inbox = openInbox({ env, now });
      try {
        const firstLine = String(text).split('\n').find((line) => line.trim()) ?? '신고';
        inbox.add({
          title: firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine,
          body: String(text),
          source: 'telegram',
          sourceRef: `telegram:${chatId}:${message.message_id}`,
          reporter: nameOf(message.from, message.chat),
        });
        log('inbox-filed', { chatId, messageId: message.message_id });
      } finally { inbox.close(); }
    } catch (error) {
      // The inbox is a convenience; a failure there must not cost the conversation its message.
      onError(error);
    }
  }

  // ── Telegram, out ────────────────────────────────────────────────────────────────────────

  const preview = (text) => (text.length > 3000 ? `${text.slice(0, 3000)}…` : text);

  /**
   * A file Segno may send: it exists, and it is not one of the messenger's own secrets (Roo's
   * assertSendable keeps its state folder out, except what came in).
   */
  function sendableFile(file) {
    if (!existsSync(file)) throw new Error(`no such file: ${file}`);
    if (!statSync(file).isFile()) throw new Error(`not a file: ${file}`);
    const home = messengerPaths(env);
    const real = realpathSync(file);
    const inside = (dir) => { try { const root = realpathSync(dir); return real === root || real.startsWith(root + path.sep); } catch { return false; } };
    if (inside(home.home) && !inside(home.received) && !inside(home.voice)) throw new Error('that file belongs to the messenger and is not sent');
    return real;
  }

  /** The chat a row goes to: the paired person, or the chat it names. */
  function chatOf(row) {
    if (row.target !== 'user') return String(row.target.chatId);
    const chatId = pairedChatId(env);
    if (!chatId) throw Object.assign(new Error('no Telegram chat is paired yet'), { code: 'unpaired' });
    return chatId;
  }

  /**
   * Does what one row asks, now (Roo's telegram_reply, react, edit_message): text in as many
   * messages as it takes, each file as a photo or a document, then the voice note. Returns the
   * message ids and a note; a failure after some parts went out names them, so nothing is resent.
   */
  async function deliverRow(client, row, { text: editedText } = {}) {
    const chatId = chatOf(row);
    const toUser = row.target === 'user';
    const via = row.source === 'auto' ? 'auto' : 'tool';
    if (row.op === 'react') {
      await client.setMessageReaction({ chatId, messageId: row.messageId, emoji: row.emoji });
      return { messageIds: [], note: 'reacted' };
    }
    if (row.op === 'edit') {
      const text = row.sanitize === false ? row.text : telegramText(editedText ?? row.text);
      await client.editMessageText({ chatId, messageId: row.messageId, text });
      recordSent({ at: new Date(now()).toISOString(), chatId, toUser, text, via, media: 'edit' }, env);
      return { messageIds: [row.messageId], note: 'edited' };
    }
    const payload = row.text || row.voiceText
      ? prepareReplyPayload({ text: editedText ?? row.text, voiceText: row.voiceText, voice: row.voice, sanitize: row.sanitize })
      : { delivery: 'text' };
    const files = (row.files ?? []).map(sendableFile);
    const sent = [];
    // Roo stops "typing…" the moment a message goes out to that chat (roo-runtime.ts outbound_sent).
    stopTyping(chatId);
    const total = (payload.text ? splitText(payload.text).length : 0) + files.length;
    try {
      for (const part of payload.text ? splitText(payload.text) : []) {
        sent.push((await client.sendMessage({ chatId, text: part })).message_id);
      }
      for (const file of files) {
        const upload = PHOTO_EXTS.has(path.extname(file).toLowerCase()) ? client.sendPhoto : client.sendDocument;
        sent.push((await upload({ chatId, file })).message_id);
      }
    } catch (error) {
      throw Object.assign(new Error(`failed after ${sent.length} of ${total} part(s) went out: ${error?.message ?? error}`),
        { sentIds: sent, cause: error });
    }
    let note = '';
    if (payload.voiceText) {
      // A voice that fails never takes back text already sent; a voice-only reply fails as a whole.
      try {
        const voice = await synthesize(payload.voiceText);
        sent.push((await client.sendVoice({ chatId, file: voice.path, durationSec: voice.durationSec })).message_id);
        note = payload.delivery === 'voice' ? ' (voice)' : ' + voice';
      } catch (error) {
        if (payload.delivery === 'voice') throw Object.assign(new Error(`voice-only reply failed: ${error?.message ?? error}`), { sentIds: sent });
        note = ` (voice skipped: ${error?.message ?? error})`;
      }
    }
    const media = payload.delivery === 'voice' ? 'voice' : files.length
      ? (files.every((file) => PHOTO_EXTS.has(path.extname(file).toLowerCase())) ? 'photo' : 'document')
      : note === ' + voice' ? 'voice' : undefined;
    recordSent({ at: new Date(now()).toISOString(), chatId, toUser, via,
      text: payload.text ?? payload.voiceText ?? files.map((file) => path.basename(file)).join(', '), ...(media ? { media } : {}) }, env);
    return { messageIds: sent, note };
  }

  /**
   * The card that asks the person. A card Telegram refuses leaves the row held and is asked again
   * on a later pass, a minute apart at least; the tool that wrote the row is told it is held.
   */
  async function askApproval(client, row) {
    const last = Date.parse(row.approvalTriedAt ?? '');
    if (Number.isFinite(last) && now() - last < 60_000) return;
    updateOutboxRow(row.id, { approvalTriedAt: new Date(now()).toISOString() }, env);
    const target = row.target.name ?? row.target.chatId;
    const sent = await client.sendMessage({
      chatId: pairedChatId(env),
      text: `세뇨가 ${target}에게 보내려 합니다.\n\n${preview(describeRow(row))}`,
      keyboard: [[{ text: BUTTON_APPROVE, callback_data: `approve:${row.id}` }, { text: BUTTON_REJECT, callback_data: `reject:${row.id}` }]],
    });
    updateOutboxRow(row.id, { approvalMessageId: sent?.message_id, approvalChatId: pairedChatId(env) }, env);
  }

  /** One queued row through its gate: held for the person, or sent now. */
  async function dispatchRow(client, row) {
    const settings = readMessengerSettings(env);
    if (row.target !== 'user' && settings.approvalRequired) {
      const held = updateOutboxRow(row.id, { state: 'held', heldAt: new Date(now()).toISOString() }, env);
      if (pairedChatId(env)) await askApproval(client, held).catch(onError);
      return { state: 'held', row: readOutboxRow(row.id, env) };
    }
    try {
      const result = await deliverRow(client, row);
      updateOutboxRow(row.id, { state: 'sent', sentAt: new Date(now()).toISOString(),
        ...(result.messageIds.length ? { telegramMessageId: result.messageIds.at(-1), telegramMessageIds: result.messageIds } : {}) }, env);
      return { state: 'sent', ...result };
    } catch (error) {
      // A row that failed is not tried again on its own: a tool already told Segno, and a retry
      // would send twice whatever went out before the failure.
      if (error?.code !== 'unpaired') {
        updateOutboxRow(row.id, { state: 'failed', error: String(error?.message ?? error),
          ...(error?.sentIds?.length ? { telegramMessageIds: error.sentIds } : {}) }, env);
      }
      throw error;
    }
  }

  async function drainOutbox(client) {
    const rows = listOutbox(env);
    const decided = new Set(listDecisions(env).map((row) => row.id));
    for (const row of rows) {
      if (aborted()) return;
      try {
        if (row.state === 'queued') {
          // Telegram not paired yet: the row waits for it.
          if (row.target === 'user' && !pairedChatId(env)) continue;
          await dispatchRow(client, row).catch((error) => {
            if (error instanceof BotApiError && error.code === 403) updateOutboxRow(row.id, { state: 'failed', error: 'the chat refused the message' }, env);
            else onError(error);
          });
          continue;
        }
        if (row.state !== 'held') continue;
        if (decided.has(row.id)) {
          const decision = readDecision(row.id, env);
          if (decision?.decision === 'approve') {
            // The person may have edited the draft before approving it; that is what goes out.
            const edited = typeof decision.text === 'string' && decision.text.trim() ? decision.text : undefined;
            try {
              const result = await deliverRow(client, row, { text: edited });
              updateOutboxRow(row.id, { state: 'sent', sentAt: new Date(now()).toISOString(), decidedBy: decision.by,
                ...(edited ? { text: edited, draft: row.text } : {}),
                ...(result.messageIds.length ? { telegramMessageId: result.messageIds.at(-1), telegramMessageIds: result.messageIds } : {}) }, env);
            } catch (error) {
              updateOutboxRow(row.id, { state: 'failed', error: error instanceof BotApiError && error.code === 403
                ? 'the chat refused the message' : String(error?.message ?? error), decidedBy: decision.by }, env);
              onError(error);
            }
          } else {
            updateOutboxRow(row.id, { state: 'rejected', rejectedAt: new Date(now()).toISOString(), decidedBy: decision?.by }, env);
          }
          clearDecision(row.id, env);
          continue;
        }
        if (row.approvalMessageId === undefined && pairedChatId(env)) await askApproval(client, row);
      } catch (error) {
        onError(error);
      }
    }
  }

  /**
   * What Segno's Telegram tools ask for (pi-runtime companion-messenger, through the engine's
   * sessionLink.telegramSend): `op` 'send' (default), 'react' or 'edit'. A message to the person
   * goes out now and answers with its message ids; anything to another chat is held.
   */
  async function sendRequest(request = {}) {
    const op = request.op ?? 'send';
    const target = targetOf(request.to, request.name);
    let messageId = request.messageId ?? request.message_id;
    if (op === 'react' && (messageId === undefined || messageId === null || messageId === '') && target === 'user') {
      messageId = readState(env).lastIncoming?.messageId;
      if (messageId === undefined) throw new Error('there is no Telegram message from the person to react to yet');
    }
    const row = enqueueMessage({ op, target, source: 'tool', text: request.text, files: request.files,
      voice: request.voice, voiceText: request.voiceText ?? request.voice_text, sanitize: request.sanitize, emoji: request.emoji,
      ...(messageId === undefined || messageId === null || messageId === '' ? {} : { messageId }) }, env);
    const client = bot();
    if (!client || (target === 'user' && !pairedChatId(env)) || !readMessengerSettings(env).enabled) {
      return { ...row, note: 'Telegram is not connected yet; it goes out once it is.' };
    }
    const result = await serial(() => dispatchRow(client, readOutboxRow(row.id, env)));
    if (result.state === 'held') return { ...result.row, state: 'held' };
    return { ...readOutboxRow(row.id, env), messageIds: result.messageIds, note: result.note };
  }

  // ── the conversation, mirrored ──────────────────────────────────────────────────────────

  /**
   * Sends what the transcript gained since the last pass, oldest first (sync.mjs decides what the
   * app shows). The cursor is a byte offset and the run state at it; a text that fails to go out
   * keeps the cursor before its entry, and `sentParts` remembers how much of a long one already
   * went, so nothing is sent twice and nothing is lost.
   *
   * A conversation that already has history the first time the messenger looks is taken as read,
   * so turning Telegram on does not replay months of answers; a conversation that appears
   * afterwards (Segno's first turn) is new and everything in it goes out.
   */
  async function syncTranscript(client) {
    if (!sessionsDir) return;
    const sessionId = readCompanionState(env).sessionId;
    if (!sessionId) return;
    const file = await locateTranscript(sessionsDir, sessionId);
    const cursor = readState(env).transcript;
    if (!file) {
      if (!cursor) writeState({ transcript: { file: null, offset: 0, run: freshRun() } }, env);
      return;
    }
    const takeAsRead = async () => {
      const at = await runAt(file, { companionSessionId: sessionId });
      writeState({ transcript: { file, offset: at.offset, run: at.run } }, env);
    };
    // First look, an older cursor that counted entries, or a different file (a fork or a rewind
    // into a copy): what is there is history.
    if (!cursor || (cursor.file !== null && cursor.file !== file) || (cursor.file !== null && !Number.isInteger(cursor.offset))) {
      await takeAsRead();
      return;
    }
    let offset = Number.isInteger(cursor.offset) ? cursor.offset : 0;
    let run = cursor.run ?? freshRun();
    let sentParts = cursor.sentParts ?? 0;
    const { entries, size } = await readEntriesFrom(file, offset);
    if (size < offset) { await takeAsRead(); return; }
    for (const { entry, end } of entries) {
      if (aborted()) return;
      const next = structuredClone(run);
      const said = stepRun(next, entry, { companionSessionId: sessionId });
      if (said.some((item) => item.final)) stopAllTyping();
      // `sentParts` counts across everything this entry says, so a retry resumes where it stopped.
      let done = 0;
      for (const item of said) {
        if (!item.text || item.quiet || item.duplicate) continue;
        const skip = Math.max(0, sentParts - done);
        let parts = 0;
        try {
          await serial(() => sendSaid(client, item, { sentParts: skip, onPart: (count) => {
            parts = count;
            sentParts = done + count;
            writeState({ transcript: { file, offset, run, sentParts } }, env);
          }, countParts: (count) => { parts = count; } }));
        } catch (error) {
          onError(error);
          writeState({ transcript: { file, offset, run, sentParts } }, env);
          return;
        }
        done += parts;
      }
      offset = end;
      run = next;
      sentParts = 0;
      writeState({ transcript: { file, offset, run, sentParts } }, env);
    }
    if (cursor.file !== file) writeState({ transcript: { file, offset, run, sentParts } }, env);
  }

  /**
   * One text Segno said, where the app shows it: the person's own chat for every run but one
   * another person started, whose answer is held for approval. A text before a tool call goes
   * without a notification; the run's last answer notifies.
   */
  async function sendSaid(client, said, { sentParts, onPart, countParts }) {
    const trigger = said.trigger ?? { kind: 'unknown' };
    if (trigger.kind === 'channel' && !trigger.isUser) {
      if (!said.final) return;
      const chatId = trigger.chatId;
      if (!chatId) throw new Error('the message that woke this turn names no chat to answer');
      enqueueMessage({ text: said.text, target: { chatId, ...(trigger.name ? { name: trigger.name } : {}) }, source: 'reply',
        heldReason: '답장은 사용자 승인을 기다립니다' }, env);
      return;
    }
    const chatId = pairedChatId(env);
    if (!chatId) return;
    const text = telegramText(said.text);
    const parts = splitText(text);
    countParts?.(parts.length);
    stopTyping(chatId);
    for (let index = sentParts; index < parts.length; index += 1) {
      await client.sendMessage({ chatId, text: parts[index], ...(said.final ? {} : { disableNotification: true }) });
      onPart(index + 1);
    }
    recordSent({ at: new Date(now()).toISOString(), chatId, toUser: true, text, via: 'auto' }, env);
  }

  // ── the passes, and the loops around them ───────────────────────────────────────────────

  /** Telegram to Segno: one long poll and the updates it brought. */
  async function receivePass() {
    const settings = readMessengerSettings(env);
    if (!settings.enabled) return;
    const client = bot();
    if (!client) return;
    if (!webhookCleared) {
      // Long polling and a webhook cannot both be set; a bot made last time may still carry one.
      await client.deleteWebhook({ dropPendingUpdates: false }, { signal: stop.signal });
      webhookCleared = true;
    }
    return (await receive(client)) === 'waiting' ? 'waiting' : 'polled';
  }

  /** Segno to Telegram: the app's requests, the outbox and the conversation. */
  async function sendPass() {
    const settings = readMessengerSettings(env);
    if (!settings.enabled) { stopAllTyping(); return; }
    // A request that makes the bot or a pairing code needs no bot yet; only carrying messages does.
    await handleIntent();
    const client = bot();
    if (!client) return;
    await serial(() => drainOutbox(client));
    await syncTranscript(client);
  }

  const guarded = (work) => async () => {
    if (aborted()) return 'stopped';
    try { return await work(); }
    catch (error) {
      if (aborted() || error?.aborted) return 'stopped';
      onError(error);
      return 'failed';
    }
  };
  const runInbound = () => (inboundPass ??= guarded(receivePass)().finally(() => { inboundPass = undefined; }));
  const runOutbound = () => (outboundPass ??= guarded(sendPass)().finally(() => { outboundPass = undefined; }));

  // Two loops, so a long poll waiting on Telegram never holds back an answer going out.
  async function spin(run, pause) {
    while (!aborted()) {
      const outcome = await run();
      if (aborted()) break;
      await sleep(pause(outcome), stop.signal);
    }
  }

  /** One of each, in the order a request needs: a code to pair with, the message, the answer. */
  async function pokeAll() {
    await runOutbound();
    await runInbound();
    await runOutbound();
  }

  const ready = (async () => {
    await pokeAll();
    // A long poll is its own wait; anything else (Telegram off, no bot, a failure) waits a beat.
    inboundLoop = spin(runInbound, (outcome) => (outcome === 'polled' && longPollSeconds > 0 ? 0 : outcome === 'failed' ? pollMs * 5 : pollMs));
    outboundLoop = spin(runOutbound, () => pollMs);
  })();

  return {
    name: 'messenger',
    ready,
    /** Checks now instead of at the next turn (settings or a decision were just saved). */
    poke: pokeAll,
    /** What the companion's Telegram tools do, reached through the engine's sessionLink bridge. */
    send: sendRequest,
    async close() {
      closed = true;
      stop.abort();
      stopAllTyping();
      await inboundPass?.catch(() => {});
      await outboundPass?.catch(() => {});
      await inboundLoop?.catch(() => {});
      await outboundLoop?.catch(() => {});
    },
    /** What Settings shows, without the token. */
    status() {
      const pairing = readPairing(env);
      return { ...readBot(env), pairing, home: messengerPaths(env).home };
    },
  };
}

/**
 * The engine's resident-service entry (`pi-server resident-services.mjs`): the supervisor hands a
 * worker thread a context and gets methods back that it can call. What the messenger needs from
 * the engine arrives as `ctx.host.channel` and `ctx.connect` (the session stats /context reads);
 * what the tools need is the returned `send`.
 *
 *   ctx = { name, env, agentDir, options, host: { channel, notice }, connect, onError, log, signal }
 */
export async function start(ctx = {}) {
  if (typeof ctx.host?.channel !== 'function') {
    // An engine that is not hosting conversations (a bare test engine) has nowhere to deliver. It
    // must not throw: the thread would be restarted on a backoff for no reason. This service then
    // stays idle, and so do the tools it backs.
    ctx.log?.('messenger-idle', { why: 'the engine has no conversation host' });
    return {
      name: 'messenger',
      ready: Promise.resolve(),
      poke: async () => {},
      send: async () => { throw new Error('the messenger is idle: this engine has no conversation host'); },
      close: async () => {},
    };
  }
  return startCompanionMessenger({
    deliver: (args) => ctx.host.channel(args),
    env: ctx.env ?? process.env,
    agentDir: ctx.agentDir,
    onError: ctx.onError ?? (() => {}),
    log: ctx.log ?? (() => {}),
    ...(typeof ctx.connect === 'function' ? { sessionStats: (sessionId) => statsOver(ctx.connect, sessionId) } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.options?.createApi ? { createApi: ctx.options.createApi } : {}),
  });
}

/** Segno's session stats through a client of this engine, released at once. */
async function statsOver(connect, sessionId) {
  const client = await connect();
  try {
    await client.attach(sessionId);
    return await client.command({ type: 'get_session_stats' });
  } finally {
    await client.detach?.().catch(() => {});
    await client.close?.().catch(() => {});
  }
}

export default startCompanionMessenger;
