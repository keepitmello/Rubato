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

/**
 * Pi keeps every failed attempt in the session, retried or not. An errored
 * assistant message ended its turn only if the user speaks next; another
 * assistant message first means auto-retry replaced it, and its "Error:" line
 * would stack one per attempt on replay.
 */
export function retriedErrorMessages(items) {
  const retried = new Set();
  let pending;
  for (const item of items ?? []) {
    if (item?.role === "user") pending = undefined;
    else if (item?.role === "assistant") {
      if (pending) retried.add(pending);
      pending = item.stopReason === "error" ? item : undefined;
    }
  }
  return retried;
}

/** First-seen order, counted by name. bash·read·bash becomes bash (2)·read. */
export function collapseToolsByName(items) {
  const seen = [];
  const indexByKey = new Map();
  for (const item of items ?? []) {
    const name = item?.name ?? "?";
    const failed = item?.failed === true;
    const key = `${failed ? "1" : "0"}\u0000${name}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined && !item?.diff && !seen[existing].diff) {
      seen[existing].count += 1;
      continue;
    }
    indexByKey.set(key, seen.length);
    seen.push({ name, failed, count: 1, diff: item?.diff });
  }
  return seen;
}

/** One line of tool names for the turn summary, cut to fit with …+N. */
export function compactTools(groups, width) {
  const seen = collapseToolsByName([...groups].flatMap((group) => group.workItems?.() ?? []));
  const labels = seen.map(({ name, failed, count }) => `${failed ? "✗" : "✓"} ${name}${count > 1 ? ` (${count})` : ""}`);
  const full = labels.join(" · ");
  if ([...full].length <= width) return full;
  const shown = [];
  for (let index = 0; index < labels.length; index++) {
    const suffix = ` · …+${labels.length - index - 1}`;
    const candidate = `${[...shown, labels[index]].join(" · ")}${suffix}`;
    if ([...candidate].length > width) break;
    shown.push(labels[index]);
  }
  const remaining = labels.length - shown.length;
  return remaining > 0 ? `${shown.join(" · ")}${shown.length > 0 ? " · " : ""}…+${remaining}` : full;
}
