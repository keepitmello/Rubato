// The Telegram messenger, resident in the engine: it carries the person's own Telegram chat to
// Segno and Segno's words back, and it holds every message addressed to anyone else until the
// person approves it.
//
// What it does, in one pass:
//   - a message from the person's chat goes into Segno's conversation as the person's own message,
//     with Telegram named as where it came from;
//   - a message from another chat (a group where bug reports arrive) goes in as another person's
//     words, with no authority over Segno's settings;
//   - Segno's finished answers come back out: the answer to a Telegram message, the daily report,
//     a heartbeat note and a lead's ending go to the person; the answer to another person is held;
//   - anything Segno addresses to another chat is held until the person approves it, from the
//     Telegram card or from Settings › Companion.
//
// The service is the only thing that talks to Telegram, and the only writer of its own files.
// Everything it needs from the engine arrives through `deliver`; everything it needs from the app
// is a file in the companion's home (store.mjs). A failure here ends this service, not the engine
// and not a running conversation.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBotApi, BotApiError } from './bot-api.mjs';
import {
  MESSENGER_LIMITS, clearDecision, enqueueMessage, listDecisions, listOutbox, messengerPaths, newPairingCode,
  pairedChatId, readBot, readDecision, readHandoff, readIntent, readMessengerSettings, readPairing, readSecret,
  readOutboxRow, readState, updateOutboxRow, writeBotIdentity, writeDecision, writeHandoff, writePairing, writeSecret, writeState,
} from './store.mjs';
import { answerAt, isFinalAnswer, locateTranscript, readEntries } from './transcript.mjs';
import { readState as readCompanionState } from '../companion.mjs';
import { openInbox } from '../inbox.mjs';

/** The keeper's own words; a heartbeat turn is recognised by the notice text it woke on. */
const HEARTBEAT_PREFIX = 'Heartbeat.';
const DAILY_PREFIX = 'Daily report time.';

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

/** One message's text cut to what one Telegram message may hold, at a word or a character. */
export function splitText(text, limit = MESSENGER_LIMITS.textChars) {
  const whole = String(text ?? '').trim();
  if (whole.length <= limit) return whole ? [whole] : [];
  const parts = [];
  let rest = whole;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '), limit - 200);
    const at = cut > limit * 0.5 ? cut : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

const CREATE_BOT_SCRIPT = fileURLToPath(new URL('./scripts/create-bot.mjs', import.meta.url));
/** The usernames tried in order when the person did not name one; @BotFather refuses the taken ones. */
export const DEFAULT_BOT_USERNAMES = Object.freeze(['segno_rubato_bot', 'segno_companion_bot', 'segno_bot', 'rubato_segno_bot']);

/** Makes the bot over MTProto from the person's own account (`scripts/create-bot.mjs`). */
export function createBotOverMtproto({ name = 'Segno', username } = {}) {
  const usernames = [...new Set([...(username ? [username] : []), ...DEFAULT_BOT_USERNAMES])];
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

/** What a message says when it carries no text: Segno should still know something arrived. */
function saidText(message) {
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  if (typeof message.caption === 'string' && message.caption.trim()) return message.caption;
  if (message.photo) return '[사진을 보냈습니다]';
  if (message.voice || message.audio) return '[음성 메시지를 보냈습니다]';
  if (message.document) return `[파일을 보냈습니다: ${message.document.file_name ?? '이름 없음'}]`;
  return '[내용 없는 메시지]';
}

/**
 * @param {{
 *   deliver: (args: { channel: string, from: object, text: string }) => Promise<unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   agentDir?: string,
 *   onError?: (error: unknown) => void,
 *   log?: (event: string, details?: object) => void,
 *   createApi?: (token: string) => object,
 *   createBot?: (args: { name?: string, username?: string }) => Promise<{ token: string, username?: string, name?: string }>,
 *   signal?: AbortSignal,
 *   pollMs?: number,
 *   longPollSeconds?: number,
 *   now?: () => number,
 * }} options
 *   `deliver` is the engine's `host.channel` (pi-server resident-services): it puts the text in
 *   Segno's conversation as a channel message. `createApi` and `createBot` are seams for tests.
 */
export function startCompanionMessenger({
  deliver, env = process.env, agentDir, onError = () => {}, log = () => {},
  createApi = (token) => createBotApi({ token, baseUrl: env.RUBATO_TELEGRAM_API_BASE || undefined }),
  createBot = createBotOverMtproto, signal, pollMs = 1000, longPollSeconds = 25, now = Date.now,
} = {}) {
  if (typeof deliver !== 'function') throw new TypeError('deliver is required');
  const sessionsDir = agentDir ? path.join(agentDir, 'sessions') : undefined;
  let closed = false;
  let api;
  let apiToken;
  let webhookCleared = false;
  let ticking;
  let loop;
  let inboundSeen = new Map();
  /** Updates whose delivery failed, so one that always fails cannot wedge the rest forever. */
  const failures = new Map();
  const stop = new AbortController();
  if (signal) signal.addEventListener('abort', () => stop.abort(), { once: true });

  const aborted = () => closed || stop.signal.aborted;

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

  /** Telegram refuses a band of messages from one chat in one minute; these are generous. */
  function allowedInbound(chatId) {
    const at = now();
    const recent = (inboundSeen.get(chatId) ?? []).filter((time) => at - time < 60_000);
    if (recent.length >= 30) { inboundSeen.set(chatId, recent); return false; }
    recent.push(at);
    inboundSeen.set(chatId, recent);
    return true;
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

  async function handleUpdate(client, update) {
    if (update.callback_query) return handleCallback(client, update.callback_query);
    const message = update.message;
    if (!message || message.from?.is_bot) return;
    const chatId = String(message.chat?.id ?? '');
    if (!chatId) return;
    const pairing = readPairing(env);
    const text = saidText(message);
    const userChat = pairedChatId(env);

    if (userChat === chatId) {
      if (!allowedInbound(chatId)) { log('inbound-dropped', { chatId }); return; }
      const to = readCompanionState(env).sessionId;
      if (!to) { log('inbound-dropped', { chatId, why: 'no companion conversation yet' }); return; }
      await deliver({
        to,
        channel: 'telegram',
        from: { channel: 'telegram', chatId, name: nameOf(message.from, message.chat), isUser: true, messageId: message.message_id },
        text,
      });
      log('inbound-user', { chatId, messageId: message.message_id });
      return;
    }
    if (pairing.status === 'pending' && message.chat?.type === 'private') {
      const typed = text.trim().replace(/^\/pair\s*/i, '').toUpperCase();
      if (pairing.code && typed === pairing.code) {
        writePairing({ status: 'paired', chat: { chatId, name: nameOf(message.from, message.chat),
          ...(message.from?.username ? { username: message.from.username } : {}), pairedAt: new Date(now()).toISOString() } }, env);
        await client.sendMessage({ chatId, text: '연결됐습니다. 이제 여기서 세뇨와 이야기하면 됩니다.' });
        log('paired', { chatId });
        return;
      }
    }
    if (message.chat?.type === 'group' || message.chat?.type === 'supergroup') {
      if (!allowedInbound(chatId)) { log('inbound-dropped', { chatId }); return; }
      // Someone else's report belongs in Segno's inbox whether or not its conversation is up: the
      // list is what the person reads, and a message must not be lost to a restarting engine.
      fileReport({ chatId, message, text });
      const to = readCompanionState(env).sessionId;
      if (!to) { log('inbound-dropped', { chatId, why: 'no companion conversation yet' }); return; }
      await deliver({
        to,
        channel: 'telegram',
        from: { channel: 'telegram', chatId, name: nameOf(message.from, message.chat), isUser: false, messageId: message.message_id },
        text: `${saidText(message)}\n\n(보낸 곳: ${message.chat.title ?? chatId})`,
      });
      log('inbound-other', { chatId, messageId: message.message_id });
    }
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
          text: `${action === 'approve' ? '✅ 보냄' : '❌ 보내지 않음'} — ${target}\n\n${preview(row.text)}` }).catch(onError);
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
        onError(error);
        // The offset stays where it is, so Telegram hands this update back and the message is not
        // lost to a failure in the engine. Order is kept: later updates wait behind it.
        const tries = (failures.get(update.update_id) ?? 0) + 1;
        failures.set(update.update_id, tries);
        if (tries < MAX_UPDATE_TRIES) return;
        log('inbound-dropped', { updateId: update.update_id, tries, why: 'the engine refused it every time' });
      }
      failures.delete(update.update_id);
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

  async function sendToUser(client, text, { replyToMessageId } = {}) {
    const chatId = pairedChatId(env);
    if (!chatId) throw new Error('no Telegram chat is paired yet');
    let last;
    for (const part of splitText(text)) {
      last = await client.sendMessage({ chatId, text: part, ...(replyToMessageId === undefined ? {} : { replyToMessageId }) });
      replyToMessageId = undefined;
    }
    return last;
  }

  async function sendToChat(client, chatId, text) {
    let last;
    for (const part of splitText(text)) last = await client.sendMessage({ chatId, text: part });
    return last;
  }

  async function askApproval(client, row) {
    const target = row.target.name ?? row.target.chatId;
    const sent = await client.sendMessage({
      chatId: pairedChatId(env),
      text: `세뇨가 ${target}에게 보내려 합니다.\n\n${preview(row.text)}`,
      keyboard: [[{ text: BUTTON_APPROVE, callback_data: `approve:${row.id}` }, { text: BUTTON_REJECT, callback_data: `reject:${row.id}` }]],
    });
    updateOutboxRow(row.id, { approvalMessageId: sent?.message_id, approvalChatId: pairedChatId(env) }, env);
  }

  async function drainOutbox(client) {
    const settings = readMessengerSettings(env);
    const rows = listOutbox(env);
    const decided = new Set(listDecisions(env).map((row) => row.id));
    for (const row of rows) {
      if (aborted()) return;
      try {
        if (row.state === 'queued') {
          const toUser = row.target === 'user';
          if (!toUser && settings.approvalRequired) {
            updateOutboxRow(row.id, { state: 'held', heldAt: new Date(now()).toISOString() }, env);
            if (pairedChatId(env)) await askApproval(client, readOutboxRow(row.id, env));
            continue;
          }
          const sent = toUser ? await sendToUser(client, row.text) : await sendToChat(client, row.target.chatId, row.text);
          updateOutboxRow(row.id, { state: 'sent', sentAt: new Date(now()).toISOString(),
            ...(sent?.message_id === undefined ? {} : { telegramMessageId: sent.message_id }) }, env);
          continue;
        }
        if (row.state !== 'held') continue;
        if (decided.has(row.id)) {
          const decision = readDecision(row.id, env);
          if (decision?.decision === 'approve') {
            const sent = await sendToChat(client, row.target.chatId, row.text);
            updateOutboxRow(row.id, { state: 'sent', sentAt: new Date(now()).toISOString(), decidedBy: decision.by,
              ...(sent?.message_id === undefined ? {} : { telegramMessageId: sent.message_id }) }, env);
          } else {
            updateOutboxRow(row.id, { state: 'rejected', rejectedAt: new Date(now()).toISOString(), decidedBy: decision?.by }, env);
          }
          clearDecision(row.id, env);
          continue;
        }
        if (row.approvalMessageId === undefined && pairedChatId(env)) await askApproval(client, row);
      } catch (error) {
        if (error instanceof BotApiError && error.code === 403) {
          updateOutboxRow(row.id, { state: 'failed', error: 'the chat refused the message' }, env);
        } else onError(error);
      }
    }
  }

  // ── Segno's own answers ─────────────────────────────────────────────────────────────────

  /**
   * Sends every finished answer the transcript gained since the last pass, oldest first.
   *
   * The ledger is a position in the transcript — how many entries were already accounted for — not a
   * list of entry ids. A transcript only grows, so the position always moves forward, no matter how
   * many turns pass; a rewind that drops entries resyncs to what is there without replaying.
   * A conversation that already has history the first time the messenger looks is taken as read, so
   * turning Telegram on does not replay months of answers; a conversation that appears afterwards
   * (Segno's first turn) is new and every answer in it goes out.
   */
  async function answerTranscript(client) {
    if (!sessionsDir) return;
    const sessionId = readCompanionState(env).sessionId;
    if (!sessionId) return;
    const file = await locateTranscript(sessionsDir, sessionId);
    const state = readState(env);
    if (!file) {
      if (!state.transcript) writeState({ transcript: { file: null, seen: null } }, env);
      return;
    }
    const entries = await readEntries(file);
    let cursor = state.transcript;
    if (!cursor) {
      // First look, and the conversation already holds answers: they are history, not messages.
      writeState({ transcript: { file, seen: entries.length } }, env);
      return;
    }
    if (cursor.file !== null && cursor.file !== file) {
      // A different conversation file (a fork or a rewind): take what is there as read.
      writeState({ transcript: { file, seen: entries.length } }, env);
      return;
    }
    let seen = cursor.seen ?? 0;
    if (entries.length < seen) seen = 0;
    if (seen === entries.length) {
      if (cursor.file !== file) writeState({ transcript: { file, seen } }, env);
      return;
    }
    for (let index = seen; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!isFinalAnswer(entry)) continue;
      const answer = answerAt(entries, index, { companionSessionId: sessionId });
      if (answer.text && routesOut(answer.trigger)) {
        try { await routeAnswer(client, answer); }
        catch (error) {
          // The cursor stays before this answer: the next pass sends it, in order, instead of losing it.
          onError(error);
          writeState({ transcript: { file, seen: index } }, env);
          return;
        }
      }
      writeState({ transcript: { file, seen: index + 1 } }, env);
    }
    writeState({ transcript: { file, seen: entries.length } }, env);
  }

  /** Whether this turn's answer has somewhere to go: the person, or another chat (held). */
  function routesOut(trigger) {
    if (!trigger) return false;
    return trigger.kind === 'channel' || trigger.kind === 'notice';
  }

  async function routeAnswer(client, answer) {
    const trigger = answer.trigger ?? { kind: 'unknown' };
    if (trigger.kind === 'channel' && trigger.isUser) {
      await sendToUser(client, answer.text, { replyToMessageId: trigger.incomingMessageId });
      return;
    }
    if (trigger.kind === 'channel') {
      const chatId = trigger.chatId;
      if (!chatId) throw new Error('the message that woke this turn names no chat to answer');
      enqueueMessage({ text: answer.text, target: { chatId, ...(trigger.name ? { name: trigger.name } : {}) }, source: 'reply',
        heldReason: '답장은 사용자 승인을 기다립니다' }, env);
      return;
    }
    if (trigger.kind === 'notice') {
      const own = trigger.own === true;
      const heartbeat = own && String(trigger.text ?? '').startsWith(HEARTBEAT_PREFIX);
      const daily = own && String(trigger.text ?? '').startsWith(DAILY_PREFIX);
      if (heartbeat || daily || !own) await sendToUser(client, answer.text);
    }
  }

  // ── one pass, and the loop around it ────────────────────────────────────────────────────

  async function pass() {
    const settings = readMessengerSettings(env);
    if (!settings.enabled) return;
    // A request that makes the bot or a pairing code needs no bot yet; only carrying messages does.
    await handleIntent();
    const client = bot();
    if (!client) return;
    if (!webhookCleared) {
      // Long polling and a webhook cannot both be set; a bot made last time may still carry one.
      await client.deleteWebhook({ dropPendingUpdates: false }, { signal: stop.signal });
      webhookCleared = true;
    }
    await receive(client);
    await drainOutbox(client);
    await answerTranscript(client);
  }

  async function tick() {
    if (aborted()) return;
    try { await pass(); }
    catch (error) {
      if (aborted() || error?.aborted) return;
      onError(error);
    }
  }

  const run = () => (ticking ??= tick().finally(() => { ticking = undefined; }));

  async function spin() {
    while (!aborted()) {
      await run();
      if (aborted()) break;
      await sleep(pollMs, stop.signal);
    }
  }

  const ready = (async () => {
    const first = await run();
    loop = spin();
    return first;
  })();

  return {
    name: 'messenger',
    ready,
    /** Checks now instead of at the next turn (settings or a decision were just saved). */
    poke: run,
    /**
     * What the companion's `telegram_send` tool does, reached through the engine's sessionLink
     * bridge: it only queues, and the loop below holds or sends it.
     */
    send({ text, to, name } = {}) {
      return enqueueMessage({ text, target: targetOf(to, name), source: 'tool' }, env);
    },
    async close() {
      closed = true;
      stop.abort();
      await ticking?.catch(() => {});
      await loop?.catch(() => {});
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
 * the engine arrives as `ctx.host.channel`; what the tools need is the returned `send`.
 *
 *   ctx = { name, env, agentDir, options, host: { channel, notice }, onError, log, signal }
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
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.options?.createApi ? { createApi: ctx.options.createApi } : {}),
  });
}

export default startCompanionMessenger;

