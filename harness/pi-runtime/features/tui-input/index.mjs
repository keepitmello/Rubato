import { createBusyEnterExtension } from "./busy-enter.mjs";
import { createImagesExtension } from "./images.mjs";

export const TUI_INPUT_FACTORY_NAMES = Object.freeze([
  "rubato-tui-unicode",
  "rubato-tui-images",
  "rubato-tui-busy-enter",
]);

export function createUnicodeExtension() {
  return function rubatoTuiUnicode(_pi) {
    // Stdin-buffer unicode decode is a stage patch. This factory exists so the
    // name can be toggled; disabling it does not unpatch stdin-buffer.js.
  };
}

export function createTuiInputFactories() {
  return [
    { name: "rubato-tui-unicode", factory: createUnicodeExtension() },
    { name: "rubato-tui-images", factory: createImagesExtension() },
    { name: "rubato-tui-busy-enter", factory: createBusyEnterExtension() },
  ];
}

export { createBusyEnterExtension, setBusyEnterEnabled, busyEnterDelivery, promoteBusyEnter, recallLatestPending } from "./busy-enter.mjs";
export { createImagesExtension, setTuiImagesEnabled, transformSubmittedImages, attachClipboardImage } from "./images.mjs";
export { SELECT_CANCEL_KEYS, SELECT_CANCEL_BINDING, SELECT_CANCEL_RESULT } from "./cancel.mjs";
export default createTuiInputFactories;
