// What Segno says to the person, as Segno's own message in the thread. A quiet run never reaches the
// thread (quiet-runs.mjs), so when Segno speaks from one — a heartbeat that has something to say, a
// greeting, a lead's ending, a schedule nudge — the thread gets those words, and the run itself
// stays hidden.
//
// - `tell_user` (intent companion-segno rev 9: Segno speaks only in the app) is the way now, and its
//   words show from any turn (user item 9fbe5b98). From a quiet run they also have to reach the
//   phone, and T3 notifies the phone only when a thread's run finishes, so the item asks for a run
//   of its own (`ownRun`; RubatoThreadImporter.ts appendOwnRun). In a turn the thread shows, the
//   words go in as a plain message, and that turn's own ending notifies.
// - `telegram_send` is what Segno used while the product ran Telegram; the conversations from then
//   still show what it sent from a quiet run, written in place without a run. One in a shown turn
//   is already there as the tool call.
//
// The message travels as a session message whose one context record says which (`rubato-said`,
// `rubato-telegram`); the T3 server writes such a message as an assistant message
// (RubatoThreadImporter.ts sessionMessageRecords), so the desktop app and the phone draw it as
// Segno speaking.
import { sessionMessageId } from './events.mjs';
import { telegramText } from '../../companion/messenger/reply-text.mjs';
import { TELL_USER_TOOL } from '../../companion/home.mjs';

export const SAID_KIND = 'rubato-said';
export const TELEGRAM_ECHO_KIND = 'rubato-telegram';
const TELEGRAM_TOOL = 'telegram_send';
const TOOLS = new Set([TELL_USER_TOOL, TELEGRAM_TOOL]);

const toThePerson = (args) => args?.to === undefined || args?.to === null || args?.to === '' || args?.to === 'user';
const resultText = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
/** The tool said it went out or will once Telegram is connected; a held or failed call did not reach the person. */
const reached = (message) => message?.isError !== true && !/^Held for/.test(resultText(message).trim());
const atOf = (timestamp) => {
  const at = new Date(typeof timestamp === 'number' || typeof timestamp === 'string' ? timestamp : Date.now());
  return Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
};

/** What the person got, as the thread shows it: the text, or the voice note's words, and the files' names. */
export function echoText(args = {}) {
  const lines = [];
  if (args.voice === 'only') {
    const spoken = args.voice_text ?? args.text;
    if (typeof spoken === 'string' && spoken.trim()) lines.push(`(음성) ${spoken.trim()}`);
  } else if (typeof args.text === 'string' && args.text.trim()) {
    lines.push(args.sanitize === false ? args.text : telegramText(args.text));
  } else if (typeof args.voice_text === 'string' && args.voice_text.trim()) {
    lines.push(`(음성) ${args.voice_text.trim()}`);
  }
  for (const file of Array.isArray(args.files) ? args.files : []) {
    if (typeof file === 'string' && file) lines.push(`(파일: ${file.split('/').at(-1)})`);
  }
  return lines.join('\n');
}

/** The thread item for one telegram_send that reached the person. */
export function echoItem({ threadId, toolCallId, args, timestamp }) {
  const text = echoText(args);
  if (!text) return undefined;
  return {
    id: sessionMessageId(threadId, `telegram:${toolCallId}`),
    role: 'user',
    text,
    createdAt: atOf(timestamp),
    context: { version: 1, records: [{ version: 1, contextId: TELEGRAM_ECHO_KIND, kind: TELEGRAM_ECHO_KIND, label: 'Telegram',
      payload: { v: 1, toolCallId } }] },
  };
}

/** The thread item for one tell_user: Segno's words; from a quiet run, in a run of their own so the phone hears of them. */
export function saidItem({ threadId, toolCallId, args, timestamp, quiet = true }) {
  const text = typeof args?.text === 'string' ? args.text.trim() : '';
  if (!text) return undefined;
  return {
    id: sessionMessageId(threadId, `said:${toolCallId}`),
    role: 'user',
    text,
    createdAt: atOf(timestamp),
    ...(quiet ? { ownRun: true } : {}),
    context: { version: 1, records: [{ version: 1, contextId: SAID_KIND, kind: SAID_KIND, label: 'Segno',
      payload: { v: 1, toolCallId } }] },
  };
}

const itemFor = (call, toolCallId, timestamp, threadId) => (call.name === TELL_USER_TOOL
  ? saidItem({ threadId, toolCallId, args: call.args, timestamp, quiet: call.quiet })
  : echoItem({ threadId, toolCallId, args: call.args, timestamp }));

/** Calls to the person in one assistant message: toolCallId -> { name, args, quiet }. A shown turn's only tell_user counts. */
function callsIn(message, quiet) {
  const calls = new Map();
  for (const part of Array.isArray(message?.content) ? message.content : []) {
    if (part?.type !== 'toolCall' || !TOOLS.has(part.name) || typeof part.id !== 'string') continue;
    if (part.name === TELEGRAM_TOOL && (!quiet || !toThePerson(part.arguments))) continue;
    calls.set(part.id, { name: part.name, args: part.arguments ?? {}, quiet });
  }
  return calls;
}

/**
 * The live filter: `accept(event, quiet)` answers the item to append when a quiet run's call to the
 * person has its result, and nothing otherwise.
 */
export function createSaidEcho({ threadId }) {
  const pending = new Map();
  return {
    accept(event, quiet) {
      if (event?.type !== 'message_end') return undefined;
      const message = event.message;
      if (message?.role === 'assistant') {
        for (const [id, call] of callsIn(message, quiet === true)) pending.set(id, call);
        return undefined;
      }
      if (message?.role !== 'toolResult' || !TOOLS.has(message.toolName) || !pending.has(message.toolCallId)) return undefined;
      const call = pending.get(message.toolCallId);
      pending.delete(message.toolCallId);
      return reached(message) ? itemFor(call, message.toolCallId, message.timestamp, threadId) : undefined;
    },
  };
}

/**
 * The same over a stored conversation: for each tool result that reached the person, the item to
 * show in its place. `quiet` is quietMessages(messages).
 */
export function saidEchoes(messages, quiet, threadId) {
  const pending = new Map();
  const items = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message.role === 'assistant') for (const [id, call] of callsIn(message, quiet.has(message))) pending.set(id, call);
    if (message.role === 'toolResult' && TOOLS.has(message.toolName) && pending.has(message.toolCallId)) {
      const call = pending.get(message.toolCallId);
      pending.delete(message.toolCallId);
      const item = reached(message) ? itemFor(call, message.toolCallId, message.timestamp, threadId) : undefined;
      if (item) items.set(message, item);
    }
  }
  return items;
}
