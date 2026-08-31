// In-repo assistant text phase classifier.
// Vendor importers are rewritten to this href (turn-work-summary pattern).

export function assistantPhaseHref() {
  return import.meta.url;
}

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

export function assistantMessageId(message, fallback = "assistant") {
  if (typeof message?.id === "string" && message.id) return message.id;
  if (Number.isFinite(message?.timestamp)) return `ts:${message.timestamp}`;
  return fallback;
}

/**
 * Split one assistant message into consecutive same-phase text segments.
 * Does not mash commentary and final_answer into a single phase.
 */
export function segmentAssistantText(message, fallbackId = "assistant") {
  const messageId = assistantMessageId(message, fallbackId);
  const blocks = message?.content ?? [];
  const segments = [];
  let current;
  const flush = () => {
    if (!current) return;
    const text = current.texts.join("");
    if (text.trim()) {
      segments.push({
        id: `${messageId}:text:${current.index}`,
        phase: current.phase,
        text,
        explicit: current.explicit,
      });
    }
    current = undefined;
  };

  for (const content of blocks) {
    if (content?.type !== "text") {
      flush();
      continue;
    }
    const explicit = explicitTextPhase(content);
    const phase = explicit ?? fallbackTextPhase(message);
    if (!phase) {
      flush();
      continue;
    }
    if (!current || current.phase !== phase) {
      flush();
      current = { phase, explicit: Boolean(explicit), texts: [content.text ?? ""], index: segments.length };
      continue;
    }
    current.texts.push(content.text ?? "");
    current.explicit = current.explicit || Boolean(explicit);
  }
  flush();
  return segments;
}

export function classifyAssistantMessage(message, fallbackId = "assistant") {
  return {
    messageId: assistantMessageId(message, fallbackId),
    hasToolCalls: messageHasToolCalls(message),
    stopReason: message?.stopReason,
    segments: segmentAssistantText(message, fallbackId),
    fallbackPhase: fallbackTextPhase(message),
  };
}
