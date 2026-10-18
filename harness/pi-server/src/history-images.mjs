// Presentation-only RPC projection. Never feed this back into SessionManager or a
// provider request. Full history and images remain in the authoritative journal.
const IMAGE_BYTES = 16 * 1024 * 1024;
const TOTAL_BYTES = 28 * 1024 * 1024;
const decodedBytes = (data = '') => Math.floor(data.length * 3 / 4)
  - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

export function trimHistoryImagePixels(messages) {
  const serialized = Buffer.byteLength(JSON.stringify(messages));
  let decoded = 0;
  let encoded = 0;
  let images = 0;
  for (const message of messages) for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type !== 'image') continue;
    decoded += decodedBytes(block.data);
    encoded += block.data?.length ?? 0;
    images++;
  }
  if (!images || (decoded <= IMAGE_BYTES && serialized <= TOTAL_BYTES)) return messages;
  const room = Math.max(0, TOTAL_BYTES - (serialized - encoded) - images * 256);
  const budget = Math.min(IMAGE_BYTES, Math.floor(room * 3 / 4));
  let kept = 0;
  const result = [...messages];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!Array.isArray(message?.content)) continue;
    const content = [...message.content];
    let changed = false;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (block?.type !== 'image') continue;
      const bytes = decodedBytes(block.data);
      if (kept + bytes <= budget) { kept += bytes; continue; }
      changed = true;
      content[j] = { type: 'text', text: `[image pixels omitted from display: ${block.mimeType ?? 'image'}; original retained in session history]` };
    }
    if (changed) result[i] = { ...message, content };
  }
  return result;
}
