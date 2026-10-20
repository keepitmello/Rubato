// The app and Telegram show the same conversation (intent companion-segno rev 6). A run Rubato's
// clock starts never reaches the thread (quiet-runs.mjs), so when Segno speaks to the person from
// one — a heartbeat that has something to say, a greeting — with `telegram_send`, the thread gets
// that message as Segno's own words, and the run itself stays hidden. A telegram_send in a run the
// thread shows is already there as the tool call, and gets nothing more.
//
// The message travels as a session message whose one context record is of kind `rubato-telegram`;
// the T3 server writes such a message as an assistant message (RubatoThreadImporter.ts
// sessionMessageRecords), so the desktop app and the phone draw it as Segno speaking.
import { sessionMessageId } from './events.mjs';
import { telegramText } from '../../companion/messenger/reply-text.mjs';

export const TELEGRAM_ECHO_KIND = 'rubato-telegram';
const TOOL = 'telegram_send';

const toThePerson = (args) => args?.to === undefined || args?.to === null || args?.to === '' || args?.to === 'user';
const resultText = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
/** The tool said it went out or will once Telegram is connected; a held or failed call did not reach the person. */
const reached = (message) => message?.isError !== true && !/^Held for/.test(resultText(message).trim());

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
  const at = new Date(typeof timestamp === 'number' || typeof timestamp === 'string' ? timestamp : Date.now());
  return {
    id: sessionMessageId(threadId, `telegram:${toolCallId}`),
    role: 'user',
    text,
    createdAt: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
    context: { version: 1, records: [{ version: 1, contextId: TELEGRAM_ECHO_KIND, kind: TELEGRAM_ECHO_KIND, label: 'Telegram',
      payload: { v: 1, toolCallId } }] },
  };
}

/** Calls to the person in one assistant message: toolCallId -> arguments. */
function callsIn(message) {
  const calls = new Map();
  for (const part of Array.isArray(message?.content) ? message.content : []) {
    if (part?.type === 'toolCall' && part.name === TOOL && typeof part.id === 'string' && toThePerson(part.arguments)) {
      calls.set(part.id, part.arguments ?? {});
    }
  }
  return calls;
}

/**
 * The live filter: `accept(event, quiet)` answers the item to append when a quiet run's
 * telegram_send to the person has its result, and nothing otherwise.
 */
export function createTelegramEcho({ threadId }) {
  const pending = new Map();
  return {
    accept(event, quiet) {
      if (event?.type !== 'message_end') return undefined;
      const message = event.message;
      if (message?.role === 'assistant') {
        if (quiet) for (const [id, args] of callsIn(message)) pending.set(id, args);
        return undefined;
      }
      if (message?.role !== 'toolResult' || message.toolName !== TOOL || !pending.has(message.toolCallId)) return undefined;
      const args = pending.get(message.toolCallId);
      pending.delete(message.toolCallId);
      return reached(message) ? echoItem({ threadId, toolCallId: message.toolCallId, args, timestamp: message.timestamp }) : undefined;
    },
  };
}

/**
 * The same over a stored conversation: for each quiet run's tool result that reached the person,
 * the item to show in its place. `quiet` is quietMessages(messages).
 */
export function telegramEchoes(messages, quiet, threadId) {
  const pending = new Map();
  const items = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!quiet.has(message)) continue;
    if (message.role === 'assistant') for (const [id, args] of callsIn(message)) pending.set(id, args);
    if (message.role === 'toolResult' && message.toolName === TOOL && pending.has(message.toolCallId)) {
      const args = pending.get(message.toolCallId);
      pending.delete(message.toolCallId);
      const item = reached(message) ? echoItem({ threadId, toolCallId: message.toolCallId, args, timestamp: message.timestamp }) : undefined;
      if (item) items.set(message, item);
    }
  }
  return items;
}
