/**
 * Hidden notices are harness speech, not a new user request. Keep each at its
 * chronological position: hoisting a later notice before an already-sent user,
 * or merging adjacent notices, edits the prefix on continuation.
 *
 * User-role notices also avoid an assistant-prefill request on Anthropic. Their
 * fixed framing tells the model to continue the person's actual request.
 */
export const HIDDEN_NOTICE_PREFIX = "[Harness notice, not a new user request. Apply this information while continuing the user's actual request.]\n";

export function remapHiddenCustomTurns(messages, convertOne) {
  return messages.flatMap((message) => {
    const next = convertOne(message);
    if (next === undefined) return [];
    if (message?.role !== "custom" || message.display !== false) return [next];
    const content = typeof next.content === "string"
      ? [{ type: "text", text: next.content }]
      : next.content ?? [];
    return [{ ...next, role: "user", content: [
      { type: "text", text: HIDDEN_NOTICE_PREFIX }, ...content,
    ] }];
  });
}
