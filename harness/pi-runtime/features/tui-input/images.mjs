/**
 * Image paste gap port — not a Senpi ImageMarkerRegistry.
 *
 * Product (senpi interactive-mode.js): Ctrl+V → attachClipboardImage uses
 * editor.insertImageMarker() + pendingImages; submit → takeSubmissionImages
 * → ImageContent on session.prompt. Drag-drop is a hint only ("drop files"
 * / tip drag-drop-files: "add their paths to your prompt"). No drop handler.
 *
 * Stock Pi 0.85.1: handleClipboardPaste writes $TMPDIR/pi-clipboard-<uuid>.png
 * and insertTextAtCursor(filePath). Main loop is session.prompt(userInput)
 * with no images. Stock pi-tui has insertTextAtCursor, not insertImageMarker.
 * Same "drop files" hint; no onDrop/handleDrop in interactive-mode or pi-tui
 * editor. Public hook: pi.on("input") may return { action: "transform", text, images }.
 *
 * Gap: factory rubato-tui-images inserts in-memory [Image #N] and, on submit,
 * transforms those markers plus leftover pi-clipboard temp paths into ImageContent.
 * setTuiImagesEnabled(false) makes attachClipboardImage return false (interactive-mode
 * patch falls through to the stock temp file) and the input hook does not transform.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const IMAGE_MARKER_PATTERN = /\[Image #([1-9]\d*)\]/g;
const CLIPBOARD_NAME = /^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp|gif)$/i;
const CLIPBOARD_PATH_PATTERN = /(?:^|\s)(\S*pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp|gif))(?=\s|$)/gi;
const IMAGE_EXT_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

let enabled = false;
let nextId = 1;
const pending = new Map();

export function setTuiImagesEnabled(value) {
  enabled = value === true;
  if (!enabled) pending.clear();
}

export function isTuiImagesEnabled() {
  return enabled;
}

export function formatImageMarker(id) {
  return `[Image #${id}]`;
}

export function rememberClipboardImage(image) {
  if (!image?.bytes || !image.mimeType) return undefined;
  const id = nextId++;
  pending.set(id, {
    type: "image",
    data: Buffer.from(image.bytes).toString("base64"),
    mimeType: image.mimeType,
  });
  return id;
}

export function attachClipboardImage(editor, image) {
  if (!enabled) return false;
  if (typeof editor?.insertTextAtCursor !== "function") return false;
  const id = rememberClipboardImage(image);
  if (id === undefined) return false;
  editor.insertTextAtCursor(formatImageMarker(id));
  return true;
}

function mimeForPath(filePath) {
  return IMAGE_EXT_MIME[extname(filePath).toLowerCase()] ?? null;
}

function resolveExisting(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Stock clipboard paste writes into os.tmpdir(); refuse any other directory. */
export function isStockClipboardTempPath(filePath) {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) return false;
  if (!CLIPBOARD_NAME.test(basename(filePath))) return false;
  const candidate = resolveExisting(filePath);
  const root = resolveExisting(tmpdir());
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readImageFile(filePath) {
  const mimeType = mimeForPath(filePath);
  if (!mimeType) return undefined;
  try {
    const info = statSync(filePath);
    if (!info.isFile() || info.size <= 0 || info.size > 50 * 1024 * 1024) return undefined;
    return { type: "image", data: readFileSync(filePath).toString("base64"), mimeType };
  } catch {
    return undefined;
  }
}

function stripToken(text, token) {
  const first = text.indexOf(token);
  if (first < 0) return text;
  const before = text.slice(0, first);
  const after = text.slice(first + token.length);
  return (before + after).replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Convert clipboard temp paths and [Image #N] markers into ImageContent; strip those tokens from text. */
export function transformSubmittedImages(text, existingImages) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const images = [...(existingImages ?? [])];
  let next = text;
  const consumedIds = new Set();
  IMAGE_MARKER_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(IMAGE_MARKER_PATTERN)) {
    const id = Number.parseInt(match[1] ?? "0", 10);
    if (consumedIds.has(id)) continue;
    consumedIds.add(id);
    const image = pending.get(id);
    if (!image) continue;
    images.push(image);
    next = stripToken(next, match[0]);
  }
  for (const id of consumedIds) pending.delete(id);

  CLIPBOARD_PATH_PATTERN.lastIndex = 0;
  const clipboardPaths = [];
  for (const match of next.matchAll(CLIPBOARD_PATH_PATTERN)) {
    clipboardPaths.push(match[1]);
  }
  for (const filePath of clipboardPaths) {
    if (!isStockClipboardTempPath(filePath)) continue;
    const image = readImageFile(filePath);
    if (!image) continue;
    images.push(image);
    next = stripToken(next, filePath);
  }

  if (images.length === (existingImages?.length ?? 0)) return undefined;
  return { text: next, images };
}

export function resetTuiImagesForTests() {
  enabled = false;
  nextId = 1;
  pending.clear();
}

export function pendingImageCount() {
  return pending.size;
}

export function clearPendingImages() {
  pending.clear();
}

export function createImagesExtension() {
  return function rubatoTuiImages(pi) {
    setTuiImagesEnabled(true);
    pi.on("session_start", () => { pending.clear(); });
    pi.on("session_shutdown", () => { pending.clear(); });
    pi.on("input", (event) => {
      if (!enabled) return { action: "continue" };
      const transformed = transformSubmittedImages(event.text, event.images);
      if (!transformed) return { action: "continue" };
      return { action: "transform", text: transformed.text, images: transformed.images };
    });
  };
}
