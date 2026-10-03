// Provider-independent previews. Never summarize source code or infer success.
export const TOOL_OUTPUT_THRESHOLD_BYTES = 16 * 1024;
export const TOOL_OUTPUT_PREVIEW_BYTES = 8 * 1024;

const SEARCH_TOOLS = new Set(["grep", "find", "ls", "mcp__ast_grep_search", "mcp__ast_grep_scan"]);
const PREVIEW_TOOLS = new Set(["bash", "powershell", "eval", "edit", "write", ...SEARCH_TOOLS]);

// Shell and eval output keeps its preview when the run failed: pi 0.99 flags a returned
// { isError: true } (a non-zero exit, a failed cell), which 0.86 sent as a plain result, and a
// failing build log is exactly the large output this exists to shorten.
const ERROR_PREVIEW_TOOLS = new Set(["bash", "powershell", "eval"]);

export function canPreviewToolOutput(message) {
  return message?.role === "toolResult"
    && (message.isError !== true || ERROR_PREVIEW_TOOLS.has(message.toolName))
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
  const notice = `[Preview; ${omitted} bytes omitted. Full text: ${JSON.stringify(artifactPath)} (read with offset/limit)]`;
  return `${notice}\n${head}\n[... ${omitted} bytes omitted ...]${tail ? `\n${tail}` : ""}`;
}
