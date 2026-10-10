// A side chat is a fork the user opens beside a conversation and throws away when it closes
// (the T3 right panel's Side chat). The engine writes it (pi-server forkSessionFile with
// `side`); this module owns what the copy carries and what reads it back.
//
// What the copy carries after the copied history:
// - a `custom` entry naming the conversation it came from. The model never sees it; the
//   session list reads it to keep the side chat out of the sidebar, and the runtime reads it
//   to keep using that conversation's prompt cache;
// - one hidden `custom_message` telling the model it is in a side chat. Pi sends a custom
//   message as a user message, after the copied history, so every byte the parent's requests
//   cached stays the same. It never goes in the system prompt: that would change the first
//   bytes of the request and miss the whole cache.
export const SIDE_CHAT_ENTRY = "rubato.side-chat.v1";
export const SIDE_CHAT_NOTICE = "rubato-side-chat-notice";

export const SIDE_CHAT_NOTICE_TEXT = [
  "<side_chat>",
  "The user opened a side chat from this conversation. Everything above was copied from the main conversation at that moment. The main conversation goes on by itself and will not see this side chat.",
  "From here on, answer what the user asks in this side chat. Work still open above belongs to the main conversation.",
  "</side_chat>",
].join("\n");

/** The conversation a side chat was opened from, or undefined for any other session. */
export function sideChatParent(entries) {
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    if (entry?.type !== "custom" || entry.customType !== SIDE_CHAT_ENTRY) continue;
    const parent = entry.data?.parentSessionId;
    if (typeof parent === "string" && parent) return parent;
  }
  return undefined;
}

/** The two entries that follow the copied history, chained after `parentId`. */
export function sideChatEntries({ parentSessionId, parentId, newId, now = new Date() }) {
  if (typeof parentSessionId !== "string" || !parentSessionId) throw new TypeError("a side chat needs the conversation it came from");
  const timestamp = now.toISOString();
  const marker = { type: "custom", customType: SIDE_CHAT_ENTRY, data: { parentSessionId },
    id: newId(), parentId, timestamp };
  const notice = { type: "custom_message", customType: SIDE_CHAT_NOTICE,
    content: [{ type: "text", text: SIDE_CHAT_NOTICE_TEXT }], display: false,
    id: newId(), parentId: marker.id, timestamp };
  return [marker, notice];
}

// Session id → the session id whose prompt cache it uses. OpenAI-style providers route the
// cache by `prompt_cache_key` and the session header, both the session id; a fork has a new
// one and missed the whole copied prefix (0 of 8,747 tokens, 2026-10-10). The provider stream
// (rubato-pi/src/rubato-stream.mjs) reads this map under the same symbol: the two files are
// staged into different packages and cannot import each other.
export const CACHE_SESSION_KEYS = Symbol.for("rubato.cacheSessionKeys");

function cacheSessionKeys() {
  return (globalThis[CACHE_SESSION_KEYS] ??= new Map());
}

/** Records that `sessionId` uses `cacheSessionId`'s prompt cache; undefined clears it. */
export function setCacheSessionKey(sessionId, cacheSessionId) {
  if (typeof sessionId !== "string" || !sessionId) return;
  if (typeof cacheSessionId === "string" && cacheSessionId && cacheSessionId !== sessionId) cacheSessionKeys().set(sessionId, cacheSessionId);
  else cacheSessionKeys().delete(sessionId);
}

/**
 * On session start, a side chat registers the conversation it came from as its cache key.
 * Returns the cleanup for when the session ends or another one takes its place.
 */
export function trackSideChatCache(ctx) {
  const manager = ctx?.sessionManager;
  const sessionId = manager?.getSessionId?.();
  if (typeof sessionId !== "string" || !sessionId) return () => {};
  const parent = sideChatParent(manager.getEntries?.());
  if (!parent) return () => {};
  setCacheSessionKey(sessionId, parent);
  return () => setCacheSessionKey(sessionId, undefined);
}
