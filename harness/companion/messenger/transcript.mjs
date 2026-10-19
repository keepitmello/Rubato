// Reading the companion's own conversation, to know what Segno said and what woke it. The
// messenger answers on Telegram the turns that came from Telegram, the daily report and a lead
// ending; it holds the answer to another person; it leaves the person's own app messages and the
// heartbeat alone.
//
// The transcript is read, never written: the engine owns it and this module only looks at its tail.
import { opendir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** A tail is tried from small to large; the last size is the ceiling for one entry. */
export const TAIL_BYTES = Object.freeze([256 * 1024, 4 * 1024 * 1024]);

/** A custom message another conversation (or Rubato) sent into this one. */
const isSessionMessage = (entry) => entry?.type === 'custom_message' && entry.customType === 'rubato-session-message';

const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n') : '';

const isFinalAssistant = (entry) => entry?.type === 'message' && entry.message?.role === 'assistant'
  && entry.message.stopReason !== 'toolUse';

/** The session file whose name ends with this session id (`<timestamp>_<id>.jsonl`). */
export async function locateTranscript(sessionsDir, sessionId) {
  if (!sessionId) return undefined;
  const suffix = `${sessionId}.jsonl`;
  const found = [];
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
  // The live transcript is the file named `<timestamp>_<session id>.jsonl`; a folder or a copy
  // that merely carries the id in its name is not it.
  return found.find((file) => path.basename(file).endsWith(`_${suffix}`)) ?? found[0];
}

/** Every whole entry of the newest `bytes` of a transcript, oldest first. */
export async function readTail(file, bytes = TAIL_BYTES[0]) {
  let handle;
  try { handle = await open(file, 'r'); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const entry = JSON.parse(line); if (entry && typeof entry === 'object') entries.push(entry); } catch {}
    }
    return entries;
  } finally { await handle.close(); }
}

/** The tail, grown until it holds a whole entry. */
export async function readEntries(file) {
  for (const bytes of TAIL_BYTES) {
    const entries = await readTail(file, bytes);
    if (entries.length) return entries;
    const { size } = await stat(file).catch(() => ({ size: 0 }));
    if (size <= bytes) return entries;
  }
  return [];
}

/**
 * What woke the turn ending at `index`: the nearest entry before it that came from the person,
 * from a channel, or from Rubato's own notice.
 */
export function triggerOf(entries, index, { companionSessionId } = {}) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const entry = entries[cursor];
    if (isSessionMessage(entry)) {
      const details = entry.details ?? {};
      if (details.kind === 'channel') {
        return {
          kind: 'channel',
          isUser: details.from?.isUser === true,
          channel: details.from?.channel ?? 'telegram',
          chatId: details.from?.chatId === undefined ? undefined : String(details.from.chatId),
          name: details.from?.name,
          messageId: entry.id,
          incomingMessageId: details.replyTo?.messageId ?? details.from?.messageId,
        };
      }
      if (details.kind === 'notice') {
        // Rubato's own word is sent from 'rubato' (sessionLink.notice); a followed conversation's
        // ending carries that conversation's id.
        const fromCompanion = details.from?.sessionId === 'rubato'
          || (companionSessionId !== undefined && details.from?.sessionId === companionSessionId);
        return { kind: 'notice', own: fromCompanion, followed: fromCompanion ? undefined : details.from?.sessionId,
          text: typeof details.text === 'string' ? details.text : '', messageId: entry.id };
      }
      continue;
    }
    if (entry?.type === 'message' && entry.message?.role === 'user') return { kind: 'app', messageId: entry.id };
  }
  return { kind: 'unknown' };
}

/**
 * The newest finished answer of the companion, with what woke its turn:
 * `{ entryId, text, stopReason, trigger }`, or undefined while a turn is still going.
 */
export function lastAnswer(entries, { companionSessionId } = {}) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isFinalAssistant(entry)) continue;
    const stopReason = entry.message.stopReason;
    if (stopReason === 'aborted' || stopReason === 'error') return { entryId: entry.id, text: '', stopReason, trigger: triggerOf(entries, index, { companionSessionId }) };
    return { entryId: entry.id, text: textOf(entry.message.content).trim(), stopReason, trigger: triggerOf(entries, index, { companionSessionId }) };
  }
  return undefined;
}

