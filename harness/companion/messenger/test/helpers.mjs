// What the messenger's tests share: a sandboxed companion home, a service on the in-process fake
// Telegram, a paired person, and transcripts written the way the engine writes them.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startCompanionMessenger } from '../service.mjs';
import { fakeTelegram } from './fake-telegram.mjs';
import { readPairing, writeIntent, writeSecret } from '../store.mjs';
import { writeSettings as writeCompanionSettings, writeState as writeCompanionState } from '../../companion.mjs';
import { buildSessionMessage, parseDelivery } from '../../../pi-runtime/features/session-link/message.mjs';

export const TOKEN = '123456789:AAaaBBbbCCccDDddEEeeFFffGGhh';
export const USER_CHAT = '777';
export const GROUP_CHAT = '-1001234567890';

export function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-messenger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { RUBATO_COMPANION_HOME: path.join(dir, 'companion'), HOME: dir };
  const agentDir = path.join(dir, 'agent');
  mkdirSync(agentDir, { recursive: true });
  // The companion is on: that is when the messenger carries the person's words to it.
  writeCompanionSettings({ enabled: true }, env);
  return { dir, env, agentDir };
}

export function start({ env, agentDir, fake, createBot, ...options }) {
  const delivered = [];
  const errors = [];
  const service = startCompanionMessenger({
    deliver: async (args) => { delivered.push(args); },
    env, agentDir,
    createApi: () => fake.api,
    ...(createBot ? { createBot } : {}),
    pollMs: 3_600_000, longPollSeconds: 0,
    onError: (error) => errors.push(error),
    ...options,
  });
  return { service, delivered, errors };
}

/** Waits for the pass in flight and runs one more, so everything pushed before is handled. */
export async function settle(service) {
  await service.ready;
  await service.poke();
  await service.poke();
}

/** A paired person's messenger, ready to carry messages. */
export async function paired(t, { createBot, ...options } = {}) {
  const box = sandbox(t);
  writeSecret(TOKEN, box.env);
  // The keeper has already created the companion's conversation; deliveries go there.
  writeCompanionState({ sessionId: 'S1' }, box.env);
  writeIntent({ action: 'pair' }, box.env);
  const fake = fakeTelegram();
  const started = start({ ...box, fake, createBot, ...options });
  t.after(() => started.service.close());
  await settle(started.service);
  const code = readPairing(box.env).code;
  fake.message({ chatId: USER_CHAT, text: code, from: 'Wy' });
  await settle(started.service);
  assert.equal(readPairing(box.env).status, 'paired', 'the code pairs the chat it was sent from');
  return { ...box, fake, ...started };
}

export function transcript(box, entries, { append = false, sessionId = 'S1' } = {}) {
  writeCompanionState({ sessionId }, box.env);
  const dir = path.join(box.agentDir, 'sessions');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-19T10-00-00-000Z_${sessionId}.jsonl`);
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  if (append) appendFileSync(file, body);
  else writeFileSync(file, body);
  return file;
}

// Entries as the engine writes them: session messages through the session link's own builder.
const sessionEntry = (id, data) => ({ type: 'custom_message', id, ...buildSessionMessage(parseDelivery({ v: 1, messageId: id, ...data })) });
export const channelEntry = (id, { isUser = true, chatId = USER_CHAT, messageId = 501, text = '안녕', name } = {}) =>
  sessionEntry(id, { kind: 'channel', from: { channel: 'telegram', chatId, isUser, ...(name ? { name } : {}), messageId }, text });
export const noticeEntry = (id, text, from = { sessionId: 'rubato', title: 'Rubato', cwd: '' }) =>
  sessionEntry(id, { kind: 'notice', from, text });
export const wakeEntry = (id, what, text) => sessionEntry(id, { kind: 'wake', what, text });
export const answerEntry = (id, text, { stopReason = 'stop', tools = [] } = {}) => ({
  type: 'message', id, message: { role: 'assistant', stopReason,
    content: [...(text ? [{ type: 'text', text }] : []), ...tools.map((tool, index) => ({ type: 'toolCall', id: `${id}-t${index}`, ...tool }))] },
});
/** A tool's result; `callId` names the call it answers (answerEntry's calls are `<entry id>-t<n>`). */
export const toolEntry = (id, toolName, text = 'ok', { callId = `${id}-call`, isError = false } = {}) => ({ type: 'message', id,
  message: { role: 'toolResult', toolCallId: callId, toolName, content: [{ type: 'text', text }], isError } });
export const appEntry = (id, text) => ({ type: 'message', id, message: { role: 'user', content: [{ type: 'text', text }] } });
