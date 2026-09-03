/**
 * Hidden custom messages become user-role turns in senpi convertToLlm.
 * When they trail a real user message they steal "latest user message", and
 * the model answers the notice instead of the user (session 01a068e3 after
 * the 644k-token compact: the Korean follow-up was on disk, the model only
 * saw <memory_notice> / post-compact restoration).
 *
 * Fold display:false custom conversions into the preceding user turn so the
 * latest user message still starts with the user's text. Visible custom
 * messages and customs with no preceding user stay their own turn.
 *
 * @param {readonly unknown[]} messages
 * @param {(message: any) => any} convertOne
 * @returns {any[]}
 */
export function foldHiddenCustomUserTurns(messages, convertOne) {
  const converted = [];
  for (const message of messages) {
    const next = convertOne(message);
    if (next === undefined) continue;
    const previous = converted[converted.length - 1];
    if (
      isRecord(message) &&
      message.role === "custom" &&
      message.display === false &&
      previous?.role === "user" &&
      next.role === "user"
    ) {
      converted[converted.length - 1] = {
        ...previous,
        content: [...asBlocks(previous.content), ...asBlocks(next.content)],
      };
      continue;
    }
    converted.push(next);
  }
  return converted;
}

function asBlocks(content) {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return Array.isArray(content) ? content : [];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
