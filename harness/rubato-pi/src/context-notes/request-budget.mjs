// These are serialized UTF-8 bytes, including JSON escaping and base64, not image
// decoded bytes or tokens. Leave room below the 32 MiB Anthropic/frame limit for
// provider envelopes and a checkpoint tool round. Never fit a request by editing history.
export const REQUEST_BYTE_WARNING = 20 * 1024 * 1024;
export const REQUEST_BYTE_CHECKPOINT = 24 * 1024 * 1024;
export const REQUEST_BYTE_LIMIT = 28 * 1024 * 1024;
export const REQUEST_WIRE_BYTE_LIMIT = 30 * 1024 * 1024;
export const REQUEST_BYTE_REFUSAL = "rubato:request-byte-limit:";

// Every model call measures its request several times, and serializing a long conversation with
// images for each held the engine's one thread for every conversation. Content parts are shared
// between a stored message and the annotated copies a request is built from, and a complete part
// does not change, so each part is serialized once; only the small message envelopes are redone.
// The sum equals the length of JSON.stringify({ messages, systemPrompt, tools }).
const partBytes = new WeakMap();

function jsonBytes(value) {
  const json = JSON.stringify(value);
  return json === undefined ? 4 : Buffer.byteLength(json); // inside an array it is `null`
}

function joinedBytes(items, size) {
  let bytes = Math.max(0, items.length - 1); // the commas
  for (const item of items) bytes += size(item);
  return bytes;
}

function partSize(part) {
  if (part === null || typeof part !== "object") return jsonBytes(part);
  let bytes = partBytes.get(part);
  if (bytes === undefined) { bytes = jsonBytes(part); partBytes.set(part, bytes); }
  return bytes;
}

function messageSize(message) {
  if (message === null || typeof message !== "object" || !Array.isArray(message.content) ||
      typeof message.toJSON === "function") return jsonBytes(message);
  // The envelope keeps `content` in its place, so the parts go between its brackets.
  return jsonBytes({ ...message, content: [] }) + joinedBytes(message.content, partSize);
}

/** What `messages` add to a request with no messages: requestByteSize(m, …) − requestByteSize([], …). */
export function messageListBytes(messages) {
  return Array.isArray(messages) ? joinedBytes(messages, messageSize) : 0;
}

export function requestByteSize(messages, systemPrompt = "", tools = []) {
  if (!Array.isArray(messages)) return jsonBytes({ messages, systemPrompt, tools });
  return jsonBytes({ messages: [], systemPrompt, tools }) + messageListBytes(messages);
}

// The provider's onPayload seam runs after serialization and before transport.
// This catches provider-specific expansion (e.g. stringified tool arguments) that
// a context estimate cannot prove fits. A refusal never changes the payload.
export function assertRequestWireBytes(payload) {
  const bytes = Buffer.byteLength(typeof payload === "string" ? payload : JSON.stringify(payload));
  return assertRequestWireByteCount(bytes);
}

export function assertRequestWireByteCount(bytes) {
  if (bytes >= REQUEST_WIRE_BYTE_LIMIT) {
    throw new Error(`${REQUEST_BYTE_REFUSAL} ${bytes} serialized bytes. Request not sent; history was not trimmed. Save notes and start a new context.`);
  }
  return bytes;
}
