import { replaceOnce } from "./core-replace.mjs";

export const SUMMARIZATION_SYSTEM_PROMPT_NEEDLE = "export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;";

const SUMMARIZATION_SYSTEM_PROMPT_REPLACEMENT =
  "export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a summary inside <summary></summary> tags and nothing else.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the summary inside <summary></summary> tags.`;";

export const SERIALIZE_THINKING_NEEDLE =
  "            if (thinkingParts.length > 0) {\n" +
  "                parts.push(`[Assistant thinking]: ${thinkingParts.join(\"\\n\")}`);\n" +
  "            }\n";

export const SERIALIZE_THINKING_REPLACEMENT =
  "            if (thinkingParts.length > 0) {\n" +
  "                parts.push(`[Assistant thinking]: ${truncateForSummary(thinkingParts.join(\"\\n\"), TOOL_RESULT_MAX_CHARS)}`);\n" +
  "            }\n";

export function isCompactionUtilsUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/compaction/utils.js");
}

/** structured-format 시스템 프롬프트를 <summary> 전용 출력 지침으로 바꾸고, serializeConversation 의 raw thinking 폭주를 방어한다. */
export function injectCompactionUtils(source) {
  let next = replaceOnce(
    source,
    SUMMARIZATION_SYSTEM_PROMPT_NEEDLE,
    SUMMARIZATION_SYSTEM_PROMPT_REPLACEMENT,
    "compaction SUMMARIZATION_SYSTEM_PROMPT",
  );
  if (next.includes(SERIALIZE_THINKING_NEEDLE)) {
    next = replaceOnce(
      next,
      SERIALIZE_THINKING_NEEDLE,
      SERIALIZE_THINKING_REPLACEMENT,
      "compaction SERIALIZE_THINKING cap",
    );
  }
  return next;
}
