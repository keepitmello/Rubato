const MAX_LISTED_TOOLS = 8;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeXmlAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function availableToolGuidance(availableToolNames) {
  if (availableToolNames.length === 0) {
    return "To edit files, call only tools available in this request.";
  }
  const listed = availableToolNames.slice(0, MAX_LISTED_TOOLS).join(", ");
  const omitted = availableToolNames.length - MAX_LISTED_TOOLS;
  const suffix = omitted > 0 ? ` (and ${omitted} more)` : "";
  return `To edit files, call your own tools: ${listed}${suffix}.`;
}

export function demotedToolCallText(name, availableToolNames, firstOccurrence) {
  const escapedName = escapeXmlAttribute(name);
  if (!firstOccurrence) return `<unavailable-tool-call name="${escapedName}"/>`;
  return [
    `<unavailable-tool-call name="${escapedName}">`,
    "Transcript record, not an action available to you. An earlier model in this session",
    `called "${escapedName}"; that tool does not exist for you and its input is omitted.`,
    availableToolGuidance(availableToolNames),
    "</unavailable-tool-call>",
  ].join("\n");
}

export function demotedToolResultText(name, content) {
  const escapedName = escapeXmlAttribute(name);
  const safeContent = content.replace(/<\/unavailable-tool-result/gi, (match) => `&lt;${match.slice(1)}`);
  return `<unavailable-tool-result name="${escapedName}">${safeContent}</unavailable-tool-result>`;
}

function collectToolReferenceNames(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) collectToolReferenceNames(item, names);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === "tool_reference" && typeof value.tool_name === "string") names.add(value.tool_name);
  for (const nested of Object.values(value)) collectToolReferenceNames(nested, names);
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (typeof item.type === "string") parts.push(`[${item.type}]`);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return "Tool output unavailable.";
}

/**
 * Anthropic 400s when history still names a tool that is not in this request's
 * `tools` (and was not discovered via `tool_reference`). apply_patch hiding
 * edit/write is the live case. Demote those calls and matching results to text
 * so pair repair does not have to invent a still-named tool_use.
 */
export function demoteUnavailableToolReferences(params) {
  if (!isRecord(params) || !Array.isArray(params.messages) || params.messages.length === 0) return params;
  const definedNames = new Set();
  if (Array.isArray(params.tools)) {
    for (const tool of params.tools) {
      if (isRecord(tool) && typeof tool.name === "string") definedNames.add(tool.name);
    }
  }
  const discoveredNames = new Set();
  collectToolReferenceNames(params.messages, discoveredNames);
  const demotedCallNames = new Map();
  for (const message of params.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        isRecord(block) &&
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        !definedNames.has(block.name) &&
        !discoveredNames.has(block.name)
      ) {
        demotedCallNames.set(block.id, block.name);
      }
    }
  }
  const danglingReferenceNames = new Set();
  for (const name of discoveredNames) {
    if (!definedNames.has(name)) danglingReferenceNames.add(name);
  }
  if (demotedCallNames.size === 0 && danglingReferenceNames.size === 0) return params;

  let changed = false;
  const availableToolNames = [...definedNames];
  const seenDemotedCallNames = new Set();
  const rewrittenMessages = [];
  for (const message of params.messages) {
    if (!Array.isArray(message.content)) {
      rewrittenMessages.push(message);
      continue;
    }
    let messageChanged = false;
    const content = [];
    for (const block of message.content) {
      if (message.role === "assistant" && isRecord(block) && block.type === "tool_use") {
        const demotedName = demotedCallNames.get(block.id);
        if (demotedName !== undefined) {
          messageChanged = true;
          const firstOccurrence = !seenDemotedCallNames.has(demotedName);
          seenDemotedCallNames.add(demotedName);
          content.push({
            type: "text",
            text: demotedToolCallText(demotedName, availableToolNames, firstOccurrence),
          });
          continue;
        }
      }
      if (isRecord(block) && block.type === "tool_result") {
        const demotedName = demotedCallNames.get(block.tool_use_id);
        if (demotedName !== undefined) {
          messageChanged = true;
          content.push({ type: "text", text: demotedToolResultText(demotedName, toolResultText(block.content)) });
          continue;
        }
        if (danglingReferenceNames.size > 0 && Array.isArray(block.content)) {
          const kept = [];
          const omitted = [];
          for (const item of block.content) {
            if (
              isRecord(item) &&
              item.type === "tool_reference" &&
              typeof item.tool_name === "string" &&
              danglingReferenceNames.has(item.tool_name)
            ) {
              omitted.push(item.tool_name);
              continue;
            }
            kept.push(item);
          }
          if (omitted.length > 0) {
            messageChanged = true;
            const nextContent = kept.length > 0
              ? kept
              : [{ type: "text", text: `Tool reference unavailable: ${[...new Set(omitted)].join(", ")}` }];
            content.push({ ...block, content: nextContent });
            continue;
          }
        }
      }
      content.push(block);
    }
    if (content.length === 0) {
      changed = true;
      continue;
    }
    if (messageChanged) {
      changed = true;
      rewrittenMessages.push({ ...message, content });
      continue;
    }
    rewrittenMessages.push(message);
  }
  return changed ? { ...params, messages: rewrittenMessages } : params;
}
