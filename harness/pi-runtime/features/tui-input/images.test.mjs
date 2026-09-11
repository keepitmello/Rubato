/**
 * Gap port tests for TUI image paste. Product vs stock vs remaining gap:
 *
 * - Product (senpi interactive-mode): Ctrl+V attachClipboardImage →
 *   insertImageMarker + pendingImages; submit takeSubmissionImages → ImageContent.
 *   Drag-drop is a hint only ("drop files" / "add their paths to your prompt").
 * - Stock Pi 0.85.1: handleClipboardPaste writes $TMPDIR/pi-clipboard-<uuid>.png
 *   and insertTextAtCursor(filePath). Main loop session.prompt(userInput) has no
 *   images. Same drop hint; no drop handler. Public hook pi.on("input") can
 *   { action: "transform", text, images }.
 * - Gap port: in-memory [Image #N] + input-hook transform of markers and leftover
 *   pi-clipboard temp paths. Not a Senpi ImageMarkerRegistry. Drag-drop stays a
 *   hint — a regular image path is not converted to ImageContent.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

import {
  attachClipboardImage,
  createImagesExtension,
  formatImageMarker,
  isTuiImagesEnabled,
  resetTuiImagesForTests,
  isStockClipboardTempPath,
  pendingImageCount,
  setTuiImagesEnabled,
  transformSubmittedImages,
} from "./images.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const scratch = mkdtempSync(join(tmpdir(), "rubato-tui-images-"));

after(() => {
  resetTuiImagesForTests();
  rmSync(scratch, { recursive: true, force: true });
});

function editorStub() {
  return {
    inserted: [],
    insertTextAtCursor(text) {
      this.inserted.push(text);
    },
  };
}

function loadFactoryHandler() {
  const handlers = {};
  createImagesExtension()({
    on(event, handler) {
      handlers[event] = handler;
    },
  });
  assert.equal(typeof handlers.input, "function");
  return handlers.input;
}

test("disabled factory flag keeps the stock clipboard fallback", () => {
  resetTuiImagesForTests();
  const editor = editorStub();
  assert.equal(isTuiImagesEnabled(), false);
  assert.equal(attachClipboardImage(editor, { bytes: PNG, mimeType: "image/png" }), false);
  assert.deepEqual(editor.inserted, []);
  assert.equal(transformSubmittedImages("설명 " + formatImageMarker(1)), undefined);
});

test("enabled paste inserts [Image #N] and submit attaches ImageContent", () => {
  resetTuiImagesForTests();
  setTuiImagesEnabled(true);
  const editor = editorStub();
  assert.equal(attachClipboardImage(editor, { bytes: PNG, mimeType: "image/png" }), true);
  assert.deepEqual(editor.inserted, [formatImageMarker(1)]);
  const submitted = transformSubmittedImages("설명 " + formatImageMarker(1));
  assert.equal(submitted.text, "설명");
  assert.equal(submitted.images.length, 1);
  assert.equal(submitted.images[0].type, "image");
  assert.equal(submitted.images[0].mimeType, "image/png");
  assert.equal(submitted.images[0].data, PNG.toString("base64"));
});

test("stock pi-clipboard temp paths become ImageContent; other image paths do not", () => {
  resetTuiImagesForTests();
  const clipPath = join(scratch, "pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png");
  const droppedPath = join(scratch, "dropped.png");
  writeFileSync(clipPath, PNG);
  writeFileSync(droppedPath, PNG);

  const fromClip = transformSubmittedImages("첨부 " + clipPath);
  assert.equal(fromClip.text, "첨부");
  assert.equal(fromClip.images.length, 1);
  assert.equal(fromClip.images[0].mimeType, "image/png");
  assert.equal(fromClip.images[0].data, PNG.toString("base64"));

  assert.equal(transformSubmittedImages("첨부 " + droppedPath), undefined);
  assert.equal(transformSubmittedImages(droppedPath), undefined);
});

test("pi-clipboard filenames outside os.tmpdir() are not read into ImageContent", () => {
  resetTuiImagesForTests();
  const tmpRoot = realpathSync(tmpdir());
  const parent = resolve(tmpRoot, "..");
  let outsideDir;
  try {
    if (realpathSync(parent) !== tmpRoot) {
      outsideDir = mkdtempSync(join(parent, "a15-tui-images-outside-"));
    }
  } catch {
    outsideDir = undefined;
  }
  const name = "pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
  if (outsideDir) {
    const outsidePath = join(outsideDir, name);
    writeFileSync(outsidePath, PNG);
    try {
      assert.equal(isStockClipboardTempPath(outsidePath), false);
      assert.equal(transformSubmittedImages("첨부 " + outsidePath), undefined);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  } else {
    assert.equal(isStockClipboardTempPath("/etc/" + name), false);
  }
  const insidePath = join(scratch, name.replace("aaaa", "bbbb"));
  writeFileSync(insidePath, PNG);
  assert.equal(isStockClipboardTempPath(insidePath), true);
});

test("session end and disable drop unsubmitted pending images", () => {
  resetTuiImagesForTests();
  const handlers = {};
  createImagesExtension()({
    on(event, handler) {
      handlers[event] = handler;
    },
  });
  attachClipboardImage(editorStub(), { bytes: PNG, mimeType: "image/png" });
  assert.equal(pendingImageCount(), 1);
  handlers.session_shutdown();
  assert.equal(pendingImageCount(), 0);
  attachClipboardImage(editorStub(), { bytes: PNG, mimeType: "image/png" });
  assert.equal(pendingImageCount(), 1);
  handlers.session_start();
  assert.equal(pendingImageCount(), 0);
  attachClipboardImage(editorStub(), { bytes: PNG, mimeType: "image/png" });
  assert.equal(pendingImageCount(), 1);
  setTuiImagesEnabled(false);
  assert.equal(pendingImageCount(), 0);
});

test("hand-typed marker with no pending payload stays text", () => {
  resetTuiImagesForTests();
  assert.equal(transformSubmittedImages("그냥 " + formatImageMarker(1)), undefined);
});

test("duplicate marker consumes the pending payload once and keeps extra images", () => {
  resetTuiImagesForTests();
  setTuiImagesEnabled(true);
  attachClipboardImage(editorStub(), { bytes: PNG, mimeType: "image/png" });
  const existing = [{ type: "image", data: "already", mimeType: "image/jpeg" }];
  const submitted = transformSubmittedImages(
    formatImageMarker(1) + " " + formatImageMarker(1),
    existing,
  );
  assert.equal(submitted.text, formatImageMarker(1));
  assert.equal(submitted.images.length, 2);
  assert.equal(submitted.images[0].data, "already");
  assert.equal(submitted.images[1].data, PNG.toString("base64"));
});

test("rubato-tui-images input hook attaches ImageContent; disable falls back to stock", async () => {
  resetTuiImagesForTests();
  const handler = loadFactoryHandler();
  assert.equal(isTuiImagesEnabled(), true);

  const editor = editorStub();
  assert.equal(attachClipboardImage(editor, { bytes: PNG, mimeType: "image/png" }), true);
  const transformed = await handler({ text: "봐 " + formatImageMarker(1), images: undefined });
  assert.equal(transformed.action, "transform");
  assert.equal(transformed.text, "봐");
  assert.equal(transformed.images.length, 1);
  assert.equal(transformed.images[0].type, "image");
  assert.equal(transformed.images[0].mimeType, "image/png");

  setTuiImagesEnabled(false);
  const clipPath = join(scratch, "pi-clipboard-ffffffff-1111-2222-3333-444444444444.png");
  writeFileSync(clipPath, PNG);
  assert.equal(attachClipboardImage(editorStub(), { bytes: PNG, mimeType: "image/png" }), false);
  const stock = await handler({ text: "첨부 " + clipPath, images: undefined });
  assert.deepEqual(stock, { action: "continue" });
});
