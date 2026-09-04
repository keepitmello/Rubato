/**
 * Hidden custom messages become user-role turns in senpi convertToLlm.
 * When they trail a real user message they steal "latest user message", and
 * the model answers the notice instead of the user (session 01a068e3 after
 * the 644k-token compact: the Korean follow-up was on disk, the model only
 * saw <memory_notice> / post-compact restoration).
 *
 * display:false customs are harness speech, not the user. When they sit
 * after the latest user with nothing else in between, map them to assistant
 * and place them immediately before that user so the request still ends on
 * the user's text.
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
      const assistant = {
        ...next,
        role: "assistant",
        content: asBlocks(next.content),
        usage: emptyUsage(),
      };
      const previous = converted[converted.length - 1];
      if (previous?.role === "assistant" && hidden.has(previous)) {
        previous.content = [...asBlocks(previous.content), ...asBlocks(assistant.content)];
        continue;
      }
      hidden.add(assistant);
      converted.push(assistant);
      continue;
    }
    converted.push(next);
  }
  return hoistHiddenAssistantsBeforeLastUser(converted, hidden);
}

function hoistHiddenAssistantsBeforeLastUser(messages, hidden) {
  let lastUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") lastUser = index;
  }
  // No user turn: a remapped notice would be the whole request, i.e. assistant
  // prefill. Send it as user so providers that reject prefill stay valid.
  if (lastUser < 0) return restoreHiddenAsUser(messages, hidden);

  const trailing = [];
  for (let index = lastUser + 1; index < messages.length; index += 1) {
    if (hidden.has(messages[index])) trailing.push(messages[index]);
  }
  if (trailing.length === 0) return messages;

  const mid = messages.slice(lastUser + 1).filter((message) => !hidden.has(message));
  // Hidden after an assistant reply (or other non-user turns), with no later
  // user: the old hoist put `mid` after the user and ended the request on
  // assistant. Fable 5.1 rejects that. Leave the notices as a user-role tail
  // — there is no follow-up for them to steal.
  if (mid.length > 0) {
    return [
      ...messages.slice(0, lastUser + 1),
      ...mid,
      ...restoreHiddenAsUser(trailing, hidden),
    ];
  }

  const merged = trailing.length === 1
    ? trailing[0]
    : {
        ...trailing[0],
        content: trailing.flatMap((message) => asBlocks(message.content)),
      };
  return [...messages.slice(0, lastUser), merged, messages[lastUser]];
}

function restoreHiddenAsUser(messages, hidden) {
  return messages.map((message) => (
    hidden.has(message) && message.role === "assistant"
      ? { ...message, role: "user" }
      : message
  ));
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
