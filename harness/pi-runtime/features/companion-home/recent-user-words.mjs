// The model gets these words on the first request after a cut, even when that
// request is the engine's continuation and the control tower has not sent wake yet.
// Nothing is sent as a new turn or written back into the transcript.
export const RECENT_USER_WORDS_LIMIT = 30;
export const RECENT_USER_WORDS_CHARS = 12_000;
const TITLE = "## 이 대화에서 내가 깨어나기 전, 사용자가 앱에 직접 쓴 말 (최근 것부터)";

function isNativeCompaction(message) {
  return message?.role === "assistant" && Array.isArray(message.content) &&
    message.content.some((block) => block?.type === "providerNative" && block.subtype === "compaction" &&
      block.raw?.type === "compaction" && typeof block.raw.content === "string" && block.raw.content.length > 0);
}

function isBoundary(entry) {
  return entry.type === "compaction" || (entry.type === "message" && isNativeCompaction(entry.message));
}

function wordsAt(entry) {
  if (entry.type !== "message" || entry.message?.role !== "user") return;
  const { content, rubatoAppText } = entry.message;
  if (rubatoAppText === null) return;
  // Older companion logs use ordinary user entries for app chat input and custom
  // entries for wakes, calls, other conversations and messenger input.
  let text = typeof rubatoAppText === "string" ? rubatoAppText : content?.[0]?.text;
  if (rubatoAppText === undefined) {
    const oldText = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : "";
    // The original of a legacy generated turn or expanded skill is not recoverable here.
    if (/^(?:\[voice\] |<skill name=|<system>$)/u.test(oldText)) return;
    text = oldText.replace(/\n\n<t3_context version="1">\n[\s\S]*\n<\/t3_context>\s*$/u, "");
  }
  const at = Number.isFinite(entry.message.timestamp) ? entry.message.timestamp : Date.parse(entry.timestamp);
  if (typeof text === "string" && text.trim() && Number.isFinite(at)) return { at: new Date(at).toISOString(), text };
}

export function recentUserWords(branch, cut) {
  const lines = [TITLE];
  let remaining = RECENT_USER_WORDS_CHARS - TITLE.length;
  let previousCuts = 0;
  for (let i = cut - 1; i >= 0 && lines.length <= RECENT_USER_WORDS_LIMIT; i--) {
    const entry = branch[i];
    if (isBoundary(entry) && ++previousCuts === 2) break;
    const row = wordsAt(entry);
    if (!row) continue;
    // Encode the text as a value so even embedded newlines, quotes or prompt-like
    // tags can't turn into a separate record or masquerade as the wake itself.
    if (row.text.length >= remaining && lines.length > 1) break;
    let line = row.text.length < remaining ? JSON.stringify(row) : "";
    if (!line || line.length + 1 > remaining) {
      if (lines.length > 1) break;
      // Keep the beginning of a single oversized newest message, with the cut
      // made explicit outside the quotation. Slice at a Unicode code point.
      const head = Array.from(row.text.slice(0, remaining).replace(/[\uD800-\uDBFF]$/u, ""));
      let lo = 0;
      let hi = head.length;
      while (lo < hi) {
        const end = Math.ceil((lo + hi) / 2);
        if (JSON.stringify({ ...row, text: head.slice(0, end).join(""), truncated: true }).length + 1 <= remaining) lo = end;
        else hi = end - 1;
      }
      line = JSON.stringify({ ...row, text: head.slice(0, lo).join(""), truncated: true });
    }
    lines.push(line);
    remaining -= line.length + 1;
  }
  if (lines.length > 1) return lines.join("\n");
}

export function installRecentUserWords(pi) {
  pi.on("context", (event, ctx) => {
    const messages = event.messages;
    const branch = ctx.sessionManager.getBranch();
    const cut = branch.findLastIndex(isBoundary);
    if (cut < 0) return;
    const boundary = branch[cut];
    let after = messages.findLastIndex(isNativeCompaction);
    if (boundary.type === "compaction") {
      // Pi emits compactionSummary for local compaction; history-notes replaces
      // it with its exact window bootstrap. If the local cut kept a provider
      // compaction block, its server still discards messages before that block.
      const carrier = messages.findIndex((message) => (message.role === "compactionSummary" && message.summary === boundary.summary) ||
        (message.role === "user" && message.content?.[0]?.text === boundary.summary));
      after = Math.max(after, carrier);
    }
    if (after < 0) return;
    // Keep an assistant's calls and their results contiguous.
    while (messages[after + 1]?.role === "toolResult") after++;
    const text = recentUserWords(branch, cut);
    if (!text) return;
    const quote = { role: "custom", customType: "rubato-companion.recent-user-words", display: false,
      content: [{ type: "text", text }], timestamp: Date.parse(boundary.timestamp) };
    return { messages: [...messages.slice(0, after + 1), quote, ...messages.slice(after + 1)] };
  });
}
