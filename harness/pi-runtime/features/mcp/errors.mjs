// Senpi-origin MCP retry classification; MIT attribution and license text:
// ./THIRD_PARTY_NOTICES.md
const RETRIABLE_STATUS_CODES = new Set([404, 502, 503]);
const RETRIABLE_NUMERIC_CODES = new Set([-32001]);
const RETRIABLE_TEXT = ["econnrefused", "connection refused", "transport closed"];

export function isRetriableMcpError(error) {
  if (error?.retriable === true) return true;
  if (isMcpSessionExpiredError(error)) return true;
  if (hasRetriableNumericSignal(error, new Set())) return true;
  const text = collectText(error, new Set()).join(" ").toLowerCase();
  if (RETRIABLE_TEXT.some((needle) => text.includes(needle))) return true;
  return /\b(?:404|502|503)\b/.test(text);
}

export function isMcpSessionExpiredError(error) {
  if (hasSessionExpiredNumericSignal(error, new Set())) return true;
  const text = collectText(error, new Set()).join(" ").toLowerCase();
  return (
    /\b404\b/.test(text) ||
    (text.includes("-32000") && text.includes("session")) ||
    text.includes("session expired") ||
    text.includes("session not found") ||
    text.includes("mcp-session-id")
  );
}

function hasRetriableNumericSignal(value, seen) {
  if (!isUnseenObject(value, seen)) return false;
  const code = numberFromUnknown(value.code);
  if (code !== undefined && RETRIABLE_NUMERIC_CODES.has(code)) return true;
  const status = numberFromUnknown(value.status);
  if (status !== undefined && RETRIABLE_STATUS_CODES.has(status)) return true;
  const statusCode = numberFromUnknown(value.statusCode);
  if (statusCode !== undefined && RETRIABLE_STATUS_CODES.has(statusCode)) return true;
  return hasRetriableNumericSignal(value.response, seen) || hasRetriableNumericSignal(value.cause, seen);
}

function hasSessionExpiredNumericSignal(value, seen) {
  if (!isUnseenObject(value, seen)) return false;
  const code = numberFromUnknown(value.code);
  if (code === -32001) return true;
  if (code === -32000 && typeof value.message === "string" && value.message.toLowerCase().includes("session")) return true;
  if (numberFromUnknown(value.status) === 404 || numberFromUnknown(value.statusCode) === 404) return true;
  return hasSessionExpiredNumericSignal(value.response, seen) || hasSessionExpiredNumericSignal(value.cause, seen);
}

function collectText(value, seen) {
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (!isUnseenObject(value, seen)) return [];
  const parts = value instanceof Error ? [value.message, value.name] : [];
  for (const key of ["message", "code", "status", "statusCode"]) {
    if (typeof value[key] === "string" || typeof value[key] === "number") parts.push(String(value[key]));
  }
  parts.push(...collectText(value.response, seen), ...collectText(value.cause, seen));
  return parts;
}

function isUnseenObject(value, seen) {
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  return true;
}

function numberFromUnknown(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
