// A Telegram Bot API over HTTP, for tests and for a sandbox run that must not touch the real
// Telegram: point `RUBATO_TELEGRAM_API_BASE` at it and the messenger cannot tell the difference.
//
//   node fake-telegram-server.mjs --port 8081 --token 123:test
//
// Test control (not part of the Bot API):
//   POST /_push   {"message": {...}} or {"callback_query": {...}}   an update for getUpdates
//   POST /_press  {"chatId": 777, "data": "approve:m_1", "messageId": 5}
//   POST /_file   {"fileId": "f1", "path": "photos/a.jpg", "base64": "..."}   a file getFile can name
//   GET  /_sent   every message, upload, edit, reaction and chat action this server received
import { createServer } from 'node:http';

export function createFakeTelegramServer({ token = '123456:test', port = 0 } = {}) {
  const sent = [];
  const edited = [];
  const answered = [];
  const uploads = [];
  const reactions = [];
  const actions = [];
  const files = new Map();
  const updates = [];
  let nextUpdateId = 1;
  let nextMessageId = 100;
  let offset = 0;

  const api = {
    getMe: () => ({ id: 42, is_bot: true, first_name: 'Segno', username: 'segno_test_bot' }),
    deleteWebhook: () => true,
    getUpdates: (params) => {
      if (typeof params?.offset === 'number') offset = Math.max(offset, params.offset);
      return updates.filter((update) => update.update_id >= offset);
    },
    sendMessage: (params) => {
      const row = { chatId: String(params.chat_id), text: params.text, replyToMessageId: params.reply_parameters?.message_id,
        keyboard: params.reply_markup?.inline_keyboard, message_id: nextMessageId++, at: Date.now() };
      sent.push(row);
      return { message_id: row.message_id, chat: { id: Number(row.chatId) }, date: Math.floor(Date.now() / 1000), text: row.text };
    },
    sendPhoto: (params) => uploaded('photo', params),
    sendDocument: (params) => uploaded('document', params),
    sendVoice: (params) => uploaded('voice', params),
    sendChatAction: (params) => { actions.push({ chatId: String(params.chat_id), action: params.action, at: Date.now() }); return true; },
    setMessageReaction: (params) => {
      reactions.push({ chatId: String(params.chat_id), messageId: Number(params.message_id), reaction: params.reaction, at: Date.now() });
      return true;
    },
    getFile: (params) => {
      const file = files.get(params.file_id);
      if (!file) throw Object.assign(new Error('Bad Request: invalid file_id'), { code: 400 });
      return { file_id: params.file_id, file_unique_id: `u_${params.file_id}`, file_size: file.bytes.length, file_path: file.path };
    },
    editMessageText: (params) => {
      edited.push({ chatId: String(params.chat_id), messageId: params.message_id, text: params.text, at: Date.now() });
      return true;
    },
    answerCallbackQuery: (params) => {
      answered.push({ id: params.callback_query_id, text: params.text, at: Date.now() });
      return true;
    },
  };

  function uploaded(kind, params) {
    const row = { kind, chatId: String(params.chat_id), caption: params.caption, name: params[kind]?.name,
      bytes: params[kind]?.bytes, disableNotification: params.disable_notification === 'true', message_id: nextMessageId++, at: Date.now() };
    uploads.push(row);
    return { message_id: row.message_id, chat: { id: Number(row.chatId) }, date: Math.floor(Date.now() / 1000) };
  }

  /** The body as fields: JSON, or a multipart upload whose file parts arrive as `{ name, bytes }`. */
  async function fieldsOf(request, raw) {
    const type = String(request.headers['content-type'] ?? '');
    if (!type.startsWith('multipart/form-data')) return raw.length ? JSON.parse(raw.toString('utf8')) : {};
    const form = await new Response(raw, { headers: { 'content-type': type } }).formData();
    const fields = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        try { fields[key] = /^[[{]/.test(value) ? JSON.parse(value) : value; } catch { fields[key] = value; }
      } else fields[key] = { name: value.name, bytes: Buffer.from(await value.arrayBuffer()) };
    }
    return fields;
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (status, body) => {
      const text = JSON.stringify(body);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      response.end(text);
    };
    if (request.method === 'GET' && url.pathname === '/_sent')
      return send(200, { sent, edited, answered, reactions, actions, uploads: uploads.map(({ bytes, ...row }) => ({ ...row, size: bytes?.length })) });
    const download = request.method === 'GET' && url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (download) {
      const file = [...files.values()].find((entry) => entry.path === download[2]);
      if (download[1] !== token || !file) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.bytes.length });
      response.end(file.bytes);
      return;
    }

    const chunks = [];
    request.on('data', (chunk) => { chunks.push(chunk); });
    request.on('end', async () => {
      let body = {};
      try { body = await fieldsOf(request, Buffer.concat(chunks)); } catch { return send(400, { ok: false, description: 'bad body' }); }
      if (url.pathname === '/_file') {
        files.set(body.fileId, { path: body.path, bytes: Buffer.from(body.base64 ?? '', 'base64') });
        return send(200, { ok: true });
      }
      if (url.pathname === '/_push') {
        const update = { update_id: nextUpdateId++, ...body };
        updates.push(update);
        return send(200, { ok: true, update });
      }
      if (url.pathname === '/_press') {
        const update = { update_id: nextUpdateId++, callback_query: { id: `cb_${nextUpdateId}`,
          from: { id: Number(body.chatId), is_bot: false, first_name: 'User' }, data: body.data,
          message: { message_id: body.messageId ?? 1, chat: { id: Number(body.chatId), type: 'private' } } } };
        updates.push(update);
        return send(200, { ok: true, update });
      }
      const match = url.pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
      if (!match) return send(404, { ok: false, description: 'not found' });
      const [, askedToken, method] = match;
      if (askedToken !== token) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const handler = api[method];
      if (typeof handler !== 'function') return send(404, { ok: false, error_code: 404, description: 'Not Found' });
      try { return send(200, { ok: true, result: handler(body) }); }
      catch (error) { const code = error?.code ?? 500; return send(code, { ok: false, error_code: code, description: String(error?.message ?? error) }); }
    });
  });

  return {
    sent, edited, answered, uploads, reactions, actions,
    /** A file Telegram holds, as getFile and the file URL will hand it out. */
    addFile(fileId, filePath, bytes) { files.set(fileId, { path: filePath, bytes: Buffer.from(bytes) }); },
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      const address = server.address();
      return { url: `http://127.0.0.1:${address.port}`, port: address.port };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  const fake = createFakeTelegramServer({ token: arg('token', '123456:test'), port: Number(arg('port', 8081)) });
  const { url } = await fake.listen();
  console.log(`fake Telegram Bot API at ${url} for token ${arg('token', '123456:test')}`);
  process.on('SIGTERM', async () => { await fake.close(); process.exit(0); });
  process.on('SIGINT', async () => { await fake.close(); process.exit(0); });
  // Prints what it receives, so a sandbox run can be followed from a terminal.
  setInterval(() => {
    while (fake.sent.length) console.log('sent', JSON.stringify(fake.sent.shift()));
  }, 500).unref?.();
}

