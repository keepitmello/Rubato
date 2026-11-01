import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { SIDE_CHAT_ENTRY } from '../../pi-runtime/features/session-link/side-chat.mjs';
import { SYSTEM_PROMPT_REPLACEMENT_ENTRY } from '../../pi-runtime/features/session-prompt/patches.mjs';
import { COMPANION_ENTRY } from '../../companion/companion.mjs';

/** Bytes kept from the file's start and from just before the resume point (see `readSessionMetadataFrom`). */
const EDGE = 256;
const NEWLINE = 0x0a;

const emptyFold = () => ({ header: undefined, name: undefined, firstMessage: '', messageCount: 0, lastActivityTime: undefined,
  sideChatOf: undefined, systemPrompt: undefined, companion: false, companionId: undefined, invalid: false });

/** The pinned Pi SessionInfo semantics, without retaining allMessagesText, one line at a time.
 * Keep the differential test against SessionManager.listAll when updating Pi.
 * A structurally malformed entry makes the whole file invalid, as Pi excludes it.
 */
function foldLine(fold, line) {
  if (fold.invalid) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  if (!entry) return;
  try {
    if (!fold.header) {
      if (entry.type !== 'session') { fold.invalid = true; return; }
      fold.header = { id: entry.id, timestamp: entry.timestamp, cwd: entry.cwd };
      return;
    }
    if (entry.type === 'session_info') fold.name = entry.name?.trim() || undefined;
    // Not Pi's: a side chat names the conversation it was opened from (side-chat.mjs).
    if (entry.type === 'custom' && entry.customType === SIDE_CHAT_ENTRY && typeof entry.data?.parentSessionId === 'string') fold.sideChatOf = entry.data.parentSessionId;
    // Not Pi's: the session runs on a replacement prompt (session-prompt). The list names it,
    // never carries its text.
    if (entry.type === 'custom' && entry.customType === SYSTEM_PROMPT_REPLACEMENT_ENTRY && typeof entry.data?.value === 'string') fold.systemPrompt = replacementSummary(entry.data);
    // Not Pi's: the conversation is the companion (harness/companion); the engine gives it that role.
    if (entry.type === 'custom' && entry.customType === COMPANION_ENTRY) {
      fold.companion = true;
      fold.companionId = entry.data?.id ?? 'segno';
    }
    if (entry.type !== 'message') return;
    fold.messageCount++;
    const message = entry.message;
    if (typeof message.role !== 'string' || !('content' in message)) return;
    if (message.role !== 'user' && message.role !== 'assistant') return;
    const activity = typeof message.timestamp === 'number' ? message.timestamp : new Date(entry.timestamp).getTime();
    if (!Number.isNaN(activity)) fold.lastActivityTime = Math.max(fold.lastActivityTime ?? 0, activity);
    const content = message.content;
    // Validate the same content shapes as Pi, but only assemble the first
    // user text. Assistant/tool bodies are never accumulated for a list.
    const text = typeof content === 'string' ? content : content.filter((part) => part.type === 'text');
    if (!fold.firstMessage && message.role === 'user') {
      fold.firstMessage = typeof text === 'string' ? text : text.map((part) => part.text).join(' ');
    }
  } catch {
    fold.invalid = true;
  }
}

function metadataOf(fold, file, stats) {
  const header = fold.header;
  if (fold.invalid || !header) return null;
  const headerTime = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
  // Number Stats.mtime (used by Pi) rounds sub-ms precision into its Date;
  // BigInt Stats.mtime truncates it. Retain the fraction before rounding.
  const mtime = Math.round(Number(stats.mtimeMs) + Number(stats.mtimeNs % 1_000_000n) / 1e6);
  const modifiedAt = typeof fold.lastActivityTime === 'number' && fold.lastActivityTime > 0
    ? new Date(fold.lastActivityTime).getTime() : !Number.isNaN(headerTime) ? headerTime : mtime;
  return { id: header.id, file, cwd: typeof header.cwd === 'string' ? header.cwd : '',
    title: fold.name || fold.firstMessage || '(no messages)', createdAt: new Date(header.timestamp).getTime(), modifiedAt,
    messageCount: fold.messageCount,
    ...(fold.sideChatOf ? { sideChatOf: fold.sideChatOf } : {}), ...(fold.systemPrompt ? { systemPrompt: fold.systemPrompt } : {}),
    ...(fold.companion ? { companion: true, companionId: fold.companionId } : {}) };
}

/** Whether the bytes a progress was taken over are still where they were. */
async function progressHolds(file, progress) {
  const handle = await open(file, 'r');
  try {
    const same = async (bytes, at) => {
      const read = Buffer.alloc(bytes.length);
      const { bytesRead } = await handle.read(read, 0, bytes.length, at);
      return bytesRead === bytes.length && read.equals(bytes);
    };
    return await same(progress.head, 0) && await same(progress.seam, progress.offset - progress.seam.length);
  } finally { await handle.close(); }
}

/** Read-only: SessionManager.open can migrate/rewrite an old session. */
export async function readSessionMetadata(file, stats) {
  return (await readSessionMetadataFrom(file, stats)).metadata;
}

/**
 * The metadata of `file` up to `stats.size`, and the progress to continue from next time.
 *
 * A live conversation appends a line per entry, and the directory is listed every few seconds.
 * Reading such a file whole each time made one listing parse 80MB when three large conversations
 * were running (a 39MB session took 2.7s), and the engine missed T3's 30s deadline for a new
 * session (2026-11-01). Pi only appends; it rewrites a file in place when it migrates an older
 * version, which changes its header line. So with `previous`, the lines before its offset are
 * taken as read while the file's first bytes and the bytes just before that offset are unchanged,
 * and only the lines after it are parsed. A shorter file or changed edges are read from the start.
 * The progress ends after the last complete line; a trailing partial line counts for this answer
 * only, as Pi's reader counts it, and is read again once it ends.
 * @returns {Promise<{ metadata: object | null, progress?: { offset: number, head: Buffer, seam: Buffer, fold: object } }>}
 */
export async function readSessionMetadataFrom(file, stats, previous) {
  const size = Number(stats.size);
  if (!size) return { metadata: null };
  let start = 0;
  let fold = emptyFold();
  let head;
  if (previous && previous.offset <= size && await progressHolds(file, previous).catch(() => false)) {
    if (previous.fold.invalid) return { metadata: null, progress: previous };
    start = previous.offset;
    fold = { ...previous.fold };
    head = previous.head;
  }
  let offset = start;
  let seam = previous && start ? previous.seam : Buffer.alloc(0);
  let pending = [];
  const firstBytes = [];
  let firstLength = 0;
  if (start < size) {
    const input = createReadStream(file, { start, end: size - 1 });
    try {
      for await (const chunk of input) {
        if (!head && firstLength < EDGE) { firstBytes.push(chunk.subarray(0, EDGE - firstLength)); firstLength += Math.min(chunk.length, EDGE - firstLength); }
        let from = 0;
        for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, from)) {
          pending.push(chunk.subarray(from, at + 1));
          const line = pending.length === 1 ? pending[0] : Buffer.concat(pending);
          pending = [];
          foldLine(fold, line.toString('utf8', 0, line.length - 1));
          offset += line.length;
          seam = line.length >= EDGE ? Buffer.from(line.subarray(line.length - EDGE)) : Buffer.concat([seam, line]).subarray(-EDGE);
          from = at + 1;
        }
        if (from < chunk.length) pending.push(chunk.subarray(from));
      }
    } finally {
      input.destroy();
      await finished(input).catch(() => {});
    }
  }
  head ??= Buffer.concat(firstBytes).subarray(0, Math.min(firstLength, offset));
  const progress = { offset, head: Buffer.from(head), seam: Buffer.from(seam), fold: { ...fold } };
  let answer = fold;
  if (pending.length) {
    answer = { ...fold };
    foldLine(answer, Buffer.concat(pending).toString('utf8'));
  }
  return { metadata: metadataOf(answer, file, stats), progress };
}

function replacementSummary(data) {
  const pick = (key) => typeof data[key] === 'string' && data[key] ? { [key]: data[key] } : {};
  return { ...pick('label'), ...pick('source'), ...pick('createdAt') };
}

/** Names what `readSessionMetadata` produces. A saved session index made under another value
 * is thrown away, so changing this reader, any helper in this file, or the side-chat marker it
 * looks for invalidates every saved index without anyone remembering to bump a number. */
export const SESSION_METADATA_VERSION = createHash('sha256')
  .update(readFileSync(new URL(import.meta.url))).update('\0').update(SIDE_CHAT_ENTRY).update('\0').update(SYSTEM_PROMPT_REPLACEMENT_ENTRY).update('\0').update(COMPANION_ENTRY).digest('hex').slice(0, 16);
