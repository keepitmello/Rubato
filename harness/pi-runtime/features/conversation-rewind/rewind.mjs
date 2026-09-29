// Where an app rewind lands in the session tree.
//
// The app counts turns; Pi keeps a tree of entries. A turn is not a user message:
// a finished child wakes the lead without one, and a steered message joins the
// turn it interrupted. Counting user messages from the end therefore cut the
// conversation somewhere other than where the app did, so the model kept what
// the screen had dropped or lost what it still showed. The app instead names
// what it keeps: the fingerprints of the
// assistant messages in its surviving turns. The last of those on the current
// branch closes the kept history, and the rewind lands just before the first
// input after it (the removed turn's own user message when its text is given).
import { createHash } from "node:crypto";

/** Same identity the app bridge derives its message ids from. */
export function messageFingerprint(message) {
  return createHash("sha256")
    .update(JSON.stringify([message.role, message.timestamp, message.model ?? null]))
    .digest("hex")
    .slice(0, 24);
}

export function userText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

const isUser = (entry) => entry.type === "message" && entry.message?.role === "user";
const isInput = (entry) => isUser(entry) || entry.type === "custom_message";

/**
 * Pick the entry to navigate to. Pi's navigateTree moves the leaf to the parent of
 * a user or custom message, so the returned entry is the first one the rewind drops.
 *
 * - `keep`: fingerprints of assistant messages the app keeps. An empty list keeps nothing.
 * - `text`: the removed turn's user message, preferred over any earlier input.
 * - `turns`: drop that many user messages from the end of the branch. Used without `keep`,
 *   or when none of the kept messages is on this branch (history the app never saw).
 */
export function findRewindTarget(branch, { keep, text, turns } = {}) {
  if (Array.isArray(keep)) {
    const kept = new Set(keep);
    let anchor = -1;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type === "message" && entry.message?.role === "assistant" && kept.has(messageFingerprint(entry.message))) {
        anchor = index;
        break;
      }
    }
    if (kept.size === 0 || anchor >= 0) return targetAfter(branch.slice(anchor + 1), text);
    if (turns === undefined) throw new Error("The kept part of this conversation is not on the current branch");
  }
  if (!Number.isInteger(turns) || turns < 1) throw new Error("turns must be an integer >= 1");
  const users = branch.filter((entry) => isUser(entry) && userText(entry.message));
  if (turns > users.length) throw new Error("Cannot rewind more turns than this conversation has");
  return users[users.length - turns].id;
}

function targetAfter(rest, text) {
  // Inputs injected ahead of a prompt (usage notes, recalled memory) belong to its
  // turn. So the turn opens at the first input after the previous user message,
  // and a named prompt only skips an earlier prompt the app kept (one stopped
  // before any answer).
  const named = typeof text === "string" && text.trim()
    ? rest.findIndex((entry) => isUser(entry) && userText(entry.message).trim() === text.trim())
    : -1;
  let from = 0;
  if (named >= 0) {
    for (let index = named - 1; index >= 0; index--) {
      if (isUser(rest[index])) { from = index + 1; break; }
    }
  }
  const target = rest.slice(from).find(isInput);
  if (!target) throw new Error("Nothing after the kept part of this conversation to rewind");
  return target.id;
}
