import { replaceOnce } from "./core-replace.mjs";

export const SUMMARIZATION_SYSTEM_PROMPT_NEEDLE = "export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;";

const SUMMARIZATION_SYSTEM_PROMPT_REPLACEMENT =
  "export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a summary inside <summary></summary> tags and nothing else.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the summary inside <summary></summary> tags.`;";

export function isCompactionUtilsUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/compaction/utils.js");
}

/** structured-format 시스템 프롬프트를 <summary> 전용 출력 지침으로 바꾼다. */
export function injectCompactionUtils(source) {
  return replaceOnce(
    source,
    SUMMARIZATION_SYSTEM_PROMPT_NEEDLE,
    SUMMARIZATION_SYSTEM_PROMPT_REPLACEMENT,
    "compaction SUMMARIZATION_SYSTEM_PROMPT",
  );
}
