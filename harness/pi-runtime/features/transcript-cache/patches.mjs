import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const VERSION = "0.85.1";
const CONTAINER_IMPORT = 'import { DEFAULT_TAIL_BUDGET, DEFAULT_WARM_CHUNK_SIZE, ProgressiveTranscriptContainer } from "../../rubato-features/transcript-cache/progressive-transcript-container.mjs";';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error("[transcript-cache:" + label + "] expected anchor is missing");
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error("[transcript-cache:" + label + "] expected anchor is ambiguous");
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) throw new Error("[transcript-cache:" + label + "] expected pristine feature seam");
}

const IMPORT_BEFORE = 'import { CombinedAutocompleteProvider, Container, fuzzyFilter, getCapabilities, hyperlink, Markdown, matchesKey, Spacer, setCapabilityOverrides, setKeybindings, Text, TruncatedText, TuiAltScreen, TuiMainScreen, visibleWidth, } from "@earendil-works/pi-tui";\n';
const IMPORT_AFTER = 'import { CombinedAutocompleteProvider, Container, fuzzyFilter, getCapabilities, hyperlink, Markdown, matchesKey, Spacer, setCapabilityOverrides, setKeybindings, Text, TruncatedText, TuiAltScreen, TuiMainScreen, visibleWidth, } from "@earendil-works/pi-tui";\n' + CONTAINER_IMPORT + '\n';

const CHAT_BEFORE = '        this.chatContainer = new Container();';
const CHAT_AFTER = '        this.chatContainer = new ProgressiveTranscriptContainer({\n            tailBudget: DEFAULT_TAIL_BUDGET,\n            warmChunkSize: DEFAULT_WARM_CHUNK_SIZE,\n            requestRender: () => this.ui.requestRender(),\n        });';

export function patchInteractiveTranscript(source) {
  unpatched(source, CONTAINER_IMPORT, "transcript-import");
  let next = replaceOnce(source, IMPORT_BEFORE, IMPORT_AFTER, "transcript-import");
  return replaceOnce(next, CHAT_BEFORE, CHAT_AFTER, "chat-container");
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/rubato-features/transcript-cache/progressive-transcript-container.mjs",
    sourcePath: fileURLToPath(new URL("./progressive-transcript-container.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  Object.freeze({
    id: "transcript-cache:interactive",
    packageName: PACKAGE_NAME,
    version: VERSION,
    path: "dist/modes/interactive/interactive-mode.js",
    preimageSha256: "802ff14f5a47710e5a46d8141b238c4d5ffca30e8ca26bad18f838eddbf086bf",
    apply: patchInteractiveTranscript,
  }),
]);

export const feature = Object.freeze({ id: "transcript-cache", patches, files });
export default feature;
