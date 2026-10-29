// The companion's explicit mouth is the same in the app and Telegram: successful reply/say
// calls. Ordinary assistant text is private in every run, including user-opened turns.
// telegram_send owns its own delivery; call_say and game tools belong to other transports.
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { REPLY_TOOL, SAY_TOOL } from '../home.mjs';
import { SESSION_MESSAGE_TYPE } from '../../pi-runtime/features/session-link/message.mjs';

export { SESSION_MESSAGE_TYPE };
export const TELEGRAM_SEND_TOOL = 'telegram_send';
export const READ_CHUNK_BYTES = 8 * 1024 * 1024;

/** The original session journal, not an arbitrary folder that contains its id. */
export async function locateTranscript(sessionsDir, sessionId) {
  if (!sessionId) return undefined;
  const suffix = `${sessionId}.jsonl`, found = [];
  async function walk(dir) {
    let handle;
    try { handle = await opendir(dir); } catch { return; }
    for await (const entry of handle) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(full);
    }
  }
  await walk(sessionsDir);
  return found.find(file => path.basename(file).endsWith(`_${suffix}`)) ?? found[0];
}

/** Complete journal lines only. An unfinished line waits for the next pass. */
export async function readEntriesFrom(file, offset = 0, { maxBytes = READ_CHUNK_BYTES } = {}) {
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) { if (error?.code === 'ENOENT') return { entries: [], size: 0, missing: true }; throw error; }
  try {
    const { size } = await handle.stat();
    if (offset >= size) return { entries: [], size };
    const length = Math.min(size - offset, maxBytes), buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const entries = [];
    let start = 0;
    for (let index = buffer.indexOf(0x0a); index !== -1; index = buffer.indexOf(0x0a, start)) {
      const line = buffer.subarray(start, index).toString('utf8');
      start = index + 1;
      let entry;
      try { entry = line.trim() ? JSON.parse(line) : undefined; } catch { entry = undefined; }
      entries.push({ entry, end: offset + start });
    }
    if (entries.length === 0 && length === maxBytes) return { entries: [{ entry: undefined, end: offset + length }], size };
    return { entries, size };
  } finally { await handle.close(); }
}

// Persisted beside the byte cursor. A version boundary drops an old held assistant monologue;
// it must not escape merely because Telegram was enabled after the reply-only contract changed.
export function freshRun() {
  return { version: 2, trigger: { kind: 'unknown' }, calls: {}, toolTexts: [] };
}
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const resultText = message => (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
function triggerOf(entry) {
  if (entry.type === 'message') return { kind: 'app' };
  const details = entry.details ?? {};
  return details.kind === 'channel' ? { kind: 'channel', isUser: details.from?.isUser === true,
    chatId: String(details.from?.chatId ?? ''), incomingMessageId: details.from?.messageId }
    : { kind: details.kind ?? 'unknown', what: details.what };
}

/** Only a completed explicit mouth call yields outward words; plain assistant content never does. */
export function stepRun(run, entry) {
  if (run.version !== 2) { for (const key of Object.keys(run)) delete run[key]; Object.assign(run, freshRun()); }
  const message = entry?.type === 'message' ? entry.message : undefined;
  if (entry?.type === 'custom_message' && entry.customType === SESSION_MESSAGE_TYPE) {
    // A game/call wake is machine context, not a different human reply target.
    if (entry.details?.kind === 'channel') {
      run.trigger = triggerOf(entry); run.toolTexts = [];
    }
    return [];
  }
  if (message?.role === 'user') { run.trigger = triggerOf(entry); run.toolTexts = []; return []; }
  if (message?.role === 'assistant') {
    if (!['error', 'aborted'].includes(message.stopReason)) {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type !== 'toolCall' || typeof part.id !== 'string') continue;
        const args = part.arguments ?? {};
        if ([REPLY_TOOL, SAY_TOOL].includes(part.name) && typeof args.text === 'string' && args.text.trim())
          run.calls[part.id] = { name: part.name, text: args.text.trim() };
        else if (part.name === TELEGRAM_SEND_TOOL && [undefined, null, '', 'user'].includes(args.to))
          run.calls[part.id] = { name: part.name, texts: [args.text, args.voice_text].filter(value => typeof value === 'string').map(normalize) };
      }
    }
    // A silent final still ends typing. This is not a message to send.
    return message.stopReason !== 'toolUse' ? [{ entryId: entry.id, text: '', final: true, quiet: true }] : [];
  }
  if (message?.role !== 'toolResult') return [];
  const call = run.calls[message.toolCallId];
  if (!call || message.toolName !== call.name) return [];
  delete run.calls[message.toolCallId];
  if (message.isError === true) return [];
  if (call.name === TELEGRAM_SEND_TOOL) {
    if (!/^Held for/.test(resultText(message).trim())) run.toolTexts.push(...call.texts);
    return [];
  }
  return [{ entryId: entry.id, text: call.text, final: true, quiet: false,
    // reply is explicitly addressed to the person, regardless of the surrounding channel.
    trigger: { kind: 'reply' },
    duplicate: run.toolTexts.some(sent => sent && sent.includes(normalize(call.text))) }];
}

export async function runAt(file) {
  const run = freshRun();
  let offset = 0;
  for (;;) {
    const { entries } = await readEntriesFrom(file, offset);
    if (!entries.length) break;
    for (const { entry, end } of entries) { stepRun(run, entry); offset = end; }
  }
  return { run, offset };
}
