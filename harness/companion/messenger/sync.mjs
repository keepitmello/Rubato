// The app and Telegram show the same conversation (intent companion-segno rev 6: user items
// bfe3d27d, a2b6ecc7, e78cafd6). Every word of Segno's the app thread shows also reaches the
// person's Telegram, whichever side the turn came from; a run the app hides (Rubato's clock:
// heartbeat, sleep, greetings…) stays out of Telegram too. The person's own app messages are not
// copied to Telegram: Segno's answer has to read on its own there.
//
// Which runs the app hides is decided in one place, harness/t3-integration/src/quiet-runs.mjs
// (`isClockWake`, QUIET_WAKES); this reads the transcript with the same rule.
//
// The transcript is read from a byte offset that only moves forward past whole lines, so a
// transcript of any length is read once and never replayed. The run state that decides where an
// answer goes (which input opened the run, whether it is quiet, what Segno already sent with
// telegram_send in it) is carried with that offset.
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { isClockWake } from '../../t3-integration/src/quiet-runs.mjs';

export const SESSION_MESSAGE_TYPE = 'rubato-session-message';
export const TELEGRAM_SEND_TOOL = 'telegram_send';
/** One pass reads at most this much of a transcript; the rest waits for the next pass. */
export const READ_CHUNK_BYTES = 8 * 1024 * 1024;

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

const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n') : '';
const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * The whole lines written after `offset`: each entry with the byte offset just past it. A line
 * still being written (no newline yet) waits for the next read.
 */
export async function readEntriesFrom(file, offset = 0, { maxBytes = READ_CHUNK_BYTES } = {}) {
  let handle;
  try { handle = await open(file, 'r'); } catch (error) { if (error?.code === 'ENOENT') return { entries: [], size: 0, missing: true }; throw error; }
  try {
    const { size } = await handle.stat();
    if (offset >= size) return { entries: [], size };
    const length = Math.min(size - offset, maxBytes);
    const buffer = Buffer.alloc(length);
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
    // One line longer than a whole chunk would never complete; it is skipped rather than stall.
    if (entries.length === 0 && length === maxBytes) return { entries: [{ entry: undefined, end: offset + length }], size };
    return { entries, size };
  } finally { await handle.close(); }
}

/** The run state carried with the offset: a plain object, so it can be stored and read back. */
export function freshRun() {
  return { quiet: false, trigger: { kind: 'unknown' }, toolTexts: [], calls: {}, held: null };
}

/** What opened a run, from the input that started it. */
function triggerOf(entry, { companionSessionId } = {}) {
  if (entry.type === 'message') return { kind: 'app' };
  const details = entry.details ?? {};
  if (details.kind === 'channel') {
    return {
      kind: 'channel',
      isUser: details.from?.isUser === true,
      chatId: details.from?.chatId === undefined ? undefined : String(details.from.chatId),
      ...(details.from?.name ? { name: details.from.name } : {}),
      ...(details.from?.messageId === undefined ? {} : { incomingMessageId: details.from.messageId }),
    };
  }
  if (details.kind === 'wake') return { kind: 'wake', what: details.what };
  if (details.kind === 'notice') {
    const own = details.from?.sessionId === 'rubato' || (companionSessionId !== undefined && details.from?.sessionId === companionSessionId);
    return { kind: 'notice', own, ...(own ? {} : { followed: details.from?.sessionId }) };
  }
  return { kind: details.kind ?? 'message' };
}

/** telegram_send calls to the person in one assistant message: call id -> the texts it would send. */
function toolSends(content) {
  const calls = {};
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type !== 'toolCall' || part.name !== TELEGRAM_SEND_TOOL || typeof part.id !== 'string') continue;
    const args = part.arguments ?? {};
    const to = args.to;
    if (!(to === undefined || to === null || to === '' || to === 'user')) continue;
    calls[part.id] = [args.text, args.voice_text].filter((value) => typeof value === 'string' && value.trim()).map(normalize);
  }
  return calls;
}

const resultText = (content) => (Array.isArray(content) ? content : []).filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
/** The tool's own answer says the message reached the person, or will once Telegram is connected. */
const delivered = (message) => message?.isError !== true && !/^Held for/.test(resultText(message?.content).trim());

const isDuplicate = (run, text) => {
  const said = normalize(text);
  return said !== '' && run.toolTexts.some((sent) => sent === said || sent.includes(said));
};

function finish(run, said) {
  return { ...said, duplicate: isDuplicate(run, said.text) };
}

/** A held text goes out now, judged against what was confirmed sent by then. */
function release(run) {
  const said = run.held;
  run.held = null;
  return said ? [finish(run, said)] : [];
}

function newInput(run, quiet, trigger) {
  const out = release(run);
  run.quiet = quiet;
  run.trigger = trigger;
  run.toolTexts = [];
  run.calls = {};
  return out;
}

/**
 * One transcript entry through the run state. Returns what is said out loud by now, in order:
 *   [{ entryId, text, final, trigger, quiet, duplicate }]
 * `final` is a run's last answer (it did not hand over to tools); a text before a tool call is
 * Segno speaking mid-work, which the app shows too. `quiet` answers stay in Segno's session.
 * `duplicate` is a text Segno already sent with telegram_send in the same run — counted only once
 * the tool's result says it went out, so a failed send never silences the answer. A text written
 * beside its own telegram_send call waits for that call's result before it is judged.
 */
export function stepRun(run, entry, { companionSessionId } = {}) {
  if (!entry || typeof entry !== 'object') return [];
  run.calls ??= {};
  run.held ??= null;
  if (entry.type === 'custom_message' && entry.customType === SESSION_MESSAGE_TYPE) {
    const message = { role: 'custom', customType: entry.customType, details: entry.details };
    return newInput(run, isClockWake(message), triggerOf(entry, { companionSessionId }));
  }
  if (entry.type !== 'message') return [];
  const message = entry.message ?? {};
  if (message.role === 'user') return newInput(run, false, triggerOf(entry));
  if (message.role === 'toolResult') {
    if (message.toolName !== TELEGRAM_SEND_TOOL || !(message.toolCallId in run.calls)) return [];
    if (delivered(message)) run.toolTexts.push(...run.calls[message.toolCallId]);
    delete run.calls[message.toolCallId];
    if (run.held && !run.held.waitFor.some((id) => id in run.calls)) return release(run);
    return [];
  }
  if (message.role !== 'assistant') return [];
  const out = release(run);
  const calls = toolSends(message.content);
  Object.assign(run.calls, calls);
  const failed = message.stopReason === 'aborted' || message.stopReason === 'error';
  const text = failed ? '' : textOf(message.content).trim();
  const said = { entryId: entry.id, text, final: message.stopReason !== 'toolUse', trigger: run.trigger, quiet: run.quiet };
  const waitFor = Object.keys(calls);
  if (text && waitFor.length) { run.held = { ...said, waitFor }; return out; }
  return [...out, finish(run, said)];
}

/**
 * The run state at the end of what is already written, without saying anything: where a cursor
 * starts when the history is taken as read, so a run that is going on (a quiet one included)
 * keeps its place.
 */
export async function runAt(file, { companionSessionId } = {}) {
  const run = freshRun();
  let offset = 0;
  for (;;) {
    const { entries } = await readEntriesFrom(file, offset);
    if (!entries.length) break;
    for (const { entry, end } of entries) { stepRun(run, entry, { companionSessionId }); offset = end; }
  }
  // What was said before the cursor is history; nothing of it is still to be sent.
  run.held = null;
  return { run, offset };
}
