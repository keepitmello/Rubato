// What Segno says to the person: the only words of Segno's its thread ever gets (intent
// companion-segno rev 11, user items 85727ce8, c31022f7). Segno's thread is a chat log — the
// person's own messages and what Segno sends with `reply` (text) or `say` (voice) — not a
// projection of Segno's turns, so everything else it writes stays in its session.
//
// Each call that went through becomes one item, in any turn. It travels as a session message whose
// one context record is `rubato-said`; the T3 server writes it as Segno's own message
// (RubatoThreadImporter.ts sessionMessageRecords) in a run that finishes, so the phone and the
// desktop toast hear of it: a run of its own, or the person's turn when one is going
// (RubatoPiSessions.ts appendOwnRun).
import { SESSION_MESSAGE_TYPE, sessionMessageId } from './events.mjs';
import { BACKFILL_KIND } from './backfill.mjs';
import { REPLY_TOOL, SAY_TOOL, replyDisplayText } from '../../companion/home.mjs';

export const SAID_KIND = 'rubato-said';
const TELEGRAM_SEND = 'telegram_send';
const TOOLS = new Set([REPLY_TOOL, SAY_TOOL, TELEGRAM_SEND]);

const atOf = (timestamp) => {
  const at = new Date(typeof timestamp === 'number' || typeof timestamp === 'string' ? timestamp : Date.now());
  return Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
};

/** The thread item for one reply or say that went through. */
export function saidItem({ threadId, toolCallId, args, timestamp, voice = false }) {
  const text = replyDisplayText(args);
  if (!text) return undefined;
  return {
    id: sessionMessageId(threadId, `said:${toolCallId}`),
    role: 'user',
    text,
    createdAt: atOf(timestamp),
    ownRun: true,
    context: { version: 1, records: [{ version: 1, contextId: SAID_KIND, kind: SAID_KIND, label: 'Segno',
      payload: { v: 1, toolCallId, ...(voice ? { voice: true } : {}) } }] },
  };
}

/** reply and say calls in one assistant message: toolCallId -> { name, args }. */
function callsIn(message) {
  const calls = new Map();
  for (const part of Array.isArray(message?.content) ? message.content : []) {
    if (part?.type === 'toolCall' && TOOLS.has(part.name) && typeof part.id === 'string') calls.set(part.id, { name: part.name, args: part.arguments ?? {} });
  }
  return calls;
}

/** The paired person's Telegram words are theirs, not an agent's envelope or a wake. */
export function channelItem(message, threadId) {
  const details = message?.details;
  if (message?.role !== 'custom' || message.customType !== SESSION_MESSAGE_TYPE
    || details?.kind !== 'channel' || details.from?.channel !== 'telegram' || details.from?.isUser !== true
    || typeof details.messageId !== 'string' || !details.messageId.trim() || typeof details.text !== 'string') return;
  const text = details.text.trim();
  if (!text) return;
  return {
    id: sessionMessageId(threadId, details.messageId.trim()), role: 'user', text, createdAt: atOf(message.timestamp),
    context: { version: 1, records: [{ version: 1, contextId: BACKFILL_KIND, kind: BACKFILL_KIND, label: 'Telegram',
      payload: { v: 1, role: 'user' } }] },
  };
}

const sentToPerson = (call, message) => {
  if (![undefined, null, '', 'user'].includes(call.args.to)) return false;
  if (message.details?.state !== undefined) return message.details.state === 'sent' && message.details.target === 'user';
  // Older transcripts carry only the tool's human-readable delivery receipt.
  const receipt = (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
  return /^sent (?:\(id:|[1-9]\d* parts \(ids:)/.test(receipt.trim());
};

/** The item for a tool result that answers one of `pending`, when the call went through. */
function itemFor(pending, message, threadId, telegramTexts) {
  if (message?.role !== 'toolResult' || !TOOLS.has(message.toolName) || !pending.has(message.toolCallId)) return undefined;
  const call = pending.get(message.toolCallId);
  pending.delete(message.toolCallId);
  if (message.isError === true || message.toolName !== call.name) return undefined;
  if (call.name === TELEGRAM_SEND && !sentToPerson(call, message)) return undefined;
  const args = call.name === TELEGRAM_SEND ? { text: call.args.text || call.args.voice_text
    || (Array.isArray(call.args.files) ? call.args.files.map((file) => `첨부: ${file}`).join('\n') : '') } : call.args;
  const text = String(args.text ?? '').replace(/\s+/g, ' ').trim();
  if (call.name === TELEGRAM_SEND) telegramTexts.add(text);
  else if (telegramTexts.has(text)) return undefined;
  return saidItem({ threadId, toolCallId: message.toolCallId, args, timestamp: message.timestamp,
    voice: call.name === SAY_TOOL || call.args.voice === 'only' });
}

/** The live filter: `accept(event)` answers the item to append when a reply or say has its result. */
export function createSaidEcho({ threadId }) {
  const pending = new Map();
  const telegramTexts = new Set();
  return {
    accept(event) {
      if (event?.type !== 'message_end') return undefined;
      if (event.message?.role === 'user' || event.message?.details?.kind === 'channel') telegramTexts.clear();
      if (event.message?.role === 'assistant') { for (const [id, call] of callsIn(event.message)) pending.set(id, call); return undefined; }
      return itemFor(pending, event.message, threadId, telegramTexts);
    },
  };
}

/** The same over a stored conversation: each tool result that went through -> its item. */
export function saidEchoes(messages, threadId) {
  const echo = createSaidEcho({ threadId });
  const items = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const item = echo.accept({ type: 'message_end', message });
    if (item) items.set(message, item);
  }
  return items;
}

/**
 * What Segno's thread shows of a stored conversation: the person's own messages and these items,
 * nothing else. `imported(message)` is the item the history import makes of a person's message.
 */
export function companionThreadItems(messages, threadId, imported) {
  const echoes = saidEchoes(messages, threadId);
  return (Array.isArray(messages) ? messages : []).flatMap((message) => {
    if (echoes.has(message)) return [echoes.get(message)];
    const channel = channelItem(message, threadId);
    if (channel) return [channel];
    return message?.role === 'user' ? [imported(message)] : [];
  });
}
