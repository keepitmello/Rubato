// Provider-independent previews. Never summarize source code or infer success.
export const TOOL_OUTPUT_THRESHOLD_BYTES = 16 * 1024;
export const TOOL_OUTPUT_PREVIEW_BYTES = 8 * 1024;

const SEARCH_TOOLS = new Set(["grep", "find", "ls", "mcp__ast_grep_search", "mcp__ast_grep_scan"]);
const PREVIEW_TOOLS = new Set(["bash", "powershell", "eval", "edit", "write", ...SEARCH_TOOLS]);

export function canPreviewToolOutput(message) {
  return message?.role === "toolResult"
    && message.isError !== true
    && PREVIEW_TOOLS.has(message.toolName)
    && Array.isArray(message.content);
}

function prefix(bytes, size) {
  let end = Math.min(size, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function suffix(bytes, size) {
  let start = Math.max(0, bytes.length - size);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

export function previewToolText(text, toolName, artifactPath) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= TOOL_OUTPUT_THRESHOLD_BYTES) return text;
  const headOnly = SEARCH_TOOLS.has(toolName);
  const head = prefix(bytes, headOnly ? TOOL_OUTPUT_PREVIEW_BYTES : TOOL_OUTPUT_PREVIEW_BYTES / 2);
  const tail = headOnly ? "" : suffix(bytes, TOOL_OUTPUT_PREVIEW_BYTES / 2);
  const omitted = bytes.length - Buffer.byteLength(head) - Buffer.byteLength(tail);
  const notice = `[Tool output preview; ${omitted} bytes omitted. Original tool-result text: ${JSON.stringify(artifactPath)}. Read with offset/limit for omitted content. Upstream truncation, if any, is unchanged.]`;
  return `${notice}\n${head}\n[... ${omitted} bytes omitted ...]${tail ? `\n${tail}` : ""}`;
}
