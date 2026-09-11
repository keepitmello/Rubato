import { fileURLToPath } from "node:url";

const TUI_PACKAGE = "@earendil-works/pi-tui";
const AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const VERSION = "0.85.1";
const BUSY_IMPORT = "import { busyEnterDelivery, handlePendingRecallKey, promoteBusyEnter } from \"../../rubato-features/tui-input/busy-enter.mjs\";";
const IMAGES_IMPORT = "import { attachClipboardImage } from \"../../rubato-features/tui-input/images.mjs\";";
const CLIPBOARD_IMPORT = "import { extensionForImageMimeType, readClipboardImage } from \"../../utils/clipboard-image.js\";\n";

const STDIN_IMPORT_BEFORE = "import { EventEmitter } from \"events\";\n";
const STDIN_IMPORT_AFTER = "import { EventEmitter } from \"events\";\nimport { StringDecoder } from \"node:string_decoder\";\n";
const STDIN_CODEPOINT_BEFORE = "        else {\n            // Not an escape sequence - take a single character\n            sequences.push(remaining[0]);\n            pos++;\n        }\n";
const STDIN_CODEPOINT_AFTER = "        else {\n            const codepoint = remaining.codePointAt(0);\n            const character = String.fromCodePoint(codepoint);\n            sequences.push(character);\n            pos += character.length;\n        }\n";
const STDIN_FIELDS_BEFORE = "    pasteMode = false;\n    pasteBuffer = \"\";\n    pendingKittyPrintableCodepoint;\n";
const STDIN_FIELDS_AFTER = "    pasteMode = false;\n    pasteBuffer = \"\";\n    decoder = new StringDecoder(\"utf8\");\n    pendingKittyPrintableCodepoint;\n";
const STDIN_PROCESS_BEFORE = "        let str;\n        if (Buffer.isBuffer(data)) {\n            if (data.length === 1 && data[0] > 127) {\n                const byte = data[0] - 128;\n                str = `\\x1b${String.fromCharCode(byte)}`;\n            }\n            else {\n                str = data.toString();\n            }\n        }\n        else {\n            str = data;\n        }\n        if (str.length === 0 && this.buffer.length === 0) {\n            this.emitDataSequence(\"\");\n            return;\n        }\n";
const STDIN_PROCESS_AFTER = "        let str;\n        let decodedFromBuffer = false;\n        if (Buffer.isBuffer(data)) {\n            const hasPendingUtf8Bytes = (this.decoder.lastNeed ?? 0) > 0;\n            if (!hasPendingUtf8Bytes && data.length === 1 && data[0] >= 0x80 && data[0] < 0xc2) {\n                const byte = data[0] - 128;\n                str = `\\x1b${String.fromCharCode(byte)}`;\n            }\n            else {\n                str = this.decoder.write(data);\n                decodedFromBuffer = true;\n            }\n        }\n        else {\n            str = data;\n        }\n        if (str.length === 0 && this.buffer.length === 0) {\n            if (!decodedFromBuffer) {\n                this.emitDataSequence(\"\");\n            }\n            return;\n        }\n";
const STDIN_CLEAR_BEFORE = "    clear() {\n        if (this.timeout) {\n            clearTimeout(this.timeout);\n            this.timeout = null;\n        }\n        this.buffer = \"\";\n        this.pasteMode = false;\n        this.pasteBuffer = \"\";\n        this.pendingKittyPrintableCodepoint = undefined;\n    }\n";
const STDIN_CLEAR_AFTER = "    clear() {\n        if (this.timeout) {\n            clearTimeout(this.timeout);\n            this.timeout = null;\n        }\n        this.buffer = \"\";\n        this.pasteMode = false;\n        this.pasteBuffer = \"\";\n        this.pendingKittyPrintableCodepoint = undefined;\n        this.decoder = new StringDecoder(\"utf8\");\n    }\n";
const IM_CLIP_BEFORE = "            if (image) {\n                const tmpDir = os.tmpdir();\n                const ext = extensionForImageMimeType(image.mimeType) ?? \"png\";\n                const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;\n                const filePath = path.join(tmpDir, fileName);\n                fs.writeFileSync(filePath, Buffer.from(image.bytes));\n                this.editor.insertTextAtCursor?.(filePath);\n                this.ui.requestRender();\n                return;\n            }\n";
const IM_CLIP_AFTER = "            if (image) {\n                if (attachClipboardImage(this.editor, image)) {\n                    this.ui.requestRender();\n                    return;\n                }\n                const tmpDir = os.tmpdir();\n                const ext = extensionForImageMimeType(image.mimeType) ?? \"png\";\n                const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;\n                const filePath = path.join(tmpDir, fileName);\n                fs.writeFileSync(filePath, Buffer.from(image.bytes));\n                this.editor.insertTextAtCursor?.(filePath);\n                this.ui.requestRender();\n                return;\n            }\n";
const IM_PASTE_BEFORE = "        this.defaultEditor.onPasteImage = () => {\n            void this.handleClipboardPaste();\n        };\n    }\n";
const IM_PASTE_AFTER = "        this.defaultEditor.onPasteImage = () => {\n            void this.handleClipboardPaste();\n        };\n        const originalHandleInput = this.defaultEditor.handleInput.bind(this.defaultEditor);\n        this.defaultEditor.handleInput = (data) => handlePendingRecallKey(this, data, () => originalHandleInput(data));\n    }\n";
const IM_TRIM_BEFORE = "            text = text.trim();\n            if (!text)\n                return;\n";
const IM_TRIM_AFTER = "            text = text.trim();\n            if (!text) {\n                promoteBusyEnter(this);\n                return;\n            }\n";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error("[tui-input:" + label + "] expected anchor is missing");
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error("[tui-input:" + label + "] expected anchor is ambiguous");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) throw new Error("[tui-input:" + label + "] expected pristine feature seam");
}

function patch(id, packageName, path, preimageSha256, apply) {
  return Object.freeze({ id, packageName, version: VERSION, path, preimageSha256, apply });
}

export function patchStdinBufferUnicode(source) {
  unpatched(source, "new StringDecoder(\"utf8\")", "stdin-buffer");
  let next = replaceOnce(source, STDIN_IMPORT_BEFORE, STDIN_IMPORT_AFTER, "stdin-import");
  next = replaceOnce(next, STDIN_CODEPOINT_BEFORE, STDIN_CODEPOINT_AFTER, "stdin-codepoint");
  next = replaceOnce(next, STDIN_FIELDS_BEFORE, STDIN_FIELDS_AFTER, "stdin-decoder-field");
  next = replaceOnce(next, STDIN_PROCESS_BEFORE, STDIN_PROCESS_AFTER, "stdin-decoder-write");
  next = replaceOnce(next, STDIN_CLEAR_BEFORE, STDIN_CLEAR_AFTER, "stdin-clear");
  return next;
}

export function patchInteractiveTuiInput(source) {
  unpatched(source, BUSY_IMPORT, "interactive-busy-import");
  let next = replaceOnce(source, CLIPBOARD_IMPORT, CLIPBOARD_IMPORT + BUSY_IMPORT + "\n" + IMAGES_IMPORT + "\n", "interactive-imports");
  next = replaceOnce(next, IM_TRIM_BEFORE, IM_TRIM_AFTER, "interactive-empty-enter");
  next = replaceOnce(next, "                    this.queueCompactionMessage(text, \"steer\");", "                    this.queueCompactionMessage(text, busyEnterDelivery());", "interactive-compaction-delivery");
  next = replaceOnce(next, "                await this.session.prompt(text, { streamingBehavior: \"steer\" });", "                await this.session.prompt(text, { streamingBehavior: busyEnterDelivery() });", "interactive-streaming-delivery");
  next = replaceOnce(next, IM_CLIP_BEFORE, IM_CLIP_AFTER, "interactive-clipboard-image");
  next = replaceOnce(next, IM_PASTE_BEFORE, IM_PASTE_AFTER, "interactive-recall-up");
  return next;
}

export const files = Object.freeze([
  // Runtime copies: bootstrap.mjs imports ../tui-input/index.mjs from rubato-features/rubato-components/.
  ...["index.mjs", "busy-enter.mjs", "images.mjs", "cancel.mjs"].map((name) => Object.freeze({
    target: "runtime",
    version: VERSION,
    path: `rubato-features/tui-input/${name}`,
    sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
  })),
  Object.freeze({
    packageName: AGENT_PACKAGE,
    version: VERSION,
    path: "dist/rubato-features/tui-input/busy-enter.mjs",
    sourcePath: fileURLToPath(new URL("./busy-enter.mjs", import.meta.url)),
  }),
  Object.freeze({
    packageName: AGENT_PACKAGE,
    version: VERSION,
    path: "dist/rubato-features/tui-input/images.mjs",
    sourcePath: fileURLToPath(new URL("./images.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  patch("tui-input:unicode", TUI_PACKAGE, "dist/stdin-buffer.js", "37bcd9c0115f205ec05b7ed1ef44b9de96c6746612e263bd71fd32ba9457feb5", patchStdinBufferUnicode),
  patch("tui-input:interactive", AGENT_PACKAGE, "dist/modes/interactive/interactive-mode.js", "802ff14f5a47710e5a46d8141b238c4d5ffca30e8ca26bad18f838eddbf086bf", patchInteractiveTuiInput),
]);

export const feature = Object.freeze({ id: "tui-input", patches, files });
export default feature;
