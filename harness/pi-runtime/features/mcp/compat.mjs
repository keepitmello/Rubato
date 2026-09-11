// Senpi-origin MCP compatibility behavior; MIT attribution and license text:
// ./THIRD_PARTY_NOTICES.md
import { createHash } from "node:crypto";

export const MCP_TOOL_NAME_MAX_LENGTH = 64;
const MAX_MCP_PAGES = 1_000;
const PERMISSIVE_OBJECT_SCHEMA = Object.freeze({ type: "object", properties: {} });

export function buildMcpToolNames(entries, warn) {
  const items = entries.map((entry, index) => ({
    base: ellipsizeMiddle(buildBaseName(entry), MCP_TOOL_NAME_MAX_LENGTH),
    entry,
    index,
  }));
  const groups = new Map();

  for (const item of items) {
    const key = item.base.replaceAll("-", "_");
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const names = items.map(({ base }) => base);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    warn?.(`MCP tool name collision after normalization for '${group[0].base}'; appended deterministic suffixes.`);
    for (const item of group) {
      const suffix = `_${createHash("sha1")
        .update(`${item.entry.serverName}\0${item.entry.toolName}`)
        .digest("hex")
        .slice(0, 4)}`;
      names[item.index] = `${ellipsizeMiddle(item.base, MCP_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    }
  }
  return names;
}

export async function collectAllTools(client, requestOptions, warn, serverName) {
  const tools = [];
  const seenCursors = new Set();
  let cursor;

  for (let page = 1; page <= MAX_MCP_PAGES; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
    tools.push(...result.tools);
    if (!result.nextCursor) return tools;
    if (seenCursors.has(result.nextCursor)) {
      warn?.(`Stopped MCP pagination for '${serverName}' after duplicate cursor '${result.nextCursor}'.`);
      return tools;
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  warn?.(`Stopped MCP pagination for '${serverName}' after ${MAX_MCP_PAGES} pages.`);
  return tools;
}

export function convertJsonSchema(schema, warn, label) {
  const warnings = [];
  const resolved = resolveRefs(stripTopLevelSchemaKeys(schema), schema, new Set(), warnings);
  const parameters = isRecord(resolved) ? resolved : { ...PERMISSIVE_OBJECT_SCHEMA };
  if (!isRecord(resolved)) warnings.push("MCP schema is not an object; using permissive object schema.");
  for (const warning of warnings) warn?.(`${label}: ${warning}`);
  return warnings.length === 0 ? parameters : { ...PERMISSIVE_OBJECT_SCHEMA };
}

export function mapMcpToolResult(result) {
  const mapped = [];
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    mapped.push(mapContentBlock(block));
  }
  if (result?.structuredContent !== undefined) {
    mapped.push({ type: "text", text: stringifyJson(result.structuredContent) });
  }
  if (mapped.length === 0) mapped.push({ type: "text", text: "(empty result)" });

  if (result?.isError === true) {
    const firstText = mapped.find((block) => block.type === "text");
    return {
      ok: false,
      content: mapped,
      message: firstText?.text.trim() || "MCP tool returned an error result.",
    };
  }
  return { ok: true, content: mapped };
}

export function toAgentContent(content) {
  return content.map((block) => {
    if (block.type === "text" || block.type === "image") return block;
    return { type: "text", text: stringifyJson(block) };
  });
}

export function previewContent(content) {
  const value = content
    .map((block) => (block.type === "text" ? block.text : `[${block.mimeType} image]`))
    .join(" ")
    .trim() || "(empty result)";
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

function buildBaseName({ serverName, toolName }) {
  // Rubato's current Claude-compatible wire identity is mcp__<server>_<tool>.
  // Collapse the extra underscore produced by server names such as _ast_grep.
  return `mcp__${sanitizeNamePart(serverName)}_${sanitizeNamePart(toolName)}`.replace(/^mcp___+/, "mcp__");
}

function sanitizeNamePart(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function ellipsizeMiddle(value, maxLength) {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const remaining = maxLength - 3;
  const prefixLength = Math.ceil(remaining / 2);
  const suffixLength = Math.floor(remaining / 2);
  return `${value.slice(0, prefixLength)}...${value.slice(value.length - suffixLength)}`;
}

function stripTopLevelSchemaKeys(schema) {
  if (!isRecord(schema)) return schema;
  const result = { ...schema };
  delete result.$schema;
  delete result.additionalProperties;
  return result;
}

function resolveRefs(value, root, seenRefs, warnings) {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, root, seenRefs, warnings));
  if (!isRecord(value)) return value;
  if (typeof value.$ref === "string") {
    const resolved = resolveLocalRef(root, value.$ref);
    if (resolved === undefined || seenRefs.has(value.$ref)) {
      warnings.push(`MCP schema contains unresolvable $ref '${value.$ref}'; using permissive object schema.`);
      return { ...PERMISSIVE_OBJECT_SCHEMA };
    }
    const nextSeen = new Set(seenRefs);
    nextSeen.add(value.$ref);
    return resolveRefs(resolved, root, nextSeen, warnings);
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => key !== "type" || child !== null)
      .map(([key, child]) => [key, resolveRefs(child, root, seenRefs, warnings)]),
  );
}

function resolveLocalRef(root, ref) {
  if (!ref.startsWith("#/")) return undefined;
  let current = root;
  for (const part of ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function mapContentBlock(block) {
  if (block?.type === "text") {
    return { type: "text", text: typeof block.text === "string" ? block.text : stringifyJson(block.text) };
  }
  if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
    return { type: "image", data: block.data, mimeType: block.mimeType };
  }
  if (block?.type === "audio" && typeof block.data === "string" && typeof block.mimeType === "string") {
    return { type: "audio", data: block.data, mimeType: block.mimeType };
  }
  if (block?.type === "resource" && "resource" in block) {
    return { type: "resource", resource: block.resource };
  }
  if (block?.type === "resource_link" && typeof block.uri === "string") {
    return {
      type: "resource_link",
      uri: block.uri,
      ...(typeof block.name === "string" ? { name: block.name } : {}),
      ...(typeof block.description === "string" ? { description: block.description } : {}),
      ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
    };
  }
  return { type: "text", text: stringifyJson(block) };
}

function stringifyJson(value) {
  return JSON.stringify(value) ?? String(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
