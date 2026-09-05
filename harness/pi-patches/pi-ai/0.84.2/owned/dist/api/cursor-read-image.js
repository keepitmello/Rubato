/**
 * Native Cursor `readResult` can carry file bytes in `ReadSuccess.output.data`.
 * The host `read` tool already returns image parts; the exec bridge used to
 * flatten them to `[image/jpeg image]` text so Gemini never saw the pixels.
 */
export function cursorReadImageBytes(toolResult) {
  if (!Array.isArray(toolResult?.content)) return undefined;
  for (const item of toolResult.content) {
    if (item?.type === "image" && typeof item.data === "string" && item.data.length > 0) {
      return Uint8Array.from(Buffer.from(item.data, "base64"));
    }
  }
  return undefined;
}
