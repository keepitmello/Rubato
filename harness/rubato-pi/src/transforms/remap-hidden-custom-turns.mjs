/**
 * Hidden custom messages become user-role turns in senpi convertToLlm.
 * When they trail a real user message they steal "latest user message", and
 * the model answers the notice instead of the user (session 01a068e3 after
 * the 644k-token compact: the Korean follow-up was on disk, the model only
 * saw <memory_notice> / post-compact restoration).
 *
 * display:false customs are harness speech, not the user. When they sit
 * immediately after a real user with nothing else in between, map them to
 * assistant and place them immediately before that user so the request still
 * ends on the user's text. That rewrite is stable: later assistant/tool
 * turns append after the pair.
 *
 * Hidden customs that arrive after assistant/tool content stay in
 * chronological place as user. Pulling every post-user notice to a tail
 * (session 01a070da) rewrites the prefix on every tool loop — Codex WS
 * continuation misses, cacheRead sticks at tools+instructions (14976).
 *
 * If a later user does not exist — notice after an assistant reply, or a
 * notice-only prefix — keep them as user. Hoisting in that shape appends
 * the real assistant after the last user and Fable 5.1 400s it as prefill
 * ("This model does not support assistant message prefill").
 * Visible custom messages keep senpi's user-role mapping.
 *
 * @param {readonly unknown[]} messages
 * @param {(message: any) => any} convertOne
 * @returns {any[]}
 */
export function remapHiddenCustomTurns(messages, convertOne) {
  const hidden = new WeakSet();
  const converted = [];
  for (const message of messages) {
    const next = convertOne(message);
    if (next === undefined) continue;
    if (isHiddenCustom(message)) {
      const asUser = {
        ...next,
        role: "user",
        content: asBlocks(next.content),
        usage: emptyUsage(),
      };
      const previous = converted[converted.length - 1];
      if (previous?.role === "user" && hidden.has(previous)) {
        previous.content = [...asBlocks(previous.content), ...asBlocks(asUser.content)];
        continue;
      }
      hidden.add(asUser);
      converted.push(asUser);
      continue;
    }
    converted.push(next);
  }
  return hoistHiddenImmediatelyAfterUsers(converted, hidden);
}

function hoistHiddenImmediatelyAfterUsers(messages, hidden) {
  const result = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message?.role !== "user" || hidden.has(message)) {
      result.push(message);
      index += 1;
      continue;
    }

    const notices = [];
    let cursor = index + 1;
    while (cursor < messages.length && hidden.has(messages[cursor])) {
      notices.push(messages[cursor]);
      cursor += 1;
    }
    if (notices.length === 0) {
      result.push(message);
      index += 1;
      continue;
    }

    result.push(toHiddenAssistant(notices), message);
    index = cursor;
  }
  return result;
}

function toHiddenAssistant(notices) {
  const first = notices[0];
  return {
    ...first,
    role: "assistant",
    content: notices.flatMap((message) => asBlocks(message.content)),
    usage: emptyUsage(),
  };
}

function isHiddenCustom(message) {
  return isRecord(message) && message.role === "custom" && message.display === false;
}

function asBlocks(content) {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return Array.isArray(content) ? content : [];
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
