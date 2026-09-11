import { open, readFile } from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/config.js";

const MAX_HISTORY_ENTRIES = 10_000;
const HEADER_BYTES = 8 * 1024;
const SYSTEM_PREFIXES = ["[SYSTEM DIRECTIVE", "[system:", "[SYSTEM"];

function isReadonlyArray(value) {
  return Array.isArray(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !isReadonlyArray(value);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function resolveSearchRoot(currentSessionDir, defaultSessionsRoot, pathImpl = path) {
  const defaultRoot = defaultSessionsRoot ? pathImpl.resolve(defaultSessionsRoot) : undefined;
  if (!currentSessionDir) return defaultRoot;
  const current = pathImpl.resolve(currentSessionDir);
  if (!defaultRoot || current === defaultRoot) return current;
  const rel = pathImpl.relative(defaultRoot, current);
  if (rel && !rel.startsWith("..") && !pathImpl.isAbsolute(rel)) return defaultRoot;
  return current;
}

export function defaultSessionsRoot() {
  try {
    return getSessionsDir();
  } catch {
    return undefined;
  }
}

function getTextParts(content) {
  const texts = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "text") continue;
    if (typeof part.text === "string") texts.push(part.text);
  }
  return texts;
}

function isSystemInjectedPrompt(text) {
  const trimmedStart = text.trimStart();
  return SYSTEM_PREFIXES.some((prefix) => trimmedStart.startsWith(prefix));
}

function extractUserText(content) {
  if (typeof content === "string") return content;
  if (isReadonlyArray(content)) return getTextParts(content).join("\n");
  return undefined;
}

function parseMessage(line, sessionFile, header) {
  const parsed = parseJsonLine(line);
  if (!isRecord(parsed) || parsed.type !== "message") return undefined;
  const message = parsed.message;
  if (!isRecord(message) || message.role !== "user") return undefined;
  const text = extractUserText(message.content);
  if (text === undefined || !text.trim() || isSystemInjectedPrompt(text)) return undefined;
  const rawTimestamp = parsed.timestamp;
  if (typeof rawTimestamp !== "string") return undefined;
  const timestamp = Date.parse(rawTimestamp);
  if (!Number.isFinite(timestamp)) return undefined;
  return { text, sessionId: header.id, sessionFile, cwd: header.cwd, timestamp };
}

export function dedupeNewest(entries) {
  const newestByText = new Map();
  for (const entry of entries) {
    const existing = newestByText.get(entry.text);
    if (!existing || entry.timestamp > existing.timestamp) newestByText.set(entry.text, entry);
  }
  return [...newestByText.values()].sort((left, right) => right.timestamp - left.timestamp);
}

function parseHeaderLine(line, sessionFile) {
  const parsed = parseJsonLine(line);
  if (!isRecord(parsed) || parsed.type !== "session") {
    return { id: path.basename(sessionFile, ".jsonl"), cwd: "" };
  }
  const id = typeof parsed.id === "string" ? parsed.id : path.basename(sessionFile, ".jsonl");
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
  return { id, cwd };
}

export async function readSessionHeader(sessionFile) {
  const handle = await open(sessionFile, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const line = text.split("\n")[0] ?? "";
    if (!line) return { id: path.basename(sessionFile, ".jsonl"), cwd: "" };
    return parseHeaderLine(line, sessionFile);
  } finally {
    await handle.close();
  }
}

export async function extractUserPrompts(sessionFile) {
  const text = await readFile(sessionFile, "utf8");
  const lines = text.split("\n").filter((line) => line.length > 0);
  const headerLine = lines[0];
  if (!headerLine) return { header: { id: path.basename(sessionFile, ".jsonl"), cwd: "" }, entries: [] };
  const header = parseHeaderLine(headerLine, sessionFile);
  const entries = [];
  for (let index = lines.length - 1; index >= 1; index--) {
    const entry = parseMessage(lines[index], sessionFile, header);
    if (entry) entries.push(entry);
    if (entries.length >= MAX_HISTORY_ENTRIES) break;
  }
  return { header, entries };
}

async function loadCatalogModule() {
  const candidates = [
    new URL("../../session-catalog/catalog.mjs", import.meta.url),
    new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/rubato-features/session-catalog/catalog.mjs", import.meta.url),
  ];
  let lastError;
  for (const url of candidates) {
    try {
      return await import(url.href);
    } catch (error) {
      lastError = error;
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  throw lastError ?? new Error("rubato-history-search requires session-catalog");
}

async function buildSessionHistoryInfo(sessionFile) {
  const extracted = await extractUserPrompts(sessionFile);
  return {
    path: sessionFile,
    id: extracted.header.id,
    cwd: extracted.header.cwd,
    firstMessage: extracted.entries[0]?.text ?? "",
    allMessagesText: extracted.entries.map((entry) => entry.text).join(" "),
    entries: extracted.entries,
  };
}

function flattenEntries(sessions) {
  const entries = [];
  for (const session of sessions ?? []) {
    if (Array.isArray(session.entries)) entries.push(...session.entries);
    if (entries.length >= MAX_HISTORY_ENTRIES) break;
  }
  return entries;
}

export async function* iterateHistoryCatalogPages({ root, includeSubdirectories = false } = {}) {
  if (!root) return;
  const catalog = await loadCatalogModule();
  const limit = catalog.MAX_SESSION_PAGE_SIZE ?? 200;
  let offset = 0;
  const collected = [];
  while (collected.length < MAX_HISTORY_ENTRIES) {
    const result = await catalog.listSessionCatalogPage({
      root,
      includeSubdirectories,
      readHeader: readSessionHeader,
      buildInfo: buildSessionHistoryInfo,
      page: { offset, limit },
    });
    collected.push(...flattenEntries(result.sessions));
    const entries = dedupeNewest(collected).slice(0, MAX_HISTORY_ENTRIES);
    const hasMore = result.hasMore === true && entries.length < MAX_HISTORY_ENTRIES;
    yield { entries, offset, hasMore };
    if (!hasMore || (result.sessions ?? []).length === 0) break;
    offset += limit;
  }
}

export async function indexHistoryFromCatalog({ root, includeSubdirectories = false, page } = {}) {
  if (!root) return [];
  if (page) {
    const catalog = await loadCatalogModule();
    const limit = catalog.MAX_SESSION_PAGE_SIZE ?? 200;
    const result = await catalog.listSessionCatalogPage({
      root,
      includeSubdirectories,
      readHeader: readSessionHeader,
      buildInfo: buildSessionHistoryInfo,
      page: { offset: 0, limit, ...page },
    });
    return dedupeNewest(flattenEntries(result.sessions)).slice(0, MAX_HISTORY_ENTRIES);
  }
  let latest = [];
  for await (const batch of iterateHistoryCatalogPages({ root, includeSubdirectories })) {
    latest = batch.entries;
  }
  return latest;
}

export async function loadHistoryEntries(sessionManager) {
  const scoped = historySearchRoot(sessionManager);
  if (!scoped.searchRoot) return [];
  return indexHistoryFromCatalog({ root: scoped.searchRoot, includeSubdirectories: scoped.includeSubdirectories });
}

export function historySearchRoot(sessionManager) {
  const currentDir = sessionManager?.getSessionDir?.();
  const defaultRoot = defaultSessionsRoot();
  const searchRoot = resolveSearchRoot(currentDir, defaultRoot);
  if (!searchRoot) return { searchRoot: undefined, includeSubdirectories: false };
  const includeSubdirectories = Boolean(defaultRoot) && path.resolve(searchRoot) === path.resolve(defaultRoot);
  return { searchRoot, includeSubdirectories };
}

export { MAX_HISTORY_ENTRIES };
