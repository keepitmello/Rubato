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
import { sessionMessageId } from './events.mjs';
import { REPLY_TOOL, SAY_TOOL } from '../../companion/home.mjs';

export const SAID_KIND = 'rubato-said';
const TOOLS = new Set([REPLY_TOOL, SAY_TOOL]);

const atOf = (timestamp) => {
  const at = new Date(typeof timestamp === 'number' || typeof timestamp === 'string' ? timestamp : Date.now());
  return Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
};

/** The thread item for one reply or say that went through. */
export function saidItem({ threadId, toolCallId, args, timestamp, voice = false }) {
  const text = typeof args?.text === 'string' ? args.text.trim() : '';
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

/** The item for a tool result that answers one of `pending`, when the call went through. */
function itemFor(pending, message, threadId) {
  if (message?.role !== 'toolResult' || !TOOLS.has(message.toolName) || !pending.has(message.toolCallId)) return undefined;
  const call = pending.get(message.toolCallId);
  pending.delete(message.toolCallId);
  if (message.isError === true) return undefined;
  return saidItem({ threadId, toolCallId: message.toolCallId, args: call.args, timestamp: message.timestamp, voice: call.name === SAY_TOOL });
}

/** The live filter: `accept(event)` answers the item to append when a reply or say has its result. */
export function createSaidEcho({ threadId }) {
  const pending = new Map();
  return {
    accept(event) {
      if (event?.type !== 'message_end') return undefined;
      if (event.message?.role === 'assistant') { for (const [id, call] of callsIn(event.message)) pending.set(id, call); return undefined; }
      return itemFor(pending, event.message, threadId);
    },
  };
}

/** The same over a stored conversation: each tool result that went through -> its item. */
export function saidEchoes(messages, threadId) {
  const pending = new Map();
  const items = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant') for (const [id, call] of callsIn(message)) pending.set(id, call);
    const item = itemFor(pending, message, threadId);
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
    return message?.role === 'user' ? [imported(message)] : [];
  });
}
