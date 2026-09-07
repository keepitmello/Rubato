const DISPOSITIONS = new Set(["handled", "queued", "started", "rejected"]);

/**
 * Session-local input correlation and queued-message identity.
 *
 * Pi owns delivery. This module only owns the small piece of state that must
 * survive transforms and duplicate text/image payloads: one input id, one
 * terminal disposition, and the exact user-message object that entered a queue.
 */
export class InputLifecycle {
  #nextInputId = 0;
  #openInputs = new Map();
  #messageRecords = new WeakMap();
  #pendingMessages = new WeakSet();

  begin({ sessionId, text, images, source, streamingBehavior }) {
    const inputId = `${sessionId}:${++this.#nextInputId}`;
    this.#openInputs.set(inputId, {
      id: inputId,
      inputId,
      source,
      text,
      imageCount: Array.isArray(images) ? images.length : 0,
      enqueuedAt: Date.now(),
      ...(streamingBehavior === undefined ? {} : { delivery: streamingBehavior }),
    });
    return inputId;
  }

  settle(inputId, disposition) {
    if (inputId === undefined || !this.#openInputs.has(inputId)) return undefined;
    if (!DISPOSITIONS.has(disposition)) {
      throw new Error(`Invalid input disposition: ${String(disposition)}`);
    }
    this.#openInputs.delete(inputId);
    return { type: "input_disposition", inputId, disposition };
  }

  bindMessage(inputId, message, { delivery, text, images, pending = false } = {}) {
    if (inputId === undefined || !message || typeof message !== "object") return undefined;
    const record = this.#openInputs.get(inputId);
    if (!record) return undefined;
    record.delivery = delivery;
    record.text = text;
    record.imageCount = Array.isArray(images) ? images.length : 0;
    this.#messageRecords.set(message, record);
    if (pending) this.#pendingMessages.add(message);
    return record;
  }

  getMessageRecord(message) {
    if (!message || typeof message !== "object") return undefined;
    return this.#messageRecords.get(message);
  }

  takeQueuedMessage(message) {
    if (!message || typeof message !== "object" || !this.#pendingMessages.has(message)) {
      return undefined;
    }
    this.#pendingMessages.delete(message);
    return this.#messageRecords.get(message);
  }

  clearQueuedMessages() {
    // WeakMap records intentionally remain reachable for message_start consumers;
    // replacing the pending set drops only queue ownership and keeps no strong refs.
    this.#pendingMessages = new WeakSet();
  }
}
