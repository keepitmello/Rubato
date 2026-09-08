// Senpi-origin tool-call/result repair behavior; MIT attribution and license:
// ./THIRD_PARTY_NOTICES.md

const SYNTHETIC_OUTPUT = "Tool output unavailable (interrupted before result)";

/**
 * Keep provider payloads valid after an interrupted turn. Each sanitizer is
 * immutable: an already-balanced payload is returned by identity, while a
 * repaired payload shares untouched messages/items with the input.
 */
export function toolPairGuardExtension(pi) {
  pi.on("before_provider_request", (event) => {
    const sanitized = sanitizeToolPairs(event.payload);
    return sanitized === event.payload ? undefined : sanitized;
  });
}

export function sanitizeToolPairs(payload) {
  return sanitizeOpenAIChatCompletionsPayload(
    sanitizeOpenAIResponsesPayload(sanitizeAnthropicToolPairs(payload)),
  );
}

export function sanitizeAnthropicToolPairs(payload) {
  if (!hasMessagesArray(payload)) return payload;
  let changed = false;
  const usedToolUseIds = new Set();
  const messages = [];

  for (let index = 0; index < payload.messages.length; index += 1) {
    const message = payload.messages[index];
    if (isMessageWithArrayContent(message, "assistant")) {
      const deduped = dedupeAssistantToolUses(message, usedToolUseIds);
      messages.push(deduped.message);
      changed ||= deduped.changed;
      if (deduped.expectedIds.length === 0) continue;

      const next = payload.messages[index + 1];
      if (isMessageWithArrayContent(next, "user")) {
        const repaired = repairFollowingUserMessage(next, deduped.expectedIds, deduped.remapQueues);
        messages.push(repaired.message);
        changed ||= repaired.changed;
        index += 1;
        continue;
      }
      if (isRecord(next) && next.role === "user" && typeof next.content === "string") {
        messages.push({
          ...next,
          content: [
            ...deduped.expectedIds.map(syntheticAnthropicResult),
            { type: "text", text: next.content },
          ],
        });
        changed = true;
        index += 1;
        continue;
      }
      messages.push({ role: "user", content: deduped.expectedIds.map(syntheticAnthropicResult) });
      changed = true;
      continue;
    }

    if (isMessageWithArrayContent(message, "user")) {
      const content = message.content.filter((block) => block.type !== "tool_result");
      if (content.length !== message.content.length) changed = true;
      if (content.length > 0) messages.push(content.length === message.content.length ? message : { ...message, content });
      continue;
    }
    messages.push(message);
  }
  return changed ? { ...payload, messages } : payload;
}

export function sanitizeOpenAIResponsesPayload(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;
  // Continuations may legitimately send output-only deltas for calls retained
  // by the provider under previous_response_id.
  if (typeof payload.previous_response_id === "string" && payload.previous_response_id.length > 0) return payload;

  const matched = collectResponsesOutputs(payload.input);
  const input = [];
  const emittedFunction = new Set();
  const emittedCustom = new Set();
  let changed = false;

  for (const item of payload.input) {
    const callId = responseCallId(item);
    if (responseType(item) === "function_call_output") {
      if (!callId || !matched.functionOutputIds.has(callId) || emittedFunction.has(callId)) {
        changed = true;
        continue;
      }
      emittedFunction.add(callId);
      input.push(item);
      continue;
    }
    if (responseType(item) === "custom_tool_call_output") {
      if (!callId || !matched.customOutputIds.has(callId) || emittedCustom.has(callId)) {
        changed = true;
        continue;
      }
      emittedCustom.add(callId);
      input.push(item);
      continue;
    }

    input.push(item);
    if (callId && isFunctionCallItem(item) && !matched.functionOutputIds.has(callId)) {
      input.push({ type: "function_call_output", call_id: callId, output: SYNTHETIC_OUTPUT });
      changed = true;
    } else if (callId && responseType(item) === "custom_tool_call" && !matched.customOutputIds.has(callId)) {
      input.push({
        type: "custom_tool_call_output",
        call_id: callId,
        ...(typeof item.name === "string" && item.name.length > 0 ? { name: item.name } : {}),
        output: SYNTHETIC_OUTPUT,
      });
      changed = true;
    }
  }
  return changed ? { ...payload, input } : payload;
}

export function sanitizeOpenAIChatCompletionsPayload(payload) {
  if (!hasMessagesArray(payload)) return payload;
  let changed = false;
  const messages = [];
  const pendingIds = [];
  const pendingSet = new Set();

  const flush = () => {
    if (pendingIds.length === 0) return;
    for (const toolCallId of pendingIds) {
      messages.push({ role: "tool", tool_call_id: toolCallId, content: SYNTHETIC_OUTPUT });
    }
    pendingIds.length = 0;
    pendingSet.clear();
    changed = true;
  };

  for (const message of payload.messages) {
    if (isOpenAIAssistantToolCallMessage(message)) {
      flush();
      messages.push(message);
      for (const call of message.tool_calls) {
        pendingIds.push(call.id);
        pendingSet.add(call.id);
      }
      continue;
    }
    if (isRecord(message) && message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || message.tool_call_id.length === 0 ||
          !pendingSet.has(message.tool_call_id)) {
        changed = true;
        continue;
      }
      messages.push(message);
      pendingSet.delete(message.tool_call_id);
      pendingIds.splice(pendingIds.indexOf(message.tool_call_id), 1);
      continue;
    }
    flush();
    messages.push(message);
  }
  flush();
  return changed ? { ...payload, messages } : payload;
}

function dedupeAssistantToolUses(message, usedIds) {
  const content = [];
  const expectedIds = [];
  const remapQueues = new Map();
  let changed = false;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string" || block.id.length === 0) {
      content.push(block);
      continue;
    }
    let id = block.id;
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${block.id}__dedup${suffix}`)) suffix += 1;
      id = `${block.id}__dedup${suffix}`;
      changed = true;
    }
    usedIds.add(id);
    expectedIds.push(id);
    const queue = remapQueues.get(block.id) ?? [];
    queue.push(id);
    remapQueues.set(block.id, queue);
    content.push(id === block.id ? block : { ...block, id });
  }
  return {
    message: changed ? { ...message, content } : message,
    changed,
    expectedIds,
    remapQueues,
  };
}

function repairFollowingUserMessage(message, expectedIds, remapQueues) {
  const expected = new Set(expectedIds);
  const found = new Set();
  const results = [];
  const ordinary = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_result") {
      ordinary.push(block);
      continue;
    }
    const rawId = block.tool_use_id;
    let id = rawId;
    if (typeof rawId === "string") {
      const queue = remapQueues.get(rawId);
      if (queue?.length) id = queue.shift();
    }
    if (typeof id !== "string" || !expected.has(id) || found.has(id)) continue;
    found.add(id);
    results.push(id === rawId ? block : { ...block, tool_use_id: id });
  }
  for (const id of expectedIds) if (!found.has(id)) results.push(syntheticAnthropicResult(id));
  const content = [...results, ...ordinary];
  const changed = content.length !== message.content.length || content.some((block, index) => block !== message.content[index]);
  return { message: changed ? { ...message, content } : message, changed };
}

function syntheticAnthropicResult(id) {
  return { type: "tool_result", tool_use_id: id, content: SYNTHETIC_OUTPUT, is_error: true };
}

function collectResponsesOutputs(input) {
  const seenFunction = new Set();
  const seenCustom = new Set();
  const functionOutputIds = new Set();
  const customOutputIds = new Set();
  for (const item of input) {
    const callId = responseCallId(item);
    if (!callId) continue;
    if (isFunctionCallItem(item)) seenFunction.add(callId);
    else if (responseType(item) === "custom_tool_call") seenCustom.add(callId);
    else if (responseType(item) === "function_call_output" && seenFunction.has(callId) && !functionOutputIds.has(callId)) {
      functionOutputIds.add(callId);
    } else if (responseType(item) === "custom_tool_call_output" && seenCustom.has(callId) && !customOutputIds.has(callId)) {
      customOutputIds.add(callId);
    }
  }
  return { functionOutputIds, customOutputIds };
}

function isFunctionCallItem(item) {
  return responseType(item) === "function_call" || responseType(item) === "local_shell_call";
}

function responseType(value) {
  return isRecord(value) && typeof value.type === "string" ? value.type : undefined;
}

function responseCallId(value) {
  return isRecord(value) && typeof value.call_id === "string" && value.call_id.length > 0 ? value.call_id : undefined;
}

function isMessageWithArrayContent(value, role) {
  return isRecord(value) && value.role === role && Array.isArray(value.content) &&
    value.content.every((block) => isRecord(block) && typeof block.type === "string");
}

function isOpenAIAssistantToolCallMessage(value) {
  return isRecord(value) && value.role === "assistant" && Array.isArray(value.tool_calls) &&
    value.tool_calls.every((call) => isRecord(call) && typeof call.id === "string" && call.id.length > 0);
}

function hasMessagesArray(value) {
  return isRecord(value) && Array.isArray(value.messages);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
