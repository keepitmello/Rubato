// Turns the engine runs while T3 holds no stream on a thread reach that thread anyway. T3 stops an
// idle thread's provider session after 30 minutes (upstream ProviderSessionManager) and its Pi
// adapter brings nothing back when the session starts again; but the engine keeps running the
// conversation — team mail, a lead ending, Segno's greetings — so without this those turns never show.
//
// The thread is compared with the session itself, so a hole is found wherever it is, after a GUI
// restart too: the thread's messages are paired with the session's by their words, in order, and a
// message of the session left over — and newer than the thread's first message, so a side chat's
// copied history is never one — is missing. Where T3's own log says when the thread had no stream
// (RubatoPiSessions.ts streamGaps), only messages from those times count. Missing are: Segno's or the agent's words, a
// message another conversation or a messenger sent, what Segno said to the person (said-echo.mjs). The
// session is projected the way a history import projects it (bridge importedMessages: quiet-runs.mjs
// hides Rubato's clock), so a hidden run stays hidden. Each missing message is written into the run
// of the message it followed in the session — T3 orders a thread by run, then within a run by when
// an item arrived — under an id made from it, so writing it again changes nothing and the thread
// keeps the session's order. What Segno said with tell_user is the exception: it goes into a run of
// its own (RubatoThreadImporter.ts appendOwnRun), so the phone hears of it.
import { sessionMessageId } from './events.mjs';

/** The context record of a message the backfill wrote; RubatoThreadImporter.ts writes it as `role`. */
export const BACKFILL_KIND = 'rubato-backfill';

/** The words of a message as both sides hold them: T3 writes an attached image and its context records differently. */
export const sameWords = (text) => String(text ?? '')
  .replace(/<t3_context[\s\S]*?<\/t3_context>/g, '')
  .replace(/!\[[^\]]*\]\(t3-context:[^)]*\)/g, '')
  .replace(/\[Image:[^\]]*\]/g, '')
  .replace(/\s+/g, '');

/** The id an item is written under: a session message keeps its own; a plain message gets one from its key. */
export function writtenId(item, threadId) {
  return item.context !== undefined ? item.id : sessionMessageId(threadId, `backfill:${item.id}`);
}

const inGap = (gaps, createdAt) => {
  if (gaps === undefined) return true;
  const at = Date.parse(createdAt);
  return Number.isFinite(at) && gaps.some((gap) => at >= gap.from && at <= gap.to);
};

/**
 * The projected session items the thread is missing, each with the run it goes into. Each thread
 * message is paired with the session message of the same words nearest to it in time; one left over is missing
 * when it is newer than the thread's first message, falls in one of `gaps` when T3's log gives them
 * (`{ from, to }` in ms), and is not the person's own words (the app writes those). It goes into
 * the run of the last item before it the thread holds in a run; one with nothing before it is left alone.
 */
export function missingItems(items, threadMessages, { gaps } = {}) {
  const projected = (items ?? []).filter((item) => sameWords(item.text));
  const shown = (threadMessages ?? []).filter((message) => sameWords(message.text));
  const starts = shown.map((message) => Date.parse(message.createdAt)).filter(Number.isFinite);
  const threadStart = starts.length ? Math.min(...starts) : Infinity;
  // Each shown message pairs with the session message of the same words nearest to it in time: the
  // same words said twice ("Done.") are two messages, and the one the thread lacks is the other one.
  const byWords = new Map();
  projected.forEach((item, index) => {
    const words = sameWords(item.text);
    if (!byWords.has(words)) byWords.set(words, []);
    byWords.get(words).push(index);
  });
  const pairedWith = new Map(); // projected index -> shown message
  for (const message of shown) {
    const candidates = (byWords.get(sameWords(message.text)) ?? []).filter((index) => !pairedWith.has(index));
    if (!candidates.length) continue;
    const at = Date.parse(message.createdAt);
    const distance = (index) => Math.abs((Date.parse(projected[index].createdAt) || 0) - (Number.isFinite(at) ? at : 0));
    const nearest = candidates.reduce((best, index) => (distance(index) < distance(best) ? index : best));
    pairedWith.set(nearest, message);
  }
  const missing = [];
  let anchored = false;
  let runId = null;
  projected.forEach((item, index) => {
    const paired = pairedWith.get(index);
    // A message T3 shows outside any run (a session message's bubble) keeps the run before it.
    if (paired) { anchored = true; runId = paired.runId ?? paired.turnId ?? runId; return; }
    const theirs = item.role === 'assistant' || item.context !== undefined;
    const since = Date.parse(item.createdAt) >= threadStart;
    if (!theirs || !since || !inGap(gaps, item.createdAt) || !anchored) return;
    missing.push({ item, runId });
  });
  return missing;
}

/**
 * One item as the thread writes it (bridge appendSessionMessage), in `runId`. A session message or
 * an echo of Segno's words already carries its record (and tell_user's its own run); a plain user
 * or assistant message carries a backfill record that says which it was, so T3 writes it in that role.
 */
export function backfillItem(item, threadId, runId = null) {
  const run = runId && item.ownRun !== true ? { runId } : {};
  if (item.context !== undefined) return { ...item, ...run };
  return {
    id: writtenId(item, threadId),
    role: 'user',
    text: item.text,
    createdAt: item.createdAt,
    ...run,
    context: { version: 1, records: [{ version: 1, contextId: BACKFILL_KIND, kind: BACKFILL_KIND, label: item.role,
      payload: { v: 1, role: item.role === 'assistant' ? 'assistant' : 'user' } }] },
  };
}
