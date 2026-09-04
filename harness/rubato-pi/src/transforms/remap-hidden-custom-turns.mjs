/**
 * Hidden custom messages become user-role turns in senpi convertToLlm.
 * When they trail a real user message they steal "latest user message", and
 * the model answers the notice instead of the user (session 01a068e3 after
 * the 644k-token compact: the Korean follow-up was on disk, the model only
 * saw <memory_notice> / post-compact restoration).
 *
 * display:false customs are harness speech, not the user. Map them to
 * assistant turns and place any that currently sit after the latest user
 * message immediately before that user, so the request still ends on the
 * user's text (no user-turn pollution, no assistant prefill of the notice).
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
  if (lastUser < 0) return messages;

  const trailing = [];
  for (let index = lastUser + 1; index < messages.length; index += 1) {
    if (hidden.has(messages[index])) trailing.push(messages[index]);
  }
  if (trailing.length === 0) return messages;

  const mid = messages.slice(lastUser + 1).filter((message) => !hidden.has(message));
  const merged = trailing.length === 1
    ? trailing[0]
    : {
        ...trailing[0],
        content: trailing.flatMap((message) => asBlocks(message.content)),
      };
  return [...messages.slice(0, lastUser), merged, messages[lastUser], ...mid];
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
