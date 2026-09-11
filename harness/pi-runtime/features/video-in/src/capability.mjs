/** Stock 0.85.1 catalog omits video; Senpi 2026.9.4-3 kimi-coding k3 is the only bundled model with it. */
export const VIDEO_CAPABLE_MODELS = Object.freeze([
  Object.freeze({ provider: "kimi-coding", id: "k3" }),
]);

export function isVideoMimeType(mimeType) {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("video/");
}

/** True when the model can accept a video payload. Owned registry plus any catalog/custom overlay. */
export function modelSupportsVideo(model) {
  if (model?.input?.includes("video") === true) return true;
  if (typeof model?.provider !== "string" || typeof model?.id !== "string") return false;
  return VIDEO_CAPABLE_MODELS.some((entry) => entry.provider === model.provider && entry.id === model.id);
}

export function base64ByteLength(data) {
  if (typeof data !== "string" || data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function videoOmissionPlaceholder(mimeType, data) {
  return `[video omitted: ${mimeType}, ${base64ByteLength(data)} bytes]`;
}

/** Replace video ImageContent with a text placeholder. Does not mutate the input array when nothing changes. */
export function omitUnsupportedVideoMessages(messages, model) {
  if (!Array.isArray(messages) || modelSupportsVideo(model)) return messages;
  let changed = false;
  const next = messages.map((msg) => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    let contentChanged = false;
    const content = [];
    for (const block of msg.content) {
      if (block?.type === "image" && isVideoMimeType(block.mimeType)) {
        content.push({ type: "text", text: videoOmissionPlaceholder(block.mimeType, block.data) });
        contentChanged = true;
        continue;
      }
      content.push(block);
    }
    if (!contentChanged) return msg;
    changed = true;
    return { ...msg, content };
  });
  return changed ? next : messages;
}
