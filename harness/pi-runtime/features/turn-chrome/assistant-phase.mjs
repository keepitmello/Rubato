// Assistant text phase classifier (progress narration vs final answer).
// Ported from harness/rubato-pi/src/transforms/assistant-phase.mjs. Pure: no
// vendor imports, so it can be read by both the patched dist and unit tests.

export function parseTextSignature(signature) {
  if (typeof signature !== "string") return undefined;
  const trimmed = signature.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || parsed.v !== 1) return undefined;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function normalizeProviderPhase(phase) {
  if (phase === "commentary") return "progress";
  if (phase === "final_answer") return "final";
  return undefined;
}

export function explicitTextPhase(content) {
  const parsed = parseTextSignature(content?.textSignature);
  return normalizeProviderPhase(parsed?.phase);
}

export function messageHasToolCalls(message) {
  return (message?.content ?? []).some((block) => block?.type === "toolCall");
}

export function fallbackTextPhase(message) {
  const stopReason = message?.stopReason;
  if (messageHasToolCalls(message)) return "progress";
  if (stopReason === "toolUse" || stopReason === "pending" || stopReason === "length" || stopReason === "deferred") {
    return "progress";
  }
  if (stopReason === "error" || stopReason === "aborted") return undefined;
  const text = (message?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
  if (stopReason === "stop" && text) return "final";
  return undefined;
}

export function phaseForTextContent(content, message) {
  return explicitTextPhase(content) ?? fallbackTextPhase(message);
}

/**
 * A tool-use turn whose only text is an ellipsis is stream filler, not an
 * answer. Rendering it leaves a stray "..." above every tool group.
 */
export function isToolUseEllipsisFiller(message, content) {
  if (content?.type !== "text") return false;
  const isToolUseTurn = message?.stopReason === "toolUse" || message?.stopReason === "pending";
  if (!isToolUseTurn) return false;
  return /^(?:\.{3,}|…+)$/.test(String(content.text ?? "").trim());
}

/**
 * Does this assistant message put prose on screen? Thinking does not count:
 * it collapses away at the end of the turn, so it must not split a run of tool
 * calls into separate groups.
 */
export function assistantPaintsText(message) {
  for (const content of message?.content ?? []) {
    if (content?.type !== "text") continue;
    if (!String(content.text ?? "").trim()) continue;
    if (isToolUseEllipsisFiller(message, content)) continue;
    return true;
  }
  return false;
}
