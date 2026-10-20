// The Telegram Bot API, as this product uses it: long polling, text, photos, files and voice
// notes out, files in, a confirm card with two buttons and the API's own answer to a button
// press, reactions, edits and the typing indicator. Nothing here knows about Segno.
//
// `baseUrl` is a seam: a fake server in tests (and in the sandbox run) stands in for
// https://api.telegram.org without a token ever leaving the disk.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** The Bot API hands a bot files up to this size (getFile); larger ones it refuses. */
export const DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
/** A bot may upload files up to this size. */
export const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXT = Object.freeze({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json' });
const mimeOf = (file) => MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** A message that may carry a bot token (a file URL does) with the token taken out. */
export function redactToken(text) {
  return String(text ?? '').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]');
}

export class BotApiError extends Error {
  constructor(method, { errorCode, description, retryAfter } = {}) {
    super(`${method}: ${description ?? 'request failed'}${errorCode ? ` (${errorCode})` : ''}`);
    this.name = 'BotApiError';
    this.method = method;
    this.code = errorCode;
    this.retryAfter = retryAfter;
  }
}

/**
 * @param {{ token: string, baseUrl?: string, fetch?: typeof fetch, timeoutMs?: number }} options
 *   `baseUrl` defaults to the real API; a fake server is a URL of the same shape.
 */
export function createBotApi({ token, baseUrl = TELEGRAM_API_BASE, fetch: call = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (typeof token !== 'string' || !token) throw new TypeError('a bot token is required');
  if (typeof call !== 'function') throw new TypeError('fetch is required');
  const root = baseUrl.replace(/\/+$/, '');

  async function invoke(method, params = {}, { signal, timeout = timeoutMs, form } = {}) {
    if (signal?.aborted) throw Object.assign(new Error(`${method}: aborted`), { name: 'AbortError', aborted: true });
    const timer = new AbortController();
    const deadline = setTimeout(() => timer.abort(), timeout);
    deadline.unref?.();
    const abort = () => timer.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let response;
    try {
      response = await call(`${root}/bot${token}/${method}`, form
        ? { method: 'POST', body: form, signal: timer.signal }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: timer.signal });
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error(`${method}: aborted`), { name: 'AbortError', aborted: true });
      // A network failure's message may name the URL, and the URL holds the token.
      throw new Error(`${method}: ${redactToken(error?.message ?? error)}`);
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
    }
    let body;
    try { body = await response.json(); }
    catch { throw new BotApiError(method, { errorCode: response.status, description: 'the response was not JSON' }); }
    if (!body?.ok) {
      throw new BotApiError(method, {
        errorCode: body?.error_code ?? response.status,
        description: body?.description,
        retryAfter: body?.parameters?.retry_after,
      });
    }
    return body.result;
  }

  /** One local file as a multipart upload, with the other fields beside it. */
  async function upload(method, field, file, params, options) {
    const bytes = await readFile(file);
    if (bytes.length > UPLOAD_LIMIT_BYTES) throw new BotApiError(method, { description: `the file is over ${UPLOAD_LIMIT_BYTES} bytes` });
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    form.append(field, new Blob([bytes], { type: mimeOf(file) }), path.basename(file));
    return invoke(method, params, { ...options, form, timeout: Math.max(timeoutMs, 120_000) });
  }

  const common = ({ chatId, replyToMessageId, disableNotification }) => ({
    chat_id: chatId,
    ...(replyToMessageId === undefined ? {} : { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }),
    ...(disableNotification ? { disable_notification: true } : {}),
  });

  return {
    getMe: (options) => invoke('getMe', {}, options),
    deleteWebhook: ({ dropPendingUpdates = false } = {}, options) => invoke('deleteWebhook', { drop_pending_updates: dropPendingUpdates }, options),
    /** Long polling: the call itself waits up to `timeout` seconds for a new update. */
    getUpdates: ({ offset, timeout = 25, limit = 100, allowedUpdates = ['message', 'callback_query'] } = {}, options) =>
      invoke('getUpdates', { ...(offset === undefined ? {} : { offset }), timeout, limit, allowed_updates: allowedUpdates },
        { ...options, timeout: (options?.timeoutMs ?? timeoutMs) + timeout * 1000 }),
    sendMessage: ({ chatId, text, replyToMessageId, keyboard, disableNotification }, options) => invoke('sendMessage', {
      ...common({ chatId, replyToMessageId, disableNotification }),
      text,
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }, options),
    sendPhoto: ({ chatId, file, caption, replyToMessageId, disableNotification }, options) =>
      upload('sendPhoto', 'photo', file, { ...common({ chatId, replyToMessageId, disableNotification }), caption }, options),
    sendDocument: ({ chatId, file, caption, replyToMessageId, disableNotification }, options) =>
      upload('sendDocument', 'document', file, { ...common({ chatId, replyToMessageId, disableNotification }), caption }, options),
    /** A voice note: OGG/Opus (or MP3, M4A) shown as a playable bubble. */
    sendVoice: ({ chatId, file, durationSec, replyToMessageId, disableNotification }, options) =>
      upload('sendVoice', 'voice', file, { ...common({ chatId, replyToMessageId, disableNotification }),
        ...(durationSec ? { duration: durationSec } : {}) }, options),
    /** "typing…" under the bot's name; Telegram shows it for five seconds or until a message. */
    sendChatAction: ({ chatId, action = 'typing' }, options) => invoke('sendChatAction', { chat_id: chatId, action }, options),
    /** One emoji reaction on a message, replacing the bot's earlier one; an empty emoji clears it. */
    setMessageReaction: ({ chatId, messageId, emoji }, options) => invoke('setMessageReaction', {
      chat_id: chatId, message_id: messageId, reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    }, options),
    getFile: ({ fileId }, options) => invoke('getFile', { file_id: fileId }, options),
    /** The bytes of a file getFile named. Errors never carry the URL: it holds the token. */
    async downloadFile({ filePath }, { signal } = {}) {
      let response;
      try { response = await call(`${root}/file/bot${token}/${filePath}`, { signal: signal ?? AbortSignal.timeout(120_000) }); }
      catch { throw new BotApiError('downloadFile', { description: 'the file download failed' }); }
      if (!response.ok) throw new BotApiError('downloadFile', { errorCode: response.status, description: 'the file download was refused' });
      return Buffer.from(await response.arrayBuffer());
    },
    editMessageText: ({ chatId, messageId, text, keyboard }, options) => invoke('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }, options),
    answerCallbackQuery: ({ callbackQueryId, text }, options) => invoke('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    }, options),
  };
}

