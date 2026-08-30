// Records vendor request metadata for the direct-real smoke runner.
// Never forwards to the shared FX bridge.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import zlib from "node:zlib";

function logPath() {
  return process.env.RUBATO_DIRECT_WIRE_LOG;
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return String(input);
  if (input && typeof input === "object" && "url" in input) return String(input.url);
  return "";
}

function isSharedBridge(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "8788";
  } catch {
    return /127\.0\.0\.1:8788|localhost:8788/.test(url);
  }
}

function headerMap(headers) {
  const map = {};
  if (!headers) return map;
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    map[String(key).toLowerCase()] = String(value);
  }
  return map;
}

function decodeBody(raw, headers) {
  if (raw == null) return { text: null, json: null };
  if (typeof URLSearchParams !== "undefined" && raw instanceof URLSearchParams) {
    const json = Object.fromEntries(raw.entries());
    return { text: raw.toString(), json };
  }
  let bytes;
  if (typeof raw === "string") bytes = Buffer.from(raw);
  else if (Buffer.isBuffer(raw)) bytes = raw;
  else if (raw instanceof Uint8Array) bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  else if (raw instanceof ArrayBuffer) bytes = Buffer.from(raw);
  else if (typeof raw === "object" && typeof raw.getReader === "function") return { text: null, json: null };
  else return { text: null, json: null };
  const encoding = headers["content-encoding"];
  try {
    if (encoding === "zstd") bytes = zlib.zstdDecompressSync(bytes);
    else if (encoding === "gzip") bytes = zlib.gunzipSync(bytes);
  } catch {
    return { text: null, json: null };
  }
  const text = bytes.toString("utf8");
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function record(entry) {
  const path = logPath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // Observability must not take down the vendor call.
  }
}

function shouldPeekUsage(url) {
  return /127\.0\.0\.1:8990|localhost:8990/.test(url);
}

function usageObjectsFromSse(text) {
  const usages = [];
  if (typeof text !== "string" || text.length === 0) return usages;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.startsWith("data:") ? rawLine.slice(5).trim() : rawLine.trim();
    if (!line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.usage && typeof event.usage === "object") usages.push(event.usage);
    if (event?.message?.usage && typeof event.message.usage === "object") usages.push(event.message.usage);
    if (event?.credit_usage && typeof event.credit_usage === "object") {
      usages.push({ credit_usage: event.credit_usage });
    }
  }
  return usages;
}

async function peekResponse(response, url) {
  const status = response.status;
  if (!shouldPeekUsage(url)) {
    return { status };
  }
  try {
    const text = await response.clone().text();
    return {
      status,
      responseUsages: usageObjectsFromSse(text).slice(-8),
    };
  } catch {
    return { status };
  }
}

export function installDirectWireCapture() {
  if (globalThis.__rubatoDirectWireCaptureInstalled) return;
  globalThis.__rubatoDirectWireCaptureInstalled = true;
  const originalFetch = globalThis.fetch.bind(globalThis);
  record({ at: new Date().toISOString(), boot: true, pid: process.pid });
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (isSharedBridge(url)) {
      throw new Error("direct-real smoke refused shared bridge 127.0.0.1:8788");
    }
    const request = typeof input === "string" || input instanceof URL ? undefined : input;
    const headers = headerMap(request?.headers ?? init?.headers);
    let raw = init?.body;
    if (raw == null && request && typeof request.clone === "function") {
      try {
        raw = await request.clone().text();
      } catch {
        raw = undefined;
      }
    }
    const decoded = decodeBody(raw, headers);
    const response = await originalFetch(input, init);
    const peeked = await peekResponse(response, url);
    record({
      at: new Date().toISOString(),
      url,
      method: request?.method ?? init?.method ?? "GET",
      headers: {
        "user-agent": headers["user-agent"],
        "x-app": headers["x-app"],
        "anthropic-beta": headers["anthropic-beta"],
        "content-type": headers["content-type"],
        authorization: headers.authorization ? "present" : undefined,
        "x-api-key": headers["x-api-key"] ? "present" : undefined,
      },
      body: decoded.json,
      bodyText: decoded.json ? undefined : decoded.text ? decoded.text.slice(0, 800) : undefined,
      status: peeked.status,
      responseUsages: peeked.responseUsages,
    });
    return response;
  };
}

installDirectWireCapture();
