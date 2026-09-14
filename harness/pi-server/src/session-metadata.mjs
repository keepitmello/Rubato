import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';

/** The pinned Pi SessionInfo semantics, without retaining allMessagesText.
 * Keep the differential test against SessionManager.listAll when updating Pi.
 * This is read-only: SessionManager.open can migrate/rewrite an old session.
 */
export async function readSessionMetadata(file, stats) {
  if (!stats.size) return null;
  const input = createReadStream(file, { encoding: 'utf8', end: Number(stats.size) - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header, name, firstMessage = '', messageCount = 0, lastActivityTime;
  try {
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry) continue;
      try {
        if (!header) {
          if (entry.type !== 'session') return null;
          header = entry;
          continue;
        }
        if (entry.type === 'session_info') name = entry.name?.trim() || undefined;
        if (entry.type !== 'message') continue;
        messageCount++;
        const message = entry.message;
        if (typeof message.role !== 'string' || !('content' in message)) continue;
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        const activity = typeof message.timestamp === 'number' ? message.timestamp : new Date(entry.timestamp).getTime();
        if (!Number.isNaN(activity)) lastActivityTime = Math.max(lastActivityTime ?? 0, activity);
        const content = message.content;
        // Validate the same content shapes as Pi, but only assemble the first
        // user text. Assistant/tool bodies are never accumulated for a list.
        const text = typeof content === 'string' ? content : content.filter((part) => part.type === 'text');
        if (!firstMessage && message.role === 'user') {
          firstMessage = typeof text === 'string' ? text : text.map((part) => part.text).join(' ');
        }
      } catch {
        // Pi excludes structurally malformed sessions, not just bad JSON lines.
        return null;
      }
    }
    if (!header) return null;
    const headerTime = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
    // Number Stats.mtime (used by Pi) rounds sub-ms precision into its Date;
    // BigInt Stats.mtime truncates it. Retain the fraction before rounding.
    const mtime = Math.round(Number(stats.mtimeMs) + Number(stats.mtimeNs % 1_000_000n) / 1e6);
    const modifiedAt = typeof lastActivityTime === 'number' && lastActivityTime > 0
      ? new Date(lastActivityTime).getTime() : !Number.isNaN(headerTime) ? headerTime : mtime;
    return { id: header.id, file, cwd: typeof header.cwd === 'string' ? header.cwd : '',
      title: name || firstMessage || '(no messages)', createdAt: new Date(header.timestamp).getTime(), modifiedAt, messageCount };
  } finally {
    lines.close();
    input.destroy();
    await finished(input).catch(() => {});
  }
}
