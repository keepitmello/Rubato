// The Telegram Bot API, as this product uses it: long polling, one text message, a confirm card
// with two buttons, and the API's own answer to a button press. Nothing here knows about Segno.
//
// `baseUrl` is a seam: a fake server in tests (and in the sandbox run) stands in for
// https://api.telegram.org without a token ever leaving the disk.
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

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

  async function invoke(method, params = {}, { signal, timeout = timeoutMs } = {}) {
    if (signal?.aborted) throw Object.assign(new Error(`${method}: aborted`), { name: 'AbortError', aborted: true });
    const timer = new AbortController();
    const deadline = setTimeout(() => timer.abort(), timeout);
    deadline.unref?.();
    const abort = () => timer.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let response;
    try {
      response = await call(`${root}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: timer.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error(`${method}: aborted`), { name: 'AbortError', aborted: true });
      throw error;
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

  return {
    getMe: (options) => invoke('getMe', {}, options),
    deleteWebhook: ({ dropPendingUpdates = false } = {}, options) => invoke('deleteWebhook', { drop_pending_updates: dropPendingUpdates }, options),
    /** Long polling: the call itself waits up to `timeout` seconds for a new update. */
    getUpdates: ({ offset, timeout = 25, limit = 100, allowedUpdates = ['message', 'callback_query'] } = {}, options) =>
      invoke('getUpdates', { ...(offset === undefined ? {} : { offset }), timeout, limit, allowed_updates: allowedUpdates },
        { ...options, timeout: (options?.timeoutMs ?? timeoutMs) + timeout * 1000 }),
    sendMessage: ({ chatId, text, replyToMessageId, keyboard }, options) => invoke('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyToMessageId === undefined ? {} : { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }),
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }, options),
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

