/**
 * Locked selector/overlay cancel (product = stock 0.85.1, 2026-09-11).
 *
 * In a selector with no chosen value:
 * - Esc and Ctrl-C both fire tui.select.cancel.
 * - onCancel runs; onSelect does not.
 * - The overlay/selector is dismissed and the editor is restored.
 * - No selected value is returned (undefined / cancelled).
 *
 * Not the same as editor Esc (app.interrupt / abort) or editor Ctrl-C
 * (app.clear; twice to exit). Those apply only while the editor is focused.
 *
 * Citations: pi-tui dist/keybindings.js tui.select.cancel defaultKeys
 * ["escape","ctrl+c"]; dist/components/select-list.js handleInput cancel
 * branch; pi-coding-agent SessionSelectorComponent / ExtensionSelectorComponent
 * onCancel. session-picker already asserts Esc on the session list.
 */
export const SELECT_CANCEL_KEYS = Object.freeze(["escape", "ctrl+c"]);
export const SELECT_CANCEL_BINDING = "tui.select.cancel";
export const SELECT_CANCEL_RESULT = undefined;
