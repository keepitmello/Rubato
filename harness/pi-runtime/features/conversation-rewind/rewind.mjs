// Where an app rewind lands in the session tree.
//
// The app counts turns; Pi keeps a tree of entries. A turn is not a user message:
// a finished child wakes the lead without one, and a steered message joins the
// turn it interrupted. So the app names what it keeps instead: the fingerprints
// of the assistant messages in its surviving turns, and how many of its user
// messages it keeps after the last of those (a prompt stopped before any answer).
// The rewind lands before the first input after that. Anything the app cannot
// name is refused rather than guessed.
import { createHash } from "node:crypto";

/** Custom entry that records where a rewind landed. It never reaches the model. */
export const REWIND_MARK = "rubato.rewind";

/** Same identity the app bridge derives its message ids from. */
export function messageFingerprint(message) {
  return createHash("sha256")
    .update(JSON.stringify([message.role, message.timestamp, message.model ?? null]))
    .digest("hex")
    .slice(0, 24);
}

const isUser = (entry) => entry.type === "message" && entry.message?.role === "user";
const isInput = (entry) => isUser(entry) || entry.type === "custom_message";

/**
 * The first entry the rewind drops, or null when the removed turns left nothing in
 * the model's history (a /name turn). Pi's navigateTree moves the leaf to the parent
 * of a user or custom message, so that is the entry to navigate to.
 *
 * - `keep`: fingerprints of the assistant messages the app keeps. Empty keeps none.
 * - `skip`: user messages the app keeps after the last kept assistant message.
 */
export function findRewindTarget(branch, { keep, skip = 0 } = {}) {
  if (!Array.isArray(keep)) throw new Error("A rewind must name the messages it keeps");
  if (!Number.isInteger(skip) || skip < 0) throw new Error("skip must be an integer >= 0");
  const kept = new Set(keep);
  let anchor = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message?.role === "assistant" && kept.has(messageFingerprint(entry.message))) {
      anchor = index;
      break;
    }
  }
  if (kept.size > 0 && anchor < 0) throw new Error("The kept part of this conversation is not on the current branch");
  const rest = branch.slice(anchor + 1);
  // Inputs injected ahead of a prompt (usage notes, recalled memory) belong to its
  // turn, so the removed turn opens at the first input after the last kept prompt.
  let from = 0;
  let passed = 0;
  for (let index = 0; passed < skip && index < rest.length; index++) {
    if (isUser(rest[index])) { passed += 1; from = index + 1; }
  }
  if (passed < skip) throw new Error("The app keeps prompts this conversation does not have");
  return rest.slice(from).find(isInput)?.id ?? null;
}

const isAssistant = (entry) => entry.type === "message" && entry.message?.role === "assistant";
const callsOf = (entry) => (Array.isArray(entry.message?.content) ? entry.message.content : [])
  .filter((part) => part?.type === "toolCall" && typeof part.id === "string")
  .map((part) => part.id);

/**
 * Where a rewind to a finished step lands: the last tool result of the reply that made
 * `toolCallId`. Calls made together answer together, so the step is the whole batch; the
 * conversation can never stop between a call and its result.
 *
 * Landing on a tool result keeps every byte the model saw up to that point, so the next
 * request (a continuation, or a message the user adds there) reads the cached prefix.
 */
export function findStepTarget(branch, toolCallId) {
  if (typeof toolCallId !== "string" || toolCallId.length === 0) throw new Error("A step rewind must name a tool call");
  const at = branch.findIndex((entry) => isAssistant(entry) && callsOf(entry).includes(toolCallId));
  if (at < 0) throw new Error("This step is not on the current branch");
  const waiting = new Set(callsOf(branch[at]));
  let target = null;
  for (const entry of branch.slice(at + 1)) {
    if (waiting.size === 0) break;
    if (entry.type === "message" && entry.message?.role === "toolResult" && waiting.has(entry.message.toolCallId)) {
      waiting.delete(entry.message.toolCallId);
      target = entry.id;
      continue;
    }
    if (isInput(entry) || isAssistant(entry)) break;
  }
  if (waiting.size > 0) throw new Error("This step has not finished, so there is no result to rewind to");
  return target;
}

/** What a call the restart cut short answers with (pi-server drain.mjs, `continue` with `resume`). */
export const RESTART_TOOL_RESULT = "Rubato restarted while this tool was running, so it did not finish and its result is lost. Run it again if you still need it.";

const unreplayed = (message) => message?.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error");

/**
 * The calls of the last reply that never got a result, in the model's context order. A reply
 * cut while it streamed is not replayed (pi-ai drops it), so it is passed over; system
 * messages are transparent the same way. Anything else after the reply means its turn moved on.
 */
export function unansweredToolCalls(messages) {
  const answered = new Set();
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (unreplayed(message) || message?.role === "system") continue;
    if (message?.role === "toolResult") { answered.add(message.toolCallId); continue; }
    if (message?.role !== "assistant") return [];
    return (Array.isArray(message.content) ? message.content : [])
      .filter((part) => part?.type === "toolCall" && typeof part.id === "string" && !answered.has(part.id))
      .map(({ id, name }) => ({ id, name }));
  }
  return [];
}
