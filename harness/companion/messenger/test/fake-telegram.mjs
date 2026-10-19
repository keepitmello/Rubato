// A Telegram Bot API that runs in this process: the same calls the service makes, the same answers
// the real API gives, and a record of everything it was asked to send. Tests drive it: push an
// update, then look at what came out.
export function fakeTelegram() {
  const sent = [];
  const edited = [];
  const answered = [];
  const updates = [];
  let nextUpdateId = 1;
  let nextMessageId = 100;
  let offset = 0;
  let webhookCleared = 0;

  const api = {
    async getMe() { return { id: 42, is_bot: true, first_name: 'Segno', username: 'segno_test_bot' }; },
    async deleteWebhook() { webhookCleared += 1; return true; },
    async getUpdates({ offset: asked } = {}) {
      if (asked !== undefined) offset = Math.max(offset, asked);
      const batch = updates.filter((update) => update.update_id >= offset);
      return batch;
    },
    async sendMessage({ chatId, text, replyToMessageId, keyboard }) {
      const row = { chatId: String(chatId), text, replyToMessageId, keyboard, message_id: nextMessageId++ };
      sent.push(row);
      return { message_id: row.message_id };
    },
    async editMessageText(args) { edited.push(args); return true; },
    async answerCallbackQuery(args) { answered.push(args); return true; },
  };

  return {
    api, sent, edited, answered,
    get webhookCleared() { return webhookCleared; },
    /** A message someone wrote to the bot. */
    message({ chatId, text, from, chatType = 'private', messageId, title }) {
      const update = {
        update_id: nextUpdateId++,
        message: {
          message_id: messageId ?? nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(chatId), type: chatType, ...(title ? { title } : {}) },
          from: { id: Number(chatId), is_bot: false, first_name: from ?? 'User' },
          ...(text === undefined ? {} : { text }),
        },
      };
      updates.push(update);
      return update;
    },
    /** A press on one of a card's buttons. */
    press({ chatId, data, messageId }) {
      const update = {
        update_id: nextUpdateId++,
        callback_query: {
          id: `cb_${nextUpdateId}`,
          from: { id: Number(chatId), is_bot: false, first_name: 'User' },
          data,
          message: { message_id: messageId ?? 1, chat: { id: Number(chatId), type: 'private' } },
        },
      };
      updates.push(update);
      return update;
    },
    /** The fake's own message counter, so a test can name a message id that will exist. */
    peekNextMessageId() { return nextMessageId; },
  };
}

