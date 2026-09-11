// Senpi-origin MCP output spill behavior; MIT attribution and license text:
// ./THIRD_PARTY_NOTICES.md
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2_000;
const PREVIEW_BYTE_BUDGET = 8_192;
let spillCounter = 0;

export class McpOutputArtifacts {
  #files = new Set();

  track(path) {
    this.#files.add(path);
  }

  list() {
    return Object.freeze([...this.#files]);
  }

  async cleanup() {
    const files = [...this.#files];
    this.#files.clear();
    await Promise.all(files.map((file) => rm(file, { force: true })));
  }
}

export async function applyMcpOutputGuard(content, options) {
  const limits = outputGuardLimits(options.outputGuard);
  const payload = contentToPayload(content);
  if (payload.bytes.byteLength <= limits.maxBytes && payload.lineCount <= limits.maxLines) return content;
  const preview = buildPreview(payload, limits);
  try {
    const path = await writePayload(payload, options);
    return [{ type: "text", text: spillMessage(payload, preview, path) }];
  } catch (error) {
    return [{ type: "text", text: fallbackMessage(payload, preview, error) }];
  }
}

export function cleanupMcpOutputArtifacts(artifacts) {
  return artifacts.cleanup();
}

function outputGuardLimits(outputGuard) {
  return {
    maxBytes: positiveInteger(outputGuard?.maxBytes) ?? DEFAULT_MAX_BYTES,
    maxLines: positiveInteger(outputGuard?.maxLines) ?? DEFAULT_MAX_LINES,
  };
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function contentToPayload(content) {
  if (content.length === 1) {
    const binary = binaryPayload(content[0]);
    if (binary !== undefined) return binary;
  }
  const text = content.map(textForBlock).join("\n");
  const bytes = Buffer.from(text, "utf8");
  return {
    bytes,
    extension: "txt",
    lineCount: countLines(text),
    previewSource: text,
    summary: `text output (${bytes.byteLength} bytes, ${countLines(text)} lines)`,
  };
}

function binaryPayload(block) {
  if ((block.type === "image" || block.type === "audio") && block.data.length > 0) {
    const bytes = Buffer.from(block.data, "base64");
    return {
      bytes,
      extension: extensionForMime(block.mimeType),
      lineCount: 1,
      previewSource: `[${block.mimeType} binary output, ${bytes.byteLength} bytes]`,
      summary: `${block.mimeType} binary output (${bytes.byteLength} bytes)`,
    };
  }
  if (block.type !== "resource" || !isRecord(block.resource)) return undefined;
  const mimeType = typeof block.resource.mimeType === "string" ? block.resource.mimeType : "application/octet-stream";
  if (typeof block.resource.blob === "string") {
    const bytes = Buffer.from(block.resource.blob, "base64");
    return {
      bytes,
      extension: extensionForMime(mimeType),
      lineCount: 1,
      previewSource: `[${mimeType} binary resource, ${bytes.byteLength} bytes]`,
      summary: `${mimeType} binary resource (${bytes.byteLength} bytes)`,
    };
  }
  if (typeof block.resource.text === "string") {
    const bytes = Buffer.from(block.resource.text, "utf8");
    return {
      bytes,
      extension: extensionForMime(mimeType),
      lineCount: countLines(block.resource.text),
      previewSource: block.resource.text,
      summary: `${mimeType} resource (${bytes.byteLength} bytes, ${countLines(block.resource.text)} lines)`,
    };
  }
  return undefined;
}

async function writePayload(payload, options) {
  if (typeof options.agentDir !== "string" || options.agentDir === "") {
    throw new Error("agentDir is required to persist oversized MCP output");
  }
  const dir = join(options.agentDir, "tmp", "mcp-out");
  await mkdir(dir, { recursive: true });
  const path = join(
    dir,
    `${safePathPart(options.server)}-${Date.now()}-${process.hrtime.bigint()}-${spillCounter++}.${payload.extension}`,
  );
  await writeFile(path, payload.bytes, { mode: 0o600 });
  await chmod(path, 0o600);
  options.artifacts.track(path);
  return path;
}

function buildPreview(payload, limits) {
  const maxBytes = Math.min(PREVIEW_BYTE_BUDGET, Math.max(1_024, Math.floor(limits.maxBytes / 2)));
  const maxLines = Math.min(80, Math.max(2, Math.floor(limits.maxLines / 2)));
  return trimBytes(headTailLines(payload.previewSource, maxLines), maxBytes);
}

function spillMessage(payload, preview, path) {
  return [
    `MCP tool output exceeded outputGuard; ${payload.summary}.`,
    `Full output saved to: ${path}`,
    "Read the file in chunks instead of loading the entire file at once.",
    "Preview:",
    preview,
  ].join("\n");
}

function fallbackMessage(payload, preview, error) {
  return [
    `Warning: failed to write MCP output spill file: ${errorLabel(error)}`,
    `MCP output truncated inline; ${payload.summary}.`,
    "Preview:",
    preview,
  ].join("\n");
}

function headTailLines(text, maxLines) {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const headCount = Math.max(1, Math.floor(maxLines / 2));
  const tailCount = Math.max(1, maxLines - headCount);
  return [...lines.slice(0, headCount), "[... truncated ...]", ...lines.slice(-tailCount)].join("\n");
}

function trimBytes(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let result = text;
  while (result.length > 0 && Buffer.byteLength(`${result}\n[... truncated ...]`, "utf8") > maxBytes) {
    result = result.slice(0, Math.max(0, result.length - 256));
  }
  return `${result}\n[... truncated ...]`;
}

function textForBlock(block) {
  if (block.type === "text") return block.text;
  if (block.type === "image" || block.type === "audio") {
    return `[${block.mimeType} binary output, ${Buffer.byteLength(block.data, "base64")} bytes]`;
  }
  return JSON.stringify(block);
}

function countLines(text) {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function extensionForMime(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "audio/mpeg") return "mp3";
  if (mimeType === "audio/wav") return "wav";
  if (mimeType === "application/json") return "json";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/")) return "txt";
  return "bin";
}

function safePathPart(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_") || "server";
}

function errorLabel(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
