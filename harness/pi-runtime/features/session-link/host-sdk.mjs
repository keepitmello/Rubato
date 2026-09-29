import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export { getMarkdownTheme } from "@earendil-works/pi-coding-agent";

// Follow the selected coding-agent package's own pi-tui, as media-tools/src/host-sdk.mjs does; a
// runtime feature file cannot resolve the nested package by name.
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const codingAgentDir = dirname(dirname(codingAgentEntry));
const piTui = await import(pathToFileURL(join(codingAgentDir, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);

export const Box = piTui.Box;
export const Markdown = piTui.Markdown;
export const Spacer = piTui.Spacer;
export const Text = piTui.Text;
