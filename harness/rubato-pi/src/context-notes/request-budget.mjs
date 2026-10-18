// These are serialized UTF-8 bytes, including JSON escaping and base64, not image
// decoded bytes or tokens. Leave room below the 32 MiB Anthropic/frame limit for
// provider envelopes and a checkpoint tool round. Never fit a request by editing history.
export const REQUEST_BYTE_WARNING = 20 * 1024 * 1024;
export const REQUEST_BYTE_CHECKPOINT = 24 * 1024 * 1024;
export const REQUEST_BYTE_LIMIT = 28 * 1024 * 1024;
export const REQUEST_WIRE_BYTE_LIMIT = 30 * 1024 * 1024;
export const REQUEST_BYTE_REFUSAL = "rubato:request-byte-limit:";

export function requestByteSize(messages, systemPrompt = "", tools = []) {
  return Buffer.byteLength(JSON.stringify({ messages, systemPrompt, tools }));
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
