/**
 * Cursor write exec frames have used several field names for the same bytes.
 * The bridge used to read only `fileText` / `fileBytes`. When the frame carried
 * `contents` or `content` instead, executeTool still ran write with "" and the
 * agent saw a success. Normalize the payload here and refuse a missing body.
 */
export function cursorWriteContent(args) {
  if (!args || typeof args !== "object") return undefined;
  if (typeof args.fileText === "string") return args.fileText;
  if (typeof args.contents === "string") return args.contents;
  if (typeof args.content === "string") return args.content;
  if (args.fileBytes != null) {
    const bytes = args.fileBytes;
    if (typeof bytes === "string") return bytes;
    if (bytes instanceof Uint8Array) return new TextDecoder().decode(bytes);
    if (ArrayBuffer.isView(bytes)) return new TextDecoder().decode(bytes);
  }
  return undefined;
}

export function missingCursorWriteContentMessage(toolName = "write") {
  return `Tool "${toolName}" was not executed: missing file text (fileText/contents/content/fileBytes).`;
}
