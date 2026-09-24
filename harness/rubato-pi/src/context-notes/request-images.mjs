/**
 * Anthropic refuses a request by BYTE size (`413 request_too_large`), and nothing else in
 * this path measures bytes: the context budget counts tokens, and the notes window cuts on
 * tokens too. A session can therefore sit at a third of its window (measured: 336K of 1M)
 * and still be refused, because its history carries tens of megabytes of inline images that
 * every turn re-sends. Measured on the incident that produced this file: 19 tool-result
 * images, 34MB, and every turn failed with `Request exceeds the maximum size` until the
 * session was hand-repaired.
 *
 * The fix belongs at request preparation, not in the record: the session file, the notes and
 * the token budget all keep the images. Only the request loses the pixels of the oldest ones.
 */

/** Half of Anthropic's 32MB request cap, so the text and tool schemas around the images fit too. */
export const REQUEST_IMAGE_BYTE_LIMIT = 16 * 1024 * 1024;

const BASE64_BYTES_PER_CHAR = 3 / 4;

/** Decoded size of a base64 payload, without decoding it. */
export function base64ByteLength(data) {
  if (typeof data !== "string" || data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor(data.length * BASE64_BYTES_PER_CHAR) - padding;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function omittedBlock(block, bytes, message) {
  const kind = typeof block.mimeType === "string" ? block.mimeType : "image";
  const item = message.__piSessionContextEntryId ?? "unknown";
  return { type: "text", text: `[image omitted from request: ${kind} ${formatBytes(bytes)} — history item ${item}]` };
}

/**
 * Keep the newest images and replace the rest with a text placeholder, so the request fits
 * the byte cap. Newest first because that is the image the turn is actually about; the older
 * ones are history the record still holds.
 *
 * Returns the input array unchanged when it already fits, and never mutates a message.
 */
export function trimRequestImages(messages, limit = REQUEST_IMAGE_BYTE_LIMIT) {
  let total = 0;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === "image") total += base64ByteLength(block.data);
    }
  }
  if (total <= limit) return messages;

  let kept = 0;
  const trimmed = [...messages];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!Array.isArray(message?.content)) continue;
    let replaced = false;
    const content = message.content.map((block) => {
      if (block?.type !== "image") return block;
      const bytes = base64ByteLength(block.data);
      if (kept + bytes <= limit) {
        kept += bytes;
        return block;
      }
      replaced = true;
      return omittedBlock(block, bytes, message);
    });
    if (replaced) trimmed[index] = { ...message, content };
  }
  return trimmed;
}
